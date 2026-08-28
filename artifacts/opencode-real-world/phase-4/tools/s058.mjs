// OC-REAL-058 (R+H): abort request in flight -> upstream accepts the abort,
// then the exact child dies before Polyth sees the response (proxy swallows
// it). Expected: abort stays unknown until evidence; queue remains blocked; no
// abort retry; no false interrupted.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, scenarioSetup, sleep, snapshotOf, startPolyth,
  stopPolyth, waitFor, writeDetails, writeManifest, writeVerdict,
  REAL_BIN, TOOLS,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-058", 15151);
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

const sideEffect = join(ctx.dirs.project, "effect-058.txt");

const polyth = await startPolyth(ctx, {
  label: "polyth",
  bin: join(TOOLS, "shim-proxy.mjs"),
  env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
});
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s058" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s058", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-058-swallow-abort-response-kill",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
    proxy: { rule: "swallow-kill POST ^/session/[^/]+/abort oneshot (armed mid-turn)" },
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Run exactly this single bash command and nothing else: echo working >> effect-058.txt && sleep 60",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: original work is observably running (side effect exists), turn open.
  await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    if (events.some((e) => e.type === "turn/stopped")) throw new Error("turn ended before abort barrier");
    return existsSync(sideEffect) ? true : undefined;
  }, { timeoutMs: 180000, intervalMs: 150, what: "turn observably running" });

  // Arm the fault: the NEXT abort call reaches upstream, upstream commits it,
  // the exact child is SIGKILLed, and the response is swallowed.
  writeFileSync(join(ctx.dirs.proxy, "rules.json"), JSON.stringify({
    rules: [{ id: "swallow-abort", mode: "swallow-kill", method: "POST", pathRe: "^/session/[^/]+/abort$", oneshot: true }],
  }, null, 2));

  const abort = await api(ctx, "POST", `/api/sessions/${session.id}/abort`, undefined, { timeoutMs: 60000 });
  details.observations.push({ abort });
  // Polyth abort semantics: 200 = "abort request durably recorded", not
  // "abort applied". Honesty is carried by the projection: an unknown outcome
  // must flip the session to unknown immediately (sessions.ts abort()).
  const snapAfterAbort = await snapshotOf(ctx, session.id);
  details.observations.push({ snapAfterAbort: { status: snapAfterAbort.status } });
  check("ambiguous abort is surfaced honestly (projection unknown immediately, no fake applied state)",
    snapAfterAbort.status === "unknown" || snapAfterAbort.status === "reconciling",
    `abort http=${abort.status} projection=${snapAfterAbort.status}`);

  const captured = JSON.parse(readFileSync(join(ctx.dirs.proxy, "captured-swallow-abort.json"), "utf8"));
  details.observations.push({ captured: { status: captured.response.status, path: captured.request.path } });
  check("upstream accepted exactly one abort before the kill",
    captured.response.status >= 200 && captured.response.status < 300,
    `status=${captured.response.status} path=${captured.request.path}`);

  const db1 = dumpDb(ctx, "after-fault", session.id);
  const abortOp = db1.runtime_operations.find((op) => op.mutation_kind === "turn-abort");
  details.observations.push({ abortOp: abortOp ? { state: abortOp.state, code: abortOp.code } : null });
  check("abort operation is durably unknown (or absent-but-honest)",
    abortOp === undefined || abortOp.state === "unknown",
    JSON.stringify(abortOp ? { state: abortOp.state } : "no runtime_operation row"));

  // Queue must remain blocked while the abort outcome is unknown.
  const queued = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "This must not dispatch into ambiguous work.",
  }, { timeoutMs: 30000 });
  details.observations.push({ queuedSend: { status: queued.status, body: queued.json } });
  const queueRows = dumpDb(ctx, "queue-check", session.id).session_queue;
  const dispatchedNow = ndjson(join(ctx.dirs.proxy, "wire.ndjson")).filter((e) =>
    e.event === "proxied" && e.method === "POST" && /prompt_async/.test(e.path ?? "")).length;
  check("no queue dispatch into ambiguous work",
    dispatchedNow === 1,
    `prompt_async posts=${dispatchedNow} queueRows=${queueRows.length} sendStatus=${queued.status}`);

  // Recovery + steady state.
  const trace = [];
  let last;
  for (let i = 0; i < 20; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    await sleep(2000);
  }
  details.observations.push({ statusTrace: trace });
  console.log("status trace:", JSON.stringify(trace));

  const wireEntries = ndjson(join(ctx.dirs.proxy, "wire.ndjson"));
  const abortPosts = wireEntries.filter((e) =>
    (e.event === "proxied" || e.event === "fault-swallowed-response")
    && e.method === "POST" && /^\/session\/[^/]+\/abort$/.test((e.path ?? "").replace(/\?.*$/, "")));
  check("no abort retry was sent upstream", abortPosts.length === 1, `abort POST count=${abortPosts.length}`);

  const finalEvents = await eventsOf(ctx, session.id);
  const finalDb = dumpDb(ctx, "final", session.id);
  const falseInterrupted = finalEvents.filter((e) =>
    e.type === "turn/stopped" && (e.data.reason === "aborted" || e.data.reason === "interrupted"));
  check("no false interrupted without upstream evidence", falseInterrupted.length === 0,
    JSON.stringify(falseInterrupted.map((e) => e.data)));

  const finalStatus = trace[trace.length - 1]?.status;
  check("projection settles honestly (unknown/reconciling)",
    finalStatus === "unknown" || finalStatus === "reconciling", `final status=${finalStatus}`);
  check("sqlite integrity ok", finalDb.integrityCheck?.[0]?.integrity_check === "ok",
    JSON.stringify(finalDb.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R+H",
    observed: failed.length === 0
      ? "swallowed-abort kill left the abort unknown, no retry, queue blocked from ambiguous work, no false interrupted"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "abort unknown until evidence; queue blocked; no retry/false interrupted",
    attribution: failed.length === 0 ? "NONE" : "POLYTH",
    identifiers: { canonicalSessionIds: [session.id] },
    blockers: [],
    evidence: [
      `artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/proxy-wire.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/db-final.json`,
    ],
  });
} finally {
  await stopPolyth(ctx, polyth);
  for (const file of ["wire.ndjson", "timeline.ndjson", "opencode.log", "captured-swallow-abort.json"]) {
    const src = join(ctx.dirs.proxy, file);
    if (existsSync(src)) writeFileSync(join(ctx.dirs.logs, `proxy-${file}`), readFileSync(src));
  }
}
