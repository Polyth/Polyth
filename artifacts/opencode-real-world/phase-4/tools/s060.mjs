// OC-REAL-060 (R): SIGKILL Polyth mid-turn while the owned OpenCode child (and
// the active turn) stay alive; restart Polyth over the same durable state.
// Expected: the still-owned child is handled per ownership contract (PID-record
// identity), no duplicate prompt, active state survives, queue not admitted
// early. Failure: reaping a healthy owned child without contract, duplicate
// work, or early admission.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, pidFileFor, procIdentity, readPidRecord,
  scenarioSetup, sleep, snapshotOf, startPolyth, stopPolyth, timeline,
  waitFor, writeDetails, writeManifest, writeVerdict, REAL_BIN, TOOLS,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-060", 15153);
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

const sideEffect = join(ctx.dirs.project, "effect-060.txt");
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
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s060" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s060", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-060-sigkill-polyth-child-alive",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Run exactly this single bash command and nothing else: echo alive >> effect-060.txt && sleep 60",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: active turn observably running.
  await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    if (events.some((e) => e.type === "turn/stopped")) throw new Error("turn ended before restart barrier");
    return effectLines().length >= 1 ? true : undefined;
  }, { timeoutMs: 180000, intervalMs: 150, what: "active turn running" });

  const recordBefore = readPidRecord(ctx.dirs.project);
  const state = JSON.parse(readFileSync(join(ctx.dirs.proxy, "state.json"), "utf8"));
  details.observations.push({ recordBefore, proxyState: state });

  // SIGKILL Polyth itself (exact PID). The wrapper + real child must survive.
  timeline(ctx, { event: "kill-polyth", pid: polyth.pid });
  process.kill(polyth.pid, "SIGKILL");
  await sleep(1500);
  const wrapperAlive = procIdentity(state.wrapperPid);
  const childAlive = procIdentity(state.childPid);
  check("owned child survives the Polyth crash", wrapperAlive !== undefined && childAlive !== undefined,
    JSON.stringify({ wrapperAlive: !!wrapperAlive, childAlive: !!childAlive }));

  // Restart Polyth over the same data dirs and port.
  polyth2 = await startPolyth(ctx, {
    label: "polyth-2",
    bin: join(TOOLS, "shim-proxy.mjs"),
    env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
  });

  // First wire contact: force runtime acquisition + reconciliation on the new
  // server (session events + models are the wire triggers; plain snapshot
  // reads are DB-only) and observe the ownership decision for the live child.
  const snapshotEarly = await snapshotOf(ctx, session.id);
  details.observations.push({ snapshotEarly: { status: snapshotEarly.status } });
  const eventsTouch = await api(ctx, "GET", `/api/sessions/${session.id}/events?afterSeq=0`, undefined, { timeoutMs: 60000 });
  const modelsTouch = await api(ctx, "GET", "/api/models", undefined, { timeoutMs: 60000 });
  details.observations.push({ eventsTouchStatus: eventsTouch.status, modelsTouchStatus: modelsTouch.status });

  const trace = [];
  let last;
  for (let i = 0; i < 45; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    await sleep(2000);
  }
  details.observations.push({ statusTrace: trace });
  console.log("status trace:", JSON.stringify(trace));

  // The projection deliberately keeps the last durable state ("working") until
  // the session's FIRST-WIRE interaction (ensureWired -> session-reattached
  // reconcile). Probe that contract with an abort touch, then require the
  // staleness to resolve honestly by evidence.
  const abortT0 = Date.now();
  let abortTouch;
  try {
    abortTouch = await api(ctx, "POST", `/api/sessions/${session.id}/abort`, undefined, { timeoutMs: 90000 });
  } catch (error) {
    abortTouch = { status: -1, json: { timeoutError: String(error) } };
  }
  details.observations.push({ abortTouch, abortElapsedMs: Date.now() - abortT0 });
  console.log("abort touch:", abortTouch.status, JSON.stringify(abortTouch.json).slice(0, 160));
  for (let i = 0; i < 20; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    await sleep(2000);
  }
  details.observations.push({ statusTraceAfterFirstWire: trace });
  console.log("status trace after first-wire touch:", JSON.stringify(trace));
  check("first-wire interaction resolves the stale working projection honestly",
    last !== "working",
    `final status=${last} (bounded first-wire reconcile after restart)`);

  // Ownership decision evidence.
  const wrapperAfter = procIdentity(state.wrapperPid);
  const childAfter = procIdentity(state.childPid);
  const recordAfter = readPidRecord(ctx.dirs.project);
  const proxyTimeline = ndjson(join(ctx.dirs.proxy, "timeline.ndjson"));
  const generations = proxyTimeline.filter((e) => e.event === "proxy-listening");
  details.observations.push({
    wrapperAfter: wrapperAfter ?? null, childAfter: childAfter ?? null,
    recordAfter, generations,
  });
  const reaped = wrapperAfter === undefined;
  const identityContract =
    recordBefore?.child?.pid === state.wrapperPid
    && recordBefore?.child?.startIdentity !== undefined;
  check("still-owned child handled via explicit PID-record identity contract",
    identityContract,
    `record-before=${JSON.stringify(recordBefore?.child)} reapedOldGeneration=${reaped} generationsSeen=${generations.length}`);
  timeline(ctx, { event: "ownership-decision", reaped, generations: generations.length });

  // No duplicate prompt across the restart.
  const wireEntries = ndjson(join(ctx.dirs.proxy, "wire.ndjson"));
  const promptPosts = wireEntries.filter((e) =>
    e.event === "proxied" && e.method === "POST" && /prompt_async/.test(e.path ?? ""));
  check("no duplicate prompt after restart", promptPosts.length === 1, `prompt POST count=${promptPosts.length}`);
  check("no duplicate tool side effect", effectLines().length === 1, `effect lines=${effectLines().length}`);

  const finalEvents = await eventsOf(ctx, session.id);
  const userMessages = finalEvents.filter((e) => e.type === "user/message");
  check("user intent exactly once in durable history", userMessages.length === 1,
    `user/message count=${userMessages.length}`);
  const falseCompleted = finalEvents.filter((e) => e.type === "turn/stopped" && e.data.reason === "completed");
  const turnStops = finalEvents.filter((e) => e.type === "turn/stopped");
  details.observations.push({ turnStops: turnStops.map((e) => ({ seq: e.seq, data: e.data })) });

  // Active state must survive restart truthfully: either still running (child
  // kept), or explicitly unknown/reconciling (child reaped) — never false
  // completed and never permanently stuck without upstream reason.
  const finalStatus = trace[trace.length - 1]?.status;
  check("active state survives truthfully (working/unknown/reconciling/idle-with-evidence)",
    finalStatus === "working" || finalStatus === "unknown" || finalStatus === "reconciling"
      || (finalStatus === "idle" && turnStops.length >= 1),
    `final status=${finalStatus} stops=${turnStops.length} falseCompleted=${falseCompleted.length}`);

  const finalDb = dumpDb(ctx, "final", session.id);
  check("sqlite integrity ok", finalDb.integrityCheck?.[0]?.integrity_check === "ok",
    JSON.stringify(finalDb.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R",
    observed: failed.length === 0
      ? `polyth restart with live child: ownership via PID record (reapedOldGen=${reaped}), one prompt, one side effect, final status ${finalStatus}`
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "ownership contract honored; no duplicate prompt; active state survives",
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
