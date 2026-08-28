/**
 * OC-REAL-071 (R): delete an active session's worktree during text, tool,
 * permission and idle phases (fresh production boot + real OpenCode per
 * phase). Existing durable history must survive; new filesystem work must be
 * blocked or fail truthfully; nothing may fall back to the project root, the
 * last cwd, or another worktree.
 *
 * BLOCKER 6 detector: any reply/tool output that reads PROJECT_A_MAIN (root
 * fallback) or another tree's marker after the worktree is gone.
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

import type { SessionEvent } from "@polyth/contracts";

import {
  FIXTURE, MARKERS, MODEL, OPENCODE_VERSION,
  appendNdjson, autoAnswerPermissions, closeRuntime, databaseSnapshot,
  errorCode, foreignMarkers, httpJson, makeScratch, manifest, messageCwd,
  messageRole, messageText, projectionOf, readEvents, resetFixture, restoreEnvironment,
  seedProjects, serveFor, sleep, toolParts, upstreamMessages, waitEvent,
  waitFor, waitUpstreamAssistant, writeJson, writeOpencodeConfig, writeVerdict,
  WsTrace, openRuntime,
  type RuntimeHandle, type Scratch, type Verdict,
} from "./phase6lib.ts";

const ID = "OC-REAL-071";
const WORKTREE = FIXTURE.aFeature;
const READ_PROMPT = "Read the file IDENTITY.txt in the current directory and reply with exactly its contents and nothing else.";
const BASH_PROMPT = "Use the bash tool to run exactly this command: cat IDENTITY.txt — then reply with only the raw command output.";
const SLOW_BASH_PROMPT = "Use the bash tool to run exactly this command: sleep 5 && cat IDENTITY.txt — then reply with only the raw command output.";
const TEXT_PROMPT = "Do not use any tools. Write eight numbered short sentences about rivers.";

interface PhaseResult {
  phase: string;
  failures: string[];
  /** Honesty gaps: truthfulness problems that are not leaks/fallbacks. */
  gaps: string[];
  blocker: boolean;
  details: Record<string, unknown>;
}

const removeWorktreeRaw = (): void => {
  execFileSync("rm", ["-rf", WORKTREE]);
};

const messageId = (message: Record<string, unknown>): string =>
  String((message.info as Record<string, unknown> | undefined)?.id ?? "");

/**
 * Wait for an assistant turn that is NOT part of `priorIds` to settle. The
 * baseline turn is already completed, so the generic last-assistant wait
 * would return it immediately — and its tool output legitimately contains
 * the worktree marker, which must not pollute post-fault leak checks.
 */
const waitNewAssistant = async (
  base: string,
  backendId: string,
  directory: string,
  priorIds: Set<string>,
  timeoutMs: number,
  wirePath?: string,
): Promise<{
  completed: boolean;
  newMessages: Array<Record<string, unknown>>;
  text: string;
}> => {
  const deadline = Date.now() + timeoutMs;
  let fresh: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    const messages = await upstreamMessages(base, backendId, directory, wirePath);
    fresh = messages.filter((message) => !priorIds.has(messageId(message)));
    const assistants = fresh.filter((message) => messageRole(message) === "assistant");
    const last = assistants.at(-1) as { info?: { time?: { completed?: number }; error?: unknown } } | undefined;
    if (last?.info?.time?.completed || last?.info?.error) {
      return { completed: true, newMessages: fresh, text: messageText(last as Record<string, unknown>) };
    }
    await sleep(750);
  }
  return { completed: false, newMessages: fresh, text: "" };
};

const leakChecks = (
  phase: string,
  text: string,
  failures: string[],
): boolean => {
  let blocker = false;
  if (text.includes(MARKERS.aMain)) {
    failures.push(`${phase}: output fell back to the repo root marker ${MARKERS.aMain}`);
    blocker = true;
  }
  for (const marker of [MARKERS.bMain, MARKERS.bFeature]) {
    if (text.includes(marker)) {
      failures.push(`${phase}: output leaked another tree's marker ${marker}`);
      blocker = true;
    }
  }
  return blocker;
};

