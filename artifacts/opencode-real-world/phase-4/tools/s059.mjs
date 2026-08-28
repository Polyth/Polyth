// OC-REAL-059 (R+H): the turn completes upstream (terminal committed to
// storage) but the terminal SSE frame never reaches Polyth (proxy cuts the
// /event stream at session.idle and SIGKILLs the exact child). Expected:
// recovery delivers the output and ONE ordered terminal, or remains unknown —
// never a duplicate answer or a guessed idle without proof.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, scenarioSetup, sleep, snapshotOf, startPolyth,
  stopPolyth, waitFor, writeDetails, writeManifest, writeVerdict,
  REAL_BIN, TOOLS,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-059", 15152);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};
const ndjson = (file) => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];

// Cut the SSE stream the moment the terminal marker appears, then kill the
// exact child: the upstream terminal is durable in storage but its frame never
// reaches Polyth.
writeFileSync(join(ctx.dirs.proxy, "rules.json"), JSON.stringify({
  rules: [{ id: "cut-terminal", mode: "sse-cut", pathRe: "^/event", markerRe: "session\\.idle", killAfter: true, oneshot: true }],
}, null, 2));

const polyth = await startPolyth(ctx, {
  label: "polyth",
  bin: join(TOOLS, "shim-proxy.mjs"),
  env: { OC_PROXY_DIR: ctx.dirs.proxy, OC_REAL_BIN: REAL_BIN },
});
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s059" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s059", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-059-sse-cut-terminal-kill",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
    proxy: { rule: "sse-cut ^/event marker=session.idle killAfter oneshot" },
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Reply with exactly the text OC_REAL_059_DONE and nothing else.",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Wait for the cut+kill to fire.
  await waitFor(() => existsSync(join(ctx.dirs.proxy, "cut-cut-terminal")) ? true : undefined,
    { timeoutMs: 180000, intervalMs: 200, what: "terminal SSE cut" });
  details.observations.push({ cutAt: readFileSync(join(ctx.dirs.proxy, "cut-cut-terminal"), "utf8") });

  // Steady state: recovery respawns a clean child (rule consumed) over the
  // SAME storage; reconciliation must recover the terminal exactly once.
  const trace = [];
  let last;
  for (let i = 0; i < 20; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    await sleep(2000);
  }
  details.observations.push({ statusTrace: trace });
  console.log("status trace:", JSON.stringify(trace));

  // Replacement reconcile: a runtime-touching request acquires the fresh
  // generation; the session must then settle by evidence (no new work sent).
  const models = await api(ctx, "GET", "/api/models", undefined, { timeoutMs: 60000 });
  details.observations.push({ recoveryModelsStatus: models.status });
  await api(ctx, "GET", `/api/sessions/${session.id}/events?afterSeq=0`);
  for (let i = 0; i < 20; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    if (snap.status === "idle") break;
    await sleep(2000);
  }
  details.observations.push({ statusTraceAfterTouch: trace });
  console.log("status trace after touch:", JSON.stringify(trace));

  const finalEvents = await eventsOf(ctx, session.id);
  const finalDb = dumpDb(ctx, "final", session.id);

  // Output recovered exactly once.
  const answers = finalEvents.filter((e) =>
    e.type === "assistant/message" && typeof e.data.text === "string" && e.data.text.includes("OC_REAL_059_DONE"));
  const chunkText = finalEvents.filter((e) => e.type === "assistant/chunk").map((e) => e.data.text).join("");
  const markerCountInChunks = chunkText.split("OC_REAL_059_DONE").length - 1;
  check("final answer exists exactly once", answers.length === 1,
    `assistant/message with marker=${answers.length}`);
  check("no duplicated answer bytes in the chunk stream", markerCountInChunks <= 1,
    `marker occurrences in chunks=${markerCountInChunks}`);

  // Ordered terminal exactly once, or honest unknown — never multiple stops
  // and never a completed claim without upstream evidence.
  const stops = finalEvents.filter((e) => e.type === "turn/stopped");
  check("at most one ordered terminal", stops.length <= 1, JSON.stringify(stops.map((e) => ({ seq: e.seq, data: e.data }))));
  const finalStatus = trace[trace.length - 1]?.status;
  const recovered = stops.length === 1 && (finalStatus === "idle" || finalStatus === "completed");
  const honestUnknown = (finalStatus === "unknown" || finalStatus === "reconciling");
  check("terminal recovered once with evidence OR remains honestly unknown (never false active/guessed idle)",
    recovered || honestUnknown,
    `stops=${stops.length} finalStatus=${finalStatus}`);
  if (stops.length === 1) {
    const lastAnswerSeq = Math.max(...answers.map((e) => e.seq), 0);
    check("terminal is ordered after the recovered output", stops[0].seq > lastAnswerSeq,
      `stopSeq=${stops[0].seq} lastAnswerSeq=${lastAnswerSeq}`);
  }

  // No prompt replay across the recovery.
  const wireEntries = ndjson(join(ctx.dirs.proxy, "wire.ndjson"));
  const promptPosts = wireEntries.filter((e) =>
    e.event === "proxied" && e.method === "POST" && /prompt_async/.test(e.path ?? ""));
  check("no prompt replay across recovery", promptPosts.length === 1, `prompt POST count=${promptPosts.length}`);
  const userMessages = finalEvents.filter((e) => e.type === "user/message");
  check("user intent exactly once", userMessages.length === 1, `user/message count=${userMessages.length}`);

  check("sqlite integrity ok", finalDb.integrityCheck?.[0]?.integrity_check === "ok",
    JSON.stringify(finalDb.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R+H",
    observed: failed.length === 0
      ? `terminal-SSE cut+kill: answer exactly once, ${finalEvents.filter((e) => e.type === "turn/stopped").length} ordered terminal(s), final status ${finalStatus}, no replay`
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "recover output and ordered terminal once, or remain unknown",
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
  for (const file of ["wire.ndjson", "timeline.ndjson", "opencode.log"]) {
    const src = join(ctx.dirs.proxy, file);
    if (existsSync(src)) writeFileSync(join(ctx.dirs.logs, `proxy-${file}`), readFileSync(src));
  }
}
