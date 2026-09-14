import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCodeTranslateState, translateCommandCodeRecord } from "../src/protocol.ts";
import { COMMANDCODE_CAPABILITIES } from "../src/runtime.ts";
import { COMMANDCODE_WORKER_SOURCE } from "../src/workerSource.ts";

test("Command Code advertises only the native surfaces Polyth actually integrates", () => {
  assert.equal(COMMANDCODE_CAPABILITIES.streaming, true);
  assert.equal(COMMANDCODE_CAPABILITIES.steering, true);
  assert.equal(COMMANDCODE_CAPABILITIES.resume, true);
  assert.equal(COMMANDCODE_CAPABILITIES.usage, true);
  assert.equal(COMMANDCODE_CAPABILITIES.subagents, true);
  assert.equal(COMMANDCODE_CAPABILITIES.mcp, true);
  assert.equal(COMMANDCODE_CAPABILITIES.contextOccupancy, "native");

  assert.equal(COMMANDCODE_CAPABILITIES.permissions, false);
  assert.equal(COMMANDCODE_CAPABILITIES.questions, false);
  assert.equal(COMMANDCODE_CAPABILITIES.compaction, false);
  assert.equal(COMMANDCODE_CAPABILITIES.fork, false);
  assert.equal(COMMANDCODE_CAPABILITIES.cost, false);
  assert.deepEqual(COMMANDCODE_CAPABILITIES.commands, {
    discovery: "unsupported",
    invoke: "unsupported",
  });
});

test("Command Code headless launch stays explicit, exact-resume and fail-closed", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /"-p"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /"--output-format", "json"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /"--skip-onboarding"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /"--no-auto-update"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /"--tools-enable", "todo_write"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /args\.push\("--resume", message\.nativeSessionId\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /"--permission-mode", permissionMode/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /--yolo|--dangerously-skip-permissions/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /--trust/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /--continue/);
});

test("Command Code admission waits for the exact current turn receipt, not a stale resumed session id", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /acceptedMutations/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /entry\?\.operationId === operationId && entry\?\.mutationKind === "turn-submit"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /waitForTurnAdmission\([\s\S]*message\.operationId/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /const readNativeSessionId/);
});

test("Command Code worker emits terminal evidence only after admission or observed native run evidence", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /if \(admission \|\| turn\.runObserved\)/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /eventType === "run_start" \|\| eventType === "turn_start"/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /!turn\.runObserved && !durableAdmission/);
});

test("resuming Command Code never replays a stale adapter binding title into native state", () => {
  assert.match(
    COMMANDCODE_WORKER_SOURCE,
    /POLYTH_COMMANDCODE_TITLE: message\.nativeSessionId \? "" : \(message\.title \|\| ""\)/,
  );
});

test("worker diagnostics are redacted before crossing the worker IPC boundary", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /\$1\[redacted\]/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /authorization\|cookie\|credential\|password\|secret\|token\|api/);
});

test("subagent capability is backed by native AgentEvent snapshots", () => {
  const state = createCommandCodeTranslateState("turn-subagent");
  assert.deepEqual(
    translateCommandCodeRecord({
      type: "event",
      event: { type: "subagent_start", toolCallId: "child-1", subagentType: "explore" },
    }, state),
    [{
      type: "subagent/snapshot",
      revision: 1,
      agents: [{ sessionId: "child-1", label: "explore", status: "running" }],
    }],
  );
  assert.deepEqual(
    translateCommandCodeRecord({
      type: "event",
      event: { type: "subagent_progress", toolCallId: "child-1", subagentType: "explore", toolName: "read" },
    }, state),
    [{
      type: "subagent/snapshot",
      revision: 2,
      agents: [{ sessionId: "child-1", label: "explore", status: "running", currentTask: "read" }],
    }],
  );
  assert.deepEqual(
    translateCommandCodeRecord({
      type: "event",
      event: { type: "subagent_stop", toolCallId: "child-1", subagentType: "explore" },
    }, state),
    [{
      type: "subagent/snapshot",
      revision: 3,
      agents: [{ sessionId: "child-1", label: "explore", status: "completed" }],
    }],
  );
});

test("model request usage also reports native context occupancy without inventing a limit", () => {
  const state = createCommandCodeTranslateState("turn-context", {
    providerID: "anthropic",
    modelID: "anthropic/claude-sonnet-4-5",
  });
  const events = translateCommandCodeRecord({
    type: "event",
    event: {
      type: "model_request_end",
      model: "anthropic/claude-sonnet-4-5",
      usage: { input_tokens: 82_000, output_tokens: 1_200 },
    },
  }, state);
  const context = events.find((event) => event.type === "context/updated");
  assert.equal(context?.type, "context/updated");
  if (context?.type === "context/updated") {
    assert.equal(context.source, "native");
    assert.equal(context.usedTokens, 82_000);
    assert.equal(context.limitTokens, undefined);
  }
});

test("compaction events invalidate stale occupancy until the next native request", () => {
  const state = createCommandCodeTranslateState("turn-compact");
  const started = translateCommandCodeRecord({ type: "event", event: { type: "compaction_start" } }, state);
  assert.equal(started[0]?.type, "context/updated");
  if (started[0]?.type === "context/updated") assert.equal(started[0].compaction?.active, true);

  const done = translateCommandCodeRecord({ type: "event", event: { type: "compaction_done", tokensSaved: 41_300 } }, state);
  assert.equal(done[0]?.type, "session/compacted");
  assert.equal(done[1]?.type, "context/updated");
  if (done[1]?.type === "context/updated") {
    assert.equal(done[1].source, "unknown");
    assert.equal(done[1].compaction?.active, false);
    assert.equal(typeof done[1].compaction?.lastAt, "number");
  }
});
