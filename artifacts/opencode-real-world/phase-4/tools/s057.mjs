// OC-REAL-057 (R): SIGKILL the exact child while a model QUESTION is durably
// open. Same rule as 056: the question persists unless authoritative evidence
// resolves it; an answer must never be misrouted to a replacement child.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, killExact, readPidRecord, scenarioSetup, sleep,
  snapshotOf, startPolyth, stopPolyth, timeline, waitFor, writeDetails,
  writeManifest, writeVerdict,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-057", 15150);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};

const polyth = await startPolyth(ctx, { label: "polyth" });
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s057" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s057", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-057-sigkill-question-pending",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Before doing anything else, you MUST use your ask/question tool to ask me one clarifying question about which directory to use. Do not answer directly; use the question tool.",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: durable open question. Models may refuse to use the tool; if so
  // the scenario is model-blocked, not a Polyth failure.
  let barrier;
  try {
    barrier = await waitFor(async () => {
      const events = await eventsOf(ctx, session.id);
      if (events.some((e) => e.type === "turn/stopped")) throw new Error("turn ended without asking a question");
      const q = events.filter((e) => e.type === "question/asked");
      return q.length >= 1 ? { events, q } : undefined;
    }, { timeoutMs: 120000, intervalMs: 150, what: "durable open question" });
  } catch (error) {
    details.observations.push({ barrierError: String(error.message) });
    const events = await eventsOf(ctx, session.id);
    details.observations.push({ eventTypes: events.map((e) => e.type) });
    writeDetails(ctx, details);
    writeVerdict(ctx, {
      verdict: "blocked",
      engine: "R",
      observed: `model never produced a durable question: ${String(error.message)}`,
      expected: "question persists across kill; no misrouted answer",
      attribution: "MODEL",
      blockers: [],
      evidence: [`artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`],
    });
    throw error;
  }
  const requestId = barrier.q[0].data.requestId;
  details.observations.push({ requestId, questionEvents: barrier.q.map((e) => ({ seq: e.seq, requestId: e.data.requestId })) });

  const record = readPidRecord(ctx.dirs.project);
  timeline(ctx, { event: "barrier", barrier: "question-pending", childPid: record.child.pid, requestId });
  killExact(ctx, record.child.pid, "opencode serve", "SIGKILL");
  await sleep(1500);

  // Answer the dead child's question: must not silently misroute.
  const replyT0 = Date.now();
  let reply;
  try {
    reply = await api(ctx, "POST",
      `/api/sessions/${session.id}/question/${encodeURIComponent(requestId)}`,
      { answers: [["the workspace directory"]] }, { timeoutMs: 120000 });
  } catch (error) {
    reply = { status: -1, json: { timeoutError: String(error) } };
  }
  const replyElapsedMs = Date.now() - replyT0;
  details.observations.push({ replyAfterKill: reply, replyElapsedMs });
  console.log("reply after kill:", reply.status, `elapsed=${replyElapsedMs}ms`, JSON.stringify(reply.json).slice(0, 200));

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

  const questionStill = finalEvents.filter((e) => e.type === "question/asked");
  check("question never vanishes from durable history", questionStill.length >= 1,
    `question/asked count=${questionStill.length}`);
  const dupQuestions = new Set(questionStill.map((e) => e.data.requestId));
  check("question is not duplicated", dupQuestions.size === questionStill.length,
    `distinct=${dupQuestions.size} total=${questionStill.length}`);
  check("post-kill answer settles bounded (no >120s hang)", reply.status !== -1,
    `reply status=${reply.status} elapsed=${replyElapsedMs}ms`);
  check("post-kill answer is not a silent fake success", reply.status !== 200,
    `reply status=${reply.status}`);
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
      ? "question-pending SIGKILL: question durable and unduplicated, post-kill answer bounded, honest steady state"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "question persists; no loss, duplication, or answer misroute",
    attribution: failed.length === 0 ? "NONE" : "POLYTH",
    identifiers: { canonicalSessionIds: [session.id], questionRequestIds: [requestId] },
    blockers: [],
    evidence: [
      `artifacts/opencode-real-world/phase-4/${ctx.id}/details.json`,
      `logs/opencode-real-world/phase-4/${ctx.id}/fault-timeline.ndjson`,
      `logs/opencode-real-world/phase-4/${ctx.id}/db-final.json`,
    ],
  });
} finally {
  await stopPolyth(ctx, polyth);
}
