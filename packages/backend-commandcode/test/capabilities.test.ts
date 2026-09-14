import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDCODE_CAPABILITIES } from "../src/runtime.ts";
import { createCommandCodeTranslateState, translateCommandCodeRecord } from "../src/protocol.ts";

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