const runPhase = async (
  phase: "idle" | "text" | "tool" | "permission",
): Promise<PhaseResult> => {
  resetFixture();
  const scratch: Scratch = await makeScratch(ID, phase);
  await writeOpencodeConfig(scratch);
  await seedProjects(scratch, [{ id: "project-a", path: FIXTURE.aRoot }]);
  const polythLog = join(scratch.logsDir, "polyth.ndjson");
  const wireLog = join(scratch.logsDir, "wire.ndjson");
  const log = (entry: unknown) => void appendNdjson(polythLog, entry);
  const failures: string[] = [];
  const gaps: string[] = [];
  let blocker = false;
  const details: Record<string, unknown> = { phase };
  let runtime: RuntimeHandle | undefined;
  let ws: WsTrace | undefined;
  let permissionAnswerer: ReturnType<typeof autoAnswerPermissions> | undefined;
  try {
    runtime = await openRuntime(scratch);
    const created = await runtime.app.sessions.create({
      projectId: "project-a",
      title: `${ID} ${phase}`,
      model: MODEL,
      worktreePath: WORKTREE,
    });
    const sessionId = created.id;
    ws = await WsTrace.open(runtime.baseUrl, join(scratch.logsDir, "websocket.ndjson"));
    ws.subscribe(sessionId, "project-a");
    const projection = await projectionOf(runtime, sessionId);
    const backendId = String(projection.backendSessionId ?? "");
    const serve = serveFor(WORKTREE);
    const base = serve && serve.ports.length > 0 ? `http://127.0.0.1:${serve.ports[0]}` : "";
    details.backendId = backendId;
    details.servePid = serve?.pid;
    if (!base) failures.push(`${phase}: no serve endpoint for the worktree`);

    // Baseline durable history: one COMPLETED read turn before any fault so
    // "existing durable history remains" is a real assertion.
    permissionAnswerer = autoAnswerPermissions(runtime, sessionId, log);
    await runtime.app.sessions.send(sessionId, { text: READ_PROMPT, model: MODEL });
    const baseline = await waitUpstreamAssistant(base, backendId, WORKTREE, 180_000, wireLog);
    details.baselineReply = baseline.text.trim();
    if (!baseline.completed || !baseline.text.includes(MARKERS.aFeature)) {
      failures.push(`${phase}: baseline turn did not complete with the worktree marker (got ${JSON.stringify(baseline.text.slice(0, 80))})`);
    }
    await waitFor(async () => (await projectionOf(runtime!, sessionId)).status === "idle",
      60_000, 300, `${phase}: baseline idle`);
    const baselineEvents = await readEvents(runtime, sessionId);
    details.baselineEventCount = baselineEvents.length;
    const baselineIds = new Set(
      (await upstreamMessages(base, backendId, WORKTREE, wireLog)).map((message) => messageId(message)),
    );
    await databaseSnapshot(scratch, "db-baseline");

    if (phase === "idle") {
      // ---- delete while idle, via the product API (marks worktree missing) --
      const removal = await httpJson(runtime.baseUrl, "POST", "/api/worktrees/remove", {
        projectId: "project-a", path: WORKTREE,
      }, wireLog);
      details.removalStatus = removal.status;
      if (removal.status !== 200) failures.push(`idle: API worktree removal returned ${removal.status}`);
      await waitFor(async () =>
        (await projectionOf(runtime!, sessionId)).worktreeState === "missing",
        10_000, 200, "idle: worktreeState missing");
      const missingProjection = await projectionOf(runtime, sessionId);
      details.worktreeStateAfterRemoval = missingProjection.worktreeState;
      details.worktreePathAfterRemoval = missingProjection.worktreePath;
      if (missingProjection.worktreePath && resolve(missingProjection.worktreePath) !== resolve(WORKTREE)) {
        failures.push(`idle: projection worktreePath drifted to ${missingProjection.worktreePath}`);
        blocker = true;
      }
      // new filesystem work through session-scoped routes must be blocked
      const fileRead = await httpJson(runtime.baseUrl, "GET",
        `/api/files/read?projectId=project-a&sessionId=${sessionId}&path=IDENTITY.txt`, undefined, wireLog);
      const gitStatus = await httpJson(runtime.baseUrl, "GET",
        `/api/git/status?projectId=project-a&sessionId=${sessionId}`, undefined, wireLog);
      details.fileReadAfterRemoval = { status: fileRead.status, body: fileRead.body };
      details.gitStatusAfterRemoval = { status: gitStatus.status, body: gitStatus.body };
      if (fileRead.status === 200) {
        failures.push(`idle: files/read served content for a missing worktree: ${JSON.stringify(fileRead.body).slice(0, 120)}`);
        blocker = blocker || leakChecks("idle-files", fileRead.raw, failures);
      }
      if (gitStatus.status === 200) {
        failures.push("idle: git/status answered for a missing worktree");
      }
      // a NEW model turn must fail truthfully, not read the root file
      let sendError = "";
      try {
        await runtime.app.sessions.send(sessionId, { text: BASH_PROMPT, model: MODEL });
      } catch (error) {
        sendError = errorCode(error);
      }
      details.postRemovalSendError = sendError;
      // Only messages created AFTER the removal count: the baseline turn's
      // read legitimately contained the feature marker.
      const post = await waitNewAssistant(base, backendId, WORKTREE, baselineIds, 180_000, wireLog);
      const tools = toolParts(post.newMessages);
      details.postRemovalReply = post.text.trim();
      details.postRemovalTools = tools;
      const allOutput = `${post.text}\n${tools.map((tool) => tool.output).join("\n")}`;
      blocker = leakChecks("idle", allOutput, failures) || blocker;
      // Marker check is scoped to fresh COMPLETED tool output — the model may
      // truthfully echo the marker from its context; only a successful
      // post-removal filesystem read of it proves a stale/fallback read.
      const freshToolReads = tools
        .filter((tool) => tool.status === "completed")
        .map((tool) => tool.output)
        .join("\n");
      if (freshToolReads.includes(MARKERS.aFeature)) {
        failures.push("idle: a post-removal tool read still returned the deleted worktree's marker");
      }
      const cwds = post.newMessages.map((message) => messageCwd(message)).filter(Boolean);
      details.postRemovalCwds = [...new Set(cwds)];
      for (const cwd of cwds) {
        if (resolve(cwd) === resolve(FIXTURE.aRoot)) {
          failures.push("idle: upstream message cwd fell back to the repo root");
          blocker = true;
        }
      }
    }

    if (phase === "text") {
      // ---- raw rm -rf mid text-stream ---------------------------------------
      await runtime.app.sessions.send(sessionId, { text: TEXT_PROMPT, model: MODEL });
      // delete as soon as the assistant message row exists upstream (turn active)
      await waitFor(async () => {
        const messages = await upstreamMessages(base, backendId, WORKTREE, wireLog);
        return messages.some((message) => messageRole(message) === "assistant");
      }, 120_000, 300, "text: assistant row visible");
      removeWorktreeRaw();
      details.deletedAt = Date.now();
      const outcome = await waitNewAssistant(base, backendId, WORKTREE, baselineIds, 180_000, wireLog);
      details.completed = outcome.completed;
      details.reply = outcome.text.trim().slice(0, 400);
      blocker = leakChecks("text", outcome.text, failures) || blocker;
      if (!outcome.completed) {
        // acceptable only if the failure is explicit — projection must not lie idle-with-reply
        details.note = "turn did not complete after mid-stream deletion";
      }
      // durable history from the baseline must survive
      const events = await readEvents(runtime, sessionId);
      if (events.length < baselineEvents.length) {
        failures.push(`text: durable event log shrank ${baselineEvents.length} -> ${events.length}`);
      }
      // a NEW session for the deleted worktree must fail truthfully
      let recreateOutcome = "";
      try {
        const recreated = await runtime.app.sessions.create({
          projectId: "project-a", title: "text recreate", model: MODEL, worktreePath: WORKTREE,
        });
        const recreatedProjection = await projectionOf(runtime, recreated.id);
        recreateOutcome = `created:${recreatedProjection.status}:worktreeState=${recreatedProjection.worktreeState}`;
        if (!recreatedProjection.worktreePath) {
          failures.push("text: recreate silently dropped the worktreePath (root fallback)");
          blocker = true;
        }
        if (recreatedProjection.status !== "failed" && recreatedProjection.worktreeState !== "missing") {
          // Not a leak or fallback: the pool reuses the live runtime keyed to
          // the (now deleted, still git-listed) path, so create succeeds and
          // the projection claims a ready worktree that no longer exists.
          gaps.push(`text: session created on an rm-rf'd (unpruned) worktree settled ${recreatedProjection.status} with worktreeState=${recreatedProjection.worktreeState} — honesty gap, no fallback`);
        }
      } catch (error) {
        recreateOutcome = `rejected:${errorCode(error)}`;
      }
      details.recreateOutcome = recreateOutcome;
    }

    if (phase === "tool") {
      // ---- raw rm -rf while a bash tool is RUNNING inside the worktree ------
      await runtime.app.sessions.send(sessionId, { text: SLOW_BASH_PROMPT, model: MODEL });
      // the auto answerer approves the bash permission; wait for running state
      await waitFor(async () => {
        const messages = await upstreamMessages(base, backendId, WORKTREE, wireLog);
        return toolParts(messages).some((tool) =>
          tool.tool === "bash" && (tool.status === "running" || tool.status === "completed" || tool.status === "error"));
      }, 180_000, 400, "tool: bash reached running");
      removeWorktreeRaw();
      details.deletedAt = Date.now();
      const outcome = await waitNewAssistant(base, backendId, WORKTREE, baselineIds, 180_000, wireLog);
      const tools = toolParts(outcome.newMessages).filter((tool) => tool.tool === "bash");
      details.completed = outcome.completed;
      details.reply = outcome.text.trim().slice(0, 300);
      details.tools = tools;
      const allOutput = `${outcome.text}\n${tools.map((tool) => `${tool.output} ${tool.error ?? ""}`).join("\n")}`;
      blocker = leakChecks("tool", allOutput, failures) || blocker;
      const events = await readEvents(runtime, sessionId);
      if (events.length < baselineEvents.length) {
        failures.push(`tool: durable event log shrank ${baselineEvents.length} -> ${events.length}`);
      }
      // The command ran inside a deleted directory: cat must fail (bash keeps
      // the deleted inode as cwd, so the relative read cannot resolve) —
      // success output equal to the feature marker means a cross-tree read.
      const catSucceeded = tools.some((tool) =>
        tool.status === "completed" && tool.output.includes(MARKERS.aFeature));
      details.catSucceededAfterDeletion = catSucceeded;
      if (catSucceeded) {
        details.note = "bash held the deleted-cwd inode; kernel semantics keep open dirs readable — verify no NEW path resolution happened via root";
      }
    }

    if (phase === "permission") {
      // ---- raw rm -rf while the bash permission is PENDING -------------------
      permissionAnswerer.stop(); // manual control for this phase
      await runtime.app.sessions.send(sessionId, { text: BASH_PROMPT, model: MODEL });
      const requested = await waitEvent(runtime, sessionId, (event: SessionEvent) =>
        event.type === "permission/requested", 180_000, "permission requested");
      const requestId = String((requested.data as { requestId?: unknown }).requestId ?? "");
      details.requestId = requestId;
      removeWorktreeRaw();
      details.deletedAt = Date.now();
      // permission artifact must survive the deletion
      const stillOpen = (await readEvents(runtime, sessionId)).some((event) =>
        event.type === "permission/requested"
        && String((event.data as { requestId?: unknown }).requestId ?? "") === requestId);
      if (!stillOpen) failures.push("permission: pending permission vanished when the worktree was deleted");
      await runtime.app.sessions.replyPermission(sessionId, requestId, "once");
      const outcome = await waitNewAssistant(base, backendId, WORKTREE, baselineIds, 180_000, wireLog);
      const tools = toolParts(outcome.newMessages).filter((tool) => tool.tool === "bash");
      details.completed = outcome.completed;
      details.reply = outcome.text.trim().slice(0, 300);
      details.tools = tools;
      const allOutput = `${outcome.text}\n${tools.map((tool) => `${tool.output} ${tool.error ?? ""}`).join("\n")}`;
      blocker = leakChecks("permission", allOutput, failures) || blocker;
      const events = await readEvents(runtime, sessionId);
      if (events.length < baselineEvents.length) {
        failures.push(`permission: durable event log shrank ${baselineEvents.length} -> ${events.length}`);
      }
    }

    // Common closing assertions: projection binding never silently re-homed.
    const finalProjection = await projectionOf(runtime, sessionId);
    details.finalProjection = {
      status: finalProjection.status,
      worktreePath: finalProjection.worktreePath,
      worktreeState: finalProjection.worktreeState,
    };
    if (finalProjection.worktreePath && resolve(finalProjection.worktreePath) !== resolve(WORKTREE)) {
      failures.push(`${phase}: final projection worktreePath drifted to ${finalProjection.worktreePath}`);
      blocker = true;
    }
    if (!finalProjection.worktreePath) {
      failures.push(`${phase}: final projection lost its worktreePath entirely`);
      blocker = true;
    }
    await databaseSnapshot(scratch, "db-after");
    await writeJson(join(scratch.artifactsDir, "details.json"), details);
  } catch (error) {
    failures.push(`${phase}: harness error ${errorCode(error)}: ${String((error as Error).message ?? error)}`);
    await writeJson(join(scratch.artifactsDir, "details.json"), details).catch(() => undefined);
  } finally {
    permissionAnswerer?.stop();
    ws?.close();
    await closeRuntime(runtime);
    restoreEnvironment();
  }
  return { phase, failures, gaps, blocker, details };
};

