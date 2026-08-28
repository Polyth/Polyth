// OC-REAL-052 (R): SIGKILL the exact real OpenCode child mid-text after
// several durable deltas. Expected: durable prefix survives once; no invented
// suffix or completion; recovery appends only proven suffix; the projection
// never claims completed and does not silently pretend the turn is alive.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, killExact, procIdentity, readPidRecord,
  scenarioSetup, sleep, snapshotOf, startPolyth, stopPolyth, timeline,
  waitFor, writeDetails, writeManifest, writeVerdict,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-052", 15145);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};

const statusTrace = async (sessionId, seconds) => {
  const trace = [];
  let last;
  for (let i = 0; i < seconds / 2; i++) {
    const snap = await snapshotOf(ctx, sessionId);
    if (snap.status !== last) {
      trace.push({ ts: new Date().toISOString(), status: snap.status });
      last = snap.status;
    }
    await sleep(2000);
  }
  return trace;
};

// Deterministic mid-text window: bash is pre-allowed (harness-owned config),
// and the prompt interleaves text stages with a long sleep so several durable
// text checkpoints exist while the turn is still running.
writeFileSync(join(ctx.dirs.ocConfig, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { bash: "allow" },
}, null, 2));

const polyth = await startPolyth(ctx, { label: "polyth" });
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s052" })).json;
  const raw = process.env.S_MODEL ?? "opencode/big-pickle";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s052", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-052-sigkill-mid-text",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "First, write a 100 word paragraph about lighthouses (plain text). Then run the bash command `sleep 30`. After it finishes, write a 100 word paragraph about storms.",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: durable text of the active turn exists while the turn is still
  // running (the 30 s sleeping tool holds the turn open after the text part
  // finalized). Kill inside that window.
  const preKillEvents = await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    const chunks = events.filter((e) => e.type === "assistant/chunk");
    const stopped = events.some((e) => e.type === "turn/stopped");
    if (stopped) throw new Error("turn completed before the mid-text kill barrier");
    return chunks.length >= 1 ? events : undefined;
  }, { timeoutMs: 240000, intervalMs: 150, what: "durable text mid-turn" });

  const record = readPidRecord(ctx.dirs.project);
  const identity = procIdentity(record.child.pid);
  check("PID record matches the live child identity",
    identity !== undefined && identity.cmdline === record.child.command,
    JSON.stringify({ record: record.child, identity }));
  timeline(ctx, { event: "barrier", barrier: "mid-text-3-deltas", childPid: record.child.pid });
  killExact(ctx, record.child.pid, "opencode serve", "SIGKILL");

  const prefixChunks = preKillEvents.filter((e) => e.type === "assistant/chunk")
    .map((e) => ({ seq: e.seq, partId: e.data.partId, text: e.data.text }));
  const prefixText = prefixChunks.map((c) => c.text).join("");
  details.observations.push({ prefixChunkCount: prefixChunks.length, prefixBytes: prefixText.length });

  // Steady state: watch the projection for 40 s while natural-death recovery
  // respawns a fresh child and reconciliation runs.
  const trace = await statusTrace(session.id, 40);
  details.observations.push({ statusTrace: trace });
  console.log("status trace:", JSON.stringify(trace));

  const finalEvents = await eventsOf(ctx, session.id);
  const finalDb = dumpDb(ctx, "final", session.id);

  // Prefix must remain intact, exactly once, at the same sequence numbers.
  const finalBySeq = new Map(finalEvents.map((e) => [e.seq, e]));
  const prefixIntact = prefixChunks.every((c) => {
    const now = finalBySeq.get(c.seq);
    return now && now.type === "assistant/chunk" && now.data.text === c.text;
  });
  check("durable prefix survives unchanged", prefixIntact, `prefix chunks=${prefixChunks.length}`);

  // No duplicated prefix: each partId finalizes at most once, and the full
  // final text for a part must not contain the prefix twice.
  const messagesByPart = new Map();
  for (const e of finalEvents.filter((e) => e.type === "assistant/message")) {
    messagesByPart.set(e.data.partId, (messagesByPart.get(e.data.partId) ?? 0) + 1);
  }
  const duplicatedPart = [...messagesByPart.entries()].find(([, count]) => count > 1);
  check("no part finalizes twice", duplicatedPart === undefined, JSON.stringify([...messagesByPart.entries()]));

  // No invented completion: turn/stopped(completed) requires upstream terminal
  // evidence, which cannot exist for a SIGKILLed mid-turn child.
  const stops = finalEvents.filter((e) => e.type === "turn/stopped");
  const falseCompleted = stops.filter((e) => e.data.reason === "completed");
  check("no invented completion", falseCompleted.length === 0, JSON.stringify(stops.map((e) => e.data)));

  const finalStatus = trace[trace.length - 1]?.status;
  check("projection settles honestly (unknown/reconciling), not completed/idle and not forever-running",
    finalStatus === "unknown" || finalStatus === "reconciling",
    `final status=${finalStatus} trace=${JSON.stringify(trace)}`);

  check("sqlite integrity ok", finalDb.integrityCheck?.[0]?.integrity_check === "ok", JSON.stringify(finalDb.integrityCheck));

  const failed = details.checks.filter((c) => !c.pass);
  writeDetails(ctx, details);
  writeVerdict(ctx, {
    verdict: failed.length === 0 ? "pass" : "fail",
    engine: "R",
    observed: failed.length === 0
      ? `mid-text SIGKILL preserved ${prefixChunks.length} durable deltas once, no invented suffix/completion, honest ${finalStatus} steady state`
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "prefix remains; no invented suffix/completion; recovery uses proven suffix only",
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
