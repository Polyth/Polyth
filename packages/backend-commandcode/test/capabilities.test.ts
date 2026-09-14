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

  assert.equal(COMMANDCODE_CAPABILITIES.permissions, false);
  assert.equal(COMMANDCODE_CAPABILITIES.questions, false);
  assert.equal(COMMANDCODE_CAPABILITIES.compaction, false);
  assert.equal(COMMANDCODE_CAPABILITIES.fork, false);
  assert.equal(COMMANDCODE_CAPABILITIES.cost, false);
  assert.equal(COMMANDCODE_CAPABILITIES.contextOccupancy, "unknown");
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