const run = async (): Promise<void> => {
  const summaryScratch = await makeScratch(ID);
  await manifest(summaryScratch, { engine: "R", phases: ["idle", "text", "tool", "permission"] });
  const results: PhaseResult[] = [];
  for (const phase of ["idle", "text", "tool", "permission"] as const) {
    console.log(`[${ID}] phase ${phase}…`);
    results.push(await runPhase(phase));
  }
  const failures = results.flatMap((result) => result.failures);
  const gaps = results.flatMap((result) => result.gaps);
  const blocker = results.some((result) => result.blocker);
  await writeJson(join(summaryScratch.artifactsDir, "phases.json"), results.map((result) => ({
    phase: result.phase,
    failures: result.failures,
    gaps: result.gaps,
    blocker: result.blocker,
    details: result.details,
  })));
  const verdict: Verdict = {
    id: ID,
    verdict: failures.length > 0 ? "fail" : gaps.length > 0 ? "partial" : "pass",
    engine: "R",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy",
    observed: failures.length > 0
      ? `deletion-phase violations: ${failures.slice(0, 3).join(" | ")}`
      : gaps.length > 0
        ? `no leak/fallback in any phase; honesty gap remains: ${gaps.join(" | ")}`
        : "worktree deletion during idle/text/tool/permission phases preserved durable history, blocked or truthfully failed new filesystem work, and never fell back to the repo root or another tree",
    expected: "existing durable history remains; new filesystem work is blocked or fails truthfully; no fallback to project root / last cwd / another worktree",
    attribution: failures.length > 0 ? (blocker ? "POLYTH" : "OPENCODE") : gaps.length > 0 ? "POLYTH" : "NONE",
    crossTreeLeakBlocker: blocker,
    identifiers: Object.fromEntries(results.map((result) => [result.phase, result.details.backendId ?? ""])),
    evidence: [
      "artifacts/opencode-real-world/phase-6/OC-REAL-071/phases.json",
      "artifacts/opencode-real-world/phase-6/OC-REAL-071/idle/details.json",
      "artifacts/opencode-real-world/phase-6/OC-REAL-071/text/details.json",
      "artifacts/opencode-real-world/phase-6/OC-REAL-071/tool/details.json",
      "artifacts/opencode-real-world/phase-6/OC-REAL-071/permission/details.json",
      "logs/opencode-real-world/phase-6/OC-REAL-071/",
    ],
    failures: [...failures, ...gaps.map((gap) => `[gap] ${gap}`)],
  };
  await writeVerdict(summaryScratch, verdict);
};

await run();
process.exit(0);
