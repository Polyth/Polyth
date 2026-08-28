// OC-REAL-056 (R): SIGKILL the exact child while a permission request is
// durably open. Expected: the card persists unless newer authoritative
// evidence resolves it; an answer is never sent to a replacement child without
// binding proof (the gated tool must never run from a post-kill reply).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, killExact, readPidRecord, scenarioSetup, sleep,
  snapshotOf, startPolyth, stopPolyth, timeline, waitFor, writeDetails,
  writeManifest, writeVerdict,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-056", 15149);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};

writeFileSync(join(ctx.dirs.ocConfig, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { bash: "ask" },
}, null, 2));

const sideEffect = join(ctx.dirs.project, "side-056.txt");

const polyth = await startPolyth(ctx, { label: "polyth" });
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s056" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s056", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-056-sigkill-permission-pending",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
    permissionMode: "bash=ask",
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Run exactly this bash command and nothing else: echo granted > side-056.txt",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: durable open permission request.
  const preKill = await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    if (events.some((e) => e.type === "turn/stopped")) throw new Error("turn ended before permission barrier");
    const perm = events.filter((e) => e.type === "permission/requested");
    return perm.length >= 1 ? { events, perm } : undefined;
  }, { timeoutMs: 180000, intervalMs: 150, what: "durable open permission" });
  const requestId = preKill.perm[0].data.requestId;
  details.observations.push({ requestId, permissionEvents: preKill.perm.map((e) => ({ seq: e.seq, requestId: e.data.requestId })) });

  const snapBefore = await snapshotOf(ctx, session.id);
  const openBefore = (snapBefore.permissions ?? snapBefore.attention ?? []);
  details.observations.push({ snapBeforeStatus: snapBefore.status, openBefore });

  const record = readPidRecord(ctx.dirs.project);
  timeline(ctx, { event: "barrier", barrier: "permission-pending", childPid: record.child.pid, requestId });
  killExact(ctx, record.child.pid, "opencode serve", "SIGKILL");
  await sleep(1500);

  // Answer the dead child's permission: it must NOT be silently routed to a
  // replacement child as an approval. Either a bounded explicit error, or a
  // no-op that provably never runs the gated tool.
  const replyT0 = Date.now();
  let reply;
  try {
    reply = await api(ctx, "POST",
      `/api/sessions/${session.id}/permission/${encodeURIComponent(requestId)}`,
      { reply: "once" }, { timeoutMs: 120000 });
  } catch (error) {
    reply = { status: -1, json: { timeoutError: String(error) } };
  }
  const replyElapsedMs = Date.now() - replyT0;
  details.observations.push({ replyAfterKill: reply, replyElapsedMs });
  console.log("reply after kill:", reply.status, `elapsed=${replyElapsedMs}ms`, JSON.stringify(reply.json).slice(0, 200));

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
  const snapAfter = await snapshotOf(ctx, session.id);
  details.observations.push({ snapAfterStatus: snapAfter.status, attentionOpenFinal: finalDb.attention_open });

  // Binding proof rule: the gated tool must never have run.
  check("gated tool never ran (answer not misrouted to a replacement)",
    !existsSync(sideEffect), `side-056.txt exists=${existsSync(sideEffect)}`);
  check("post-kill answer settles bounded (no >120s hang)", reply.status !== -1,
    `reply status=${reply.status} elapsed=${details.observations.find((o) => o.replyElapsedMs)?.replyElapsedMs}ms`);
  check("post-kill answer is not a silent fake success",
    reply.status !== 200
      || finalDb.attention_open.length === 0
      || !existsSync(sideEffect),
    `reply status=${reply.status}`);

  // Card lifecycle: persists, or closed by authoritative evidence only.
  // The durable permission/requested event must never vanish from history.
  const permStill = finalEvents.filter((e) => e.type === "permission/requested");
  check("permission request never vanishes from durable history",
    permStill.length >= 1, `permission/requested count=${permStill.length}`);
  const closures = finalEvents.filter((e) =>
    e.type === "permission/resolved" || e.type === "permission/replied" || e.type === "permission/closed");
  details.observations.push({ closures: closures.map((e) => ({ seq: e.seq, type: e.type, data: e.data })) });

  const results = finalEvents.filter((e) => e.type === "tool/result");
  check("no fabricated tool result", results.length === 0,
    JSON.stringify(results.map((e) => ({ seq: e.seq })) ));
  const falseCompleted = finalEvents.filter((e) => e.type === "turn/stopped" && e.data.reason === "completed");
  check("no invented completion", falseCompleted.length === 0, JSON.stringify(falseCompleted.map((e) => e.data)));

  const finalStatus = trace[trace.length - 1]?.status;
  check("projection settles honestly (unknown/reconciling)",
    finalStatus === "unknown" || finalStatus === "reconciling", `final status=${finalStatus}`);
  check("sqlite integrity ok", finalDb.integrityCheck?.[0]?.integrity_check === "ok",
    JSON.stringify(finalDb.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R",
    observed: failed.length === 0
      ? "permission-pending SIGKILL: card history durable, post-kill answer never misrouted (gated tool never ran), honest steady state"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "card persists unless resolved by authoritative evidence; no misrouted answer",
    attribution: failed.length === 0 ? "NONE" : "POLYTH",
    identifiers: { canonicalSessionIds: [session.id], permissionRequestIds: [requestId] },
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
