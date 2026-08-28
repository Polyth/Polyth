// OC-REAL-051 (R+H): the real child accepts the prompt (prompt_async), then
// dies before Polyth receives the response or any event. Expected: no replay;
// the turn-submit operation reconciles by exact evidence or remains unknown;
// user intent survives exactly once; queue admission stays blocked.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, scenarioSetup, sleep, startPolyth, stopPolyth, waitFor,
  writeDetails, writeManifest, writeVerdict, REAL_BIN, TOOLS,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-051", 15144);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};
const ndjson = (file) => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

// Start clean (no rule yet): session create must pass through.
writeFileSync(join(ctx.dirs.proxy, "rules.json"), JSON.stringify({ rules: [] }));

const polyth = await startPolyth(ctx, {
  label: "polyth",
  bin: join(TOOLS, "shim-proxy.mjs"),
  env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
});
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s051" })).json;
  const model = { providerID: "google", modelID: "gemini-flash-lite-latest" };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s051", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-051-swallow-prompt-response-kill",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
    proxy: { rule: "swallow-kill POST ^/session/[^/]+/prompt_async oneshot" },
  });

  writeFileSync(join(ctx.dirs.proxy, "rules.json"), JSON.stringify({
    rules: [{ id: "swallow-prompt", mode: "swallow-kill", method: "POST", pathRe: "^/session/[^/]+/prompt_async$", oneshot: true }],
  }, null, 2));

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Reply with exactly OC_REAL_051_MARKER and nothing else.",
  }, { timeoutMs: 120000 });
  details.observations.push({ send });
  check("send settles as an error, not fake success", send.status >= 500,
    `status=${send.status} body=${JSON.stringify(send.json).slice(0, 200)}`);

  const captured = JSON.parse(readFileSync(join(ctx.dirs.proxy, "captured-swallow-prompt.json"), "utf8"));
  details.observations.push({ captured: { status: captured.response.status, path: captured.request.path, resBytes: captured.response.bodyBytes } });
  check("upstream accepted exactly one prompt before the kill",
    captured.response.status >= 200 && captured.response.status < 300,
    `status=${captured.response.status} path=${captured.request.path}`);

  const db1 = dumpDb(ctx, "after-fault", session.id);
  const submitOp = db1.runtime_operations.find((op) => op.mutation_kind === "turn-submit");
  const userMessages = db1.events.filter((e) => e.type === "user/message");
  const turnStarted = db1.events.filter((e) => e.type === "turn/started");
  check("turn-submit operation is durably unknown", submitOp?.state === "unknown", JSON.stringify({ state: submitOp?.state, code: submitOp?.code }));
  check("user intent survives exactly once", userMessages.length === 1, `user/message count=${userMessages.length}`);
  check("ambiguous admission is not presented as a started turn", turnStarted.length === 0, `turn/started count=${turnStarted.length}`);

  // A second identical send must not be admitted while the head is unknown.
  const resend = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Reply with exactly OC_REAL_051_MARKER and nothing else.",
  }, { timeoutMs: 30000 });
  details.observations.push({ resend });
  check("second send is blocked (no silent resend)", resend.status === 409 || resend.status >= 500,
    `status=${resend.status} body=${JSON.stringify(resend.json).slice(0, 160)}`);

  // Natural-death recovery: fresh child; touching the session reconciles.
  await sleep(6000);
  await api(ctx, "GET", `/api/sessions/${session.id}/events?afterSeq=0`);
  await sleep(4000);

  const wireEntries = ndjson(join(ctx.dirs.proxy, "wire.ndjson"));
  const promptPosts = wireEntries.filter((e) =>
    (e.event === "proxied" || e.event === "fault-swallowed-response")
    && e.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test((e.path ?? "").replace(/\?.*$/, "")));
  check("no prompt replay was sent upstream", promptPosts.length === 1, `prompt POST count=${promptPosts.length}`);

  const db2 = dumpDb(ctx, "final", session.id);
  const submitOpFinal = db2.runtime_operations.find((op) => op.mutation_kind === "turn-submit");
  const userMessagesFinal = db2.events.filter((e) => e.type === "user/message");
  const snapshot = (await api(ctx, "GET", `/api/sessions/${session.id}`)).json;
  details.observations.push({ submitOpFinal: { state: submitOpFinal?.state, code: submitOpFinal?.code }, snapshotStatus: snapshot.status });
  check("operation stays unknown or settles only by exact evidence (never false not-applied)",
    submitOpFinal?.state === "unknown" || submitOpFinal?.state === "confirmed",
    `state=${submitOpFinal?.state}`);
  check("user intent still exactly once after recovery", userMessagesFinal.length === 1,
    `user/message count=${userMessagesFinal.length}`);
  check("projection is honest (unknown/reconciling, not idle/completed)",
    snapshot.status === "unknown" || snapshot.status === "reconciling",
    `status=${snapshot.status}`);
  check("sqlite integrity ok", db2.integrityCheck?.[0]?.integrity_check === "ok", JSON.stringify(db2.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R+H",
    observed: failed.length === 0
      ? "accepted-then-killed prompt kept one durable unknown operation, one user intent, no replay, blocked resend, honest projection"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "no replay; reconcile or remain unknown; no false not-applied",
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
  for (const file of ["wire.ndjson", "timeline.ndjson", "opencode.log", "captured-swallow-prompt.json"]) {
    const src = join(ctx.dirs.proxy, file);
    if (existsSync(src)) writeFileSync(join(ctx.dirs.logs, `proxy-${file}`), readFileSync(src));
  }
}
