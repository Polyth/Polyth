// OC-REAL-053 (R): SIGKILL the exact real OpenCode child mid-reasoning, before
// any answer text exists. Expected: reasoning state stays truthful (never
// rendered as answer text); the session is interrupted/unknown by evidence,
// never false idle.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, killExact, procIdentity, readPidRecord,
  scenarioSetup, sleep, snapshotOf, startPolyth, stopPolyth, timeline,
  waitFor, writeDetails, writeManifest, writeVerdict,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-053", 15146);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};

const polyth = await startPolyth(ctx, { label: "polyth" });
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s053" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s053", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-053-sigkill-mid-reasoning",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Think very carefully step by step before answering: a farmer has 17 sheep; all but 9 run away, then half of the remaining are sold, then he buys as many as he first lost. Work through every stage of the arithmetic slowly and double-check each step in your reasoning, then answer with just the final number.",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: at least one durable reasoning chunk while the turn is running
  // and BEFORE any answer text chunk exists.
  const preKillEvents = await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    if (events.some((e) => e.type === "turn/stopped")) {
      throw new Error("turn completed before the mid-reasoning kill barrier");
    }
    const reasoning = events.filter((e) => e.type === "assistant/reasoning-chunk");
    const text = events.filter((e) => e.type === "assistant/chunk");
    if (text.length > 0) throw new Error("answer text started before a reasoning kill window existed");
    return reasoning.length >= 1 ? events : undefined;
  }, { timeoutMs: 180000, intervalMs: 120, what: "durable reasoning mid-turn" });

  const record = readPidRecord(ctx.dirs.project);
  timeline(ctx, { event: "barrier", barrier: "mid-reasoning", childPid: record.child.pid });
  killExact(ctx, record.child.pid, "opencode serve", "SIGKILL");

  const prefixReasoning = preKillEvents
    .filter((e) => e.type === "assistant/reasoning-chunk")
    .map((e) => ({ seq: e.seq, partId: e.data.partId, text: e.data.text }));
  details.observations.push({ reasoningChunkCount: prefixReasoning.length,
    reasoningBytes: prefixReasoning.reduce((n, c) => n + c.text.length, 0) });

  // Steady state watch while natural-death recovery + reconciliation run.
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

  // Reasoning chunks stay reasoning at their original sequence numbers.
  const finalBySeq = new Map(finalEvents.map((e) => [e.seq, e]));
  const reasoningIntact = prefixReasoning.every((c) => {
    const now = finalBySeq.get(c.seq);
    return now && now.type === "assistant/reasoning-chunk" && now.data.text === c.text;
  });
  check("durable reasoning survives unchanged as reasoning", reasoningIntact,
    `reasoning chunks=${prefixReasoning.length}`);

  // Reasoning must never be rendered as final answer text.
  const reasoningPartIds = new Set(prefixReasoning.map((c) => c.partId));
  const reasoningAsText = finalEvents.filter((e) =>
    (e.type === "assistant/chunk" && reasoningPartIds.has(e.data.partId))
    || (e.type === "assistant/message" && reasoningPartIds.has(e.data.partId)
        && typeof e.data.text === "string" && e.data.text.length > 0));
  check("reasoning is never rendered as answer text", reasoningAsText.length === 0,
    JSON.stringify(reasoningAsText.map((e) => ({ seq: e.seq, type: e.type }))));

  // No invented completion / false idle.
  const stops = finalEvents.filter((e) => e.type === "turn/stopped");
  const falseCompleted = stops.filter((e) => e.data.reason === "completed");
  check("no invented completion", falseCompleted.length === 0, JSON.stringify(stops.map((e) => e.data)));
  const finalStatus = trace[trace.length - 1]?.status;
  check("no false idle: projection settles honestly (unknown/reconciling)",
    finalStatus === "unknown" || finalStatus === "reconciling",
    `final status=${finalStatus} trace=${JSON.stringify(trace)}`);
  check("sqlite integrity ok", finalDb.integrityCheck?.[0]?.integrity_check === "ok",
    JSON.stringify(finalDb.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R",
    observed: failed.length === 0
      ? `mid-reasoning SIGKILL kept ${prefixReasoning.length} reasoning chunks truthful, never rendered as answer, honest ${finalStatus} steady state`
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "reasoning state truthful; interrupted/unknown by evidence; never false idle",
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
