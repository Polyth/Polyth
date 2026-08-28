// OC-REAL-055 (R): a tool has produced an OBSERVABLE side effect (appended a
// line to a file) but its terminal tool event has not arrived; SIGKILL the
// exact child. Expected: Polyth does not repeat the tool or the prompt and
// never claims a result it did not observe. Duplicate side effect = failure.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  api, dumpDb, eventsOf, killExact, readPidRecord, scenarioSetup, sleep,
  snapshotOf, startPolyth, stopPolyth, timeline, waitFor, writeDetails,
  writeManifest, writeVerdict,
} from "./lib.mjs";

const ctx = scenarioSetup("OC-REAL-055", 15148);
const details = { checks: [], observations: [] };
const check = (name, pass, observed) => {
  details.checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};

writeFileSync(join(ctx.dirs.ocConfig, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { bash: "allow" },
}, null, 2));

const sideEffect = join(ctx.dirs.project, "effect-055.txt");
const effectLines = () => existsSync(sideEffect)
  ? readFileSync(sideEffect, "utf8").split("\n").filter(Boolean)
  : [];

const polyth = await startPolyth(ctx, { label: "polyth" });
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "s055" })).json;
  const raw = process.env.S_MODEL ?? "google/gemini-3.6-flash";
  const model = { providerID: raw.slice(0, raw.indexOf("/")), modelID: raw.slice(raw.indexOf("/") + 1) };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "s055", model })).json;
  writeManifest(ctx, {
    faultSeed: "OC-REAL-055-sigkill-after-side-effect-before-tool-terminal",
    projectId: project.id,
    canonicalSessionId: session.id,
    providerModel: model,
  });

  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Run exactly this single bash command and nothing else: echo ran >> effect-055.txt && sleep 45",
  }, { timeoutMs: 60000 });
  check("prompt admitted", send.status === 200, `status=${send.status}`);

  // Barrier: the observable side effect exists on disk while the tool has no
  // terminal event yet (the 45s sleep holds it open).
  await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    if (events.some((e) => e.type === "turn/stopped")) throw new Error("turn ended before side-effect barrier");
    if (events.some((e) => e.type === "tool/result")) throw new Error("tool terminal arrived before the kill barrier");
    return effectLines().length >= 1 ? true : undefined;
  }, { timeoutMs: 180000, intervalMs: 150, what: "observable side effect, tool non-terminal" });
  const linesAtKill = effectLines();
  details.observations.push({ linesAtKill });

  const record = readPidRecord(ctx.dirs.project);
  timeline(ctx, { event: "barrier", barrier: "side-effect-before-terminal", childPid: record.child.pid });
  killExact(ctx, record.child.pid, "opencode serve", "SIGKILL");

  // Steady state watch (recovery + reconciliation + would-be replays).
  const trace = [];
  let last;
  for (let i = 0; i < 25; i++) {
    const snap = await snapshotOf(ctx, session.id);
    if (snap.status !== last) { trace.push({ ts: new Date().toISOString(), status: snap.status }); last = snap.status; }
    await sleep(2000);
  }
  details.observations.push({ statusTrace: trace });
  console.log("status trace:", JSON.stringify(trace));

  const finalEvents = await eventsOf(ctx, session.id);
  const finalDb = dumpDb(ctx, "final", session.id);
  const linesFinal = effectLines();
  details.observations.push({ linesFinal });

  check("no duplicate side effect (tool was not repeated)",
    linesFinal.length === linesAtKill.length && linesFinal.length === 1,
    `lines at kill=${linesAtKill.length} final=${linesFinal.length}`);

  const userMessages = finalEvents.filter((e) => e.type === "user/message");
  check("prompt was not repeated", userMessages.length === 1, `user/message count=${userMessages.length}`);

  // No claimed result Polyth never observed: the SIGKILL preceded any tool
  // terminal, so a tool/result would be fabricated.
  const results = finalEvents.filter((e) => e.type === "tool/result");
  check("no fabricated tool result", results.length === 0,
    JSON.stringify(results.map((e) => ({ seq: e.seq, callId: e.data.callId }))));
  const falseCompleted = finalEvents.filter((e) => e.type === "turn/stopped" && e.data.reason === "completed");
  check("no invented completion", falseCompleted.length === 0, JSON.stringify(falseCompleted.map((e) => e.data)));

  const finalStatus = trace[trace.length - 1]?.status;
  check("uncertainty is not hidden (unknown/reconciling, not idle/completed)",
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
      ? "side-effect-then-kill left exactly one side effect, one prompt, no fabricated result, honest steady state"
      : `failed checks: ${failed.map((c) => c.name).join("; ")}`,
    expected: "no repeated tool/prompt; no claimed unobserved result; no hidden uncertainty",
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
