// OC-REAL-061 (R+H): mid-turn double crash — SIGKILL the exact real child,
// then SIGKILL Polyth before its recovery settles; restart Polyth first (the
// owned child respawns lazily = "OpenCode second"). Expected: DB valid;
// executing work becomes unknown; the stale PID record is handled by exact
// identity; no replay; no queue/intent loss; no false terminal.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, killExact, pidFileFor, procIdentity, readPidRecord,
  scenarioSetup, sleep, snapshotOf, startPolyth, stopPolyth, timeline,
  waitFor, writeDetails, writeManifest, writeVerdict, REAL_BIN, TOOLS,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-061", 15154);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};
const ndjson = (file) => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

writeFileSync(join(ctx.dirs.ocConfig, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { bash: "allow" },
}, null, 2));
writeFileSync(join(ctx.dirs.proxy, "rules.json"), JSON.stringify({ rules: [] }));

const sideEffect = join(ctx.dirs.project, "effect-061.txt");
const effectLines = () => existsSync(sideEffect)
  ? readFileSync(sideEffect, "utf8").split("\n").filter(Boolean)
  : [];

const polyth = await startPolyth(ctx, {
  label: "polyth",
  bin: join(TOOLS, "shim-proxy.mjs"),
  env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
});
let polyth2;
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s061" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s061", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-061-double-crash-mid-turn-polyth-restarts-first",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Run exactly this single bash command and nothing else: echo running >> effect-061.txt && sleep 60",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: executing mid-turn.
  await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    if (events.some((e) => e.type === "turn/stopped")) throw new Error("turn ended before double-crash barrier");
    return effectLines().length >= 1 ? true : undefined;
  }, { timeoutMs: 180000, intervalMs: 150, what: "executing mid-turn" });

  const recordBefore = readPidRecord(ctx.dirs.project);
  const state = JSON.parse(readFileSync(join(ctx.dirs.proxy, "state.json"), "utf8"));
  details.observations.push({ recordBefore, proxyState: state });

  // Double crash: exact real child first, then Polyth immediately (before its
  // natural-death recovery can settle). The wrapper exits on child death.
  timeline(ctx, { event: "double-crash", childPid: state.childPid, wrapperPid: state.wrapperPid, polythPid: polyth.pid });
  killExact(ctx, state.childPid, "opencode serve", "SIGKILL");
  await sleep(150);
  process.kill(polyth.pid, "SIGKILL");
  await sleep(1500);
  const stalePidFileExists = existsSync(pidFileFor(ctx.dirs.project));
  details.observations.push({ stalePidFileExists, staleRecord: readPidRecord(ctx.dirs.project) ?? null });

  // Restart Polyth first. OpenCode comes back only when Polyth respawns it.
  polyth2 = await startPolyth(ctx, {
    label: "polyth-2",
    bin: join(TOOLS, "shim-proxy.mjs"),
    env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
  });

  // Snapshot reads are DB-only; the projection keeps the durable pre-crash
  // status until the session's first-wire interaction. Watch briefly, then
  // force the first wire with an abort touch and require honest settling.
  const trace = [];
  let last;
  for (let i = 0; i < 10; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    await sleep(2000);
  }
  let firstWire;
  try {
    firstWire = await api(ctx, "POST", `/api/sessions/${session.id}/abort`, undefined, { timeoutMs: 90000 });
  } catch (error) {
    firstWire = { status: -1, json: { timeoutError: String(error) } };
  }
  details.observations.push({ firstWire });
  console.log("first-wire abort:", firstWire.status, JSON.stringify(firstWire.json).slice(0, 160));
  for (let i = 0; i < 20; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    await sleep(2000);
  }
  details.observations.push({ statusTrace: trace });
  console.log("status trace:", JSON.stringify(trace));

  const finalDb = dumpDb(ctx, "final", session.id);
  check("WAL database is valid after double crash",
    finalDb.integrityCheck?.[0]?.integrity_check === "ok", JSON.stringify(finalDb.integrityCheck));

  // Executing work became unknown/reconciling — never false terminal, never
  // silently idle, never stuck fake-working forever without upstream reason.
  const finalEvents = await eventsOf(ctx, session.id);
  const falseCompleted = finalEvents.filter((e) => e.type === "turn/stopped" && e.data.reason === "completed");
  check("no false terminal", falseCompleted.length === 0, JSON.stringify(falseCompleted.map((e) => e.data)));
  const finalStatus = trace[trace.length - 1]?.status;
  check("executing became honest unknown/reconciling",
    finalStatus === "unknown" || finalStatus === "reconciling", `final status=${finalStatus}`);

  // Queue/intent preservation.
  const userMessages = finalEvents.filter((e) => e.type === "user/message");
  check("user intent survives exactly once (no loss, no duplicate)",
    userMessages.length === 1, `user/message count=${userMessages.length}`);

  // No replay of the executing mutation across the double crash.
  const wireEntries = ndjson(join(ctx.dirs.proxy, "wire.ndjson"));
  const promptPosts = wireEntries.filter((e) =>
    e.event === "proxied" && e.method === "POST" && /prompt_async/.test(e.path ?? ""));
  check("no duplicate mutation (prompt sent exactly once across both lives)",
    promptPosts.length === 1, `prompt POST count=${promptPosts.length}`);
  check("no duplicate tool side effect", effectLines().length === 1, `effect lines=${effectLines().length}`);

  // Exact stale child handling: the stale record referenced a dead PID; the
  // new generation must have a fresh identity-verified record and must not
  // have signaled an unrelated (reused) PID. Evidence: fresh record differs,
  // and its identity resolves.
  const recordAfter = readPidRecord(ctx.dirs.project);
  const stateAfter = existsSync(join(ctx.dirs.proxy, "state.json"))
    ? JSON.parse(readFileSync(join(ctx.dirs.proxy, "state.json"), "utf8"))
    : null;
  details.observations.push({ recordAfter, stateAfter });
  const freshOk = recordAfter === undefined
    || (recordAfter.child?.pid !== recordBefore?.child?.pid
        && procIdentity(recordAfter.child?.pid) !== undefined);
  check("stale PID record handled by exact identity (fresh verified record or clean reap)",
    freshOk, JSON.stringify({ before: recordBefore?.child ?? null, after: recordAfter?.child ?? null }));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R+H",
    observed: failed.length === 0
      ? `double crash mid-turn: DB valid, executing -> ${finalStatus}, one prompt/side effect, stale PID handled by identity`
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "DB valid; executing becomes unknown; exact stale child handling; no replay",
    attribution: failed.length === 0 ? "NONE" : "POLYTH",
    identifiers: { canonicalSessionIds: [session.id] },
    blockers: [],
    evidence: [
      `artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/proxy-wire.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/fault-timeline.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/db-final.json`,
    ],
  });
} finally {
  if (polyth2) await stopPolyth(ctx, polyth2);
  for (const file of ["wire.ndjson", "timeline.ndjson", "opencode.log"]) {
    const src = join(ctx.dirs.proxy, file);
    if (existsSync(src)) writeFileSync(join(ctx.dirs.logs, `proxy-${file}`), readFileSync(src));
  }
}
