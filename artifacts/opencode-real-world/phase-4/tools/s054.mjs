// OC-REAL-054 (R): the model has issued a tool call that is durably pending
// (permission gate: bash=ask) but the tool never executed; SIGKILL the exact
// child. Expected: no fabricated result; the tool never silently disappears or
// reruns without proof; the side effect never happens.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, killExact, readPidRecord, scenarioSetup, sleep,
  snapshotOf, startPolyth, stopPolyth, timeline, waitFor, writeDetails,
  writeManifest, writeVerdict,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-054", 15147);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};

// Deterministic pending window: bash requires permission, so the tool call is
// durably pending (never executing) until someone replies.
writeFileSync(join(ctx.dirs.ocConfig, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { bash: "ask" },
}, null, 2));

const sideEffect = join(ctx.dirs.project, "side-054.txt");

const polyth = await startPolyth(ctx, { label: "polyth" });
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s054" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s054", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-054-sigkill-tool-pending-pre-execution",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
    permissionMode: "bash=ask",
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Run exactly this bash command and nothing else: echo done > side-054.txt",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: durable pending tool + open permission, tool never ran.
  const preKill = await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    if (events.some((e) => e.type === "turn/stopped")) throw new Error("turn ended before pending-tool barrier");
    const perm = events.filter((e) => e.type === "permission/requested");
    return perm.length >= 1 ? events : undefined;
  }, { timeoutMs: 180000, intervalMs: 150, what: "durable pending tool (permission gate)" });
  const pendingTools = preKill.filter((e) => e.type === "tool/call" && e.data.status === "pending");
  const permReq = preKill.filter((e) => e.type === "permission/requested");
  details.observations.push({
    pendingTools: pendingTools.map((e) => ({ seq: e.seq, tool: e.data.tool, callId: e.data.callId })),
    permissionRequests: permReq.map((e) => ({ seq: e.seq, requestId: e.data.requestId })),
  });
  check("tool never executed before the kill (no side effect)", !existsSync(sideEffect),
    `side-054.txt exists=${existsSync(sideEffect)}`);

  const record = readPidRecord(ctx.dirs.project);
  timeline(ctx, { event: "barrier", barrier: "tool-pending-pre-execution", childPid: record.child.pid });
  killExact(ctx, record.child.pid, "opencode serve", "SIGKILL");

  // Steady state watch while recovery/reconciliation run.
  const trace = [];
  let last;
  for (let i = 0; i < 20; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    await sleep(2000);
  }
  details.observations.push({ statusTrace: trace });
  console.log("status trace:", JSON.stringify(trace));

  const finalEvents = await eventsOf(ctx, session.id);
  const finalDb = dumpDb(ctx, "final", session.id);

  // No fabricated tool result and no invented completion.
  const results = finalEvents.filter((e) => e.type === "tool/result");
  check("no fabricated tool result", results.length === 0,
    JSON.stringify(results.map((e) => ({ seq: e.seq, callId: e.data.callId }))));
  const falseCompleted = finalEvents.filter((e) => e.type === "turn/stopped" && e.data.reason === "completed");
  check("no invented completion", falseCompleted.length === 0, JSON.stringify(falseCompleted.map((e) => e.data)));

  // The tool never ran (no side effect ever) and never silently reran.
  check("side effect never happened (tool did not run without permission)",
    !existsSync(sideEffect), `side-054.txt exists=${existsSync(sideEffect)}`);

  // The pending tool state remains explicit in durable history (tool/call
  // pending events survive at their sequence numbers).
  const finalBySeq = new Map(finalEvents.map((e) => [e.seq, e]));
  const pendingIntact = pendingTools.every((c) => {
    const now = finalBySeq.get(c.seq);
    return now && now.type === "tool/call";
  });
  check("pending tool state remains explicit (not silently vanished from history)",
    pendingTools.length >= 1 ? pendingIntact : permReq.length >= 1,
    `pendingToolEvents=${pendingTools.length} permissionRequests=${permReq.length}`);

  const finalStatus = trace[trace.length - 1]?.status;
  check("projection settles honestly (unknown/reconciling, not idle/completed)",
    finalStatus === "unknown" || finalStatus === "reconciling",
    `final status=${finalStatus}`);
  check("sqlite integrity ok", finalDb.integrityCheck?.[0]?.integrity_check === "ok",
    JSON.stringify(finalDb.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R",
    observed: failed.length === 0
      ? "pending-tool SIGKILL produced no fabricated result, no side effect, explicit durable state, honest steady state"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "no fabricated result; status remains explicit; no silent disappear/rerun",
    attribution: failed.length === 0 ? "NONE" : "POLYTH",
    identifiers: { canonicalSessionIds: [session.id] },
    blockers: [],
    evidence: [
      `artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/fault-timeline.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/db-final.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/polyth.log`,
    ],
  });
} finally {
  await stopPolyth(ctx, polyth);
}
