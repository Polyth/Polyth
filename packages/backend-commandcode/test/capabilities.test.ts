import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDCODE_BRIDGE_SOURCE } from "../src/bridgeSource.ts";
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
  assert.equal(COMMANDCODE_CAPABILITIES.questions, true);
  assert.equal(COMMANDCODE_CAPABILITIES.contextOccupancy, "unknown");

  assert.equal(COMMANDCODE_CAPABILITIES.permissions, false);
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
  assert.match(COMMANDCODE_WORKER_SOURCE, /"--tools-enable", "todo_write,ask_user_question"/);
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

test("resuming Command Code receives the latest canonical Polyth title", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /POLYTH_COMMANDCODE_TITLE: message\.title \|\| ""/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /POLYTH_COMMANDCODE_TITLE: message\.nativeSessionId \?/);
});

test("worker diagnostics are redacted before crossing the worker IPC boundary", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /\$1\[redacted\]/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /authorization\|cookie\|credential\|password\|secret\|token\|api/);
});

test("native ask_user_question is intercepted before headless auto-answer", () => {
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /beforeToolCall/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /toolName !== "ask_user_question"/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /await waitForQuestionAnswer/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /persistMutationReceipt\(operationId, mutationKind, requestId\)/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /pending\.resolve\(answer\)/);
  assert.ok(
    COMMANDCODE_BRIDGE_SOURCE.indexOf("persistMutationReceipt(operationId, mutationKind, requestId)")
      < COMMANDCODE_BRIDGE_SOURCE.indexOf("pending.resolve(answer)"),
    "question response must be durably receipted before the Mod hook is released",
  );
});

test("Command Code question schema is normalized at the adapter boundary", () => {
  const state = createCommandCodeTranslateState("turn-question");
  assert.deepEqual(
    translateCommandCodeRecord({
      type: "event",
      event: {
        type: "tool_queued",
        toolCallId: "ask-1",
        toolName: "ask_user_question",
        input: {
          questions: [
            {
              question: "Which framework?",
              header: "Framework",
              options: [
                { label: "React", description: "Use React" },
                { label: "Vue", description: "Use Vue" },
              ],
              multiSelect: false,
            },
            {
              question: "Which extras?",
              header: "Extras",
              options: [{ label: "Tests" }, { label: "Docs" }],
              multiSelect: true,
            },
          ],
        },
      },
    }, state),
    [{
      type: "question/asked",
      requestId: "ask-1",
      questions: [
        {
          id: "q1",
          title: "Framework",
          prompt: "Which framework?",
          type: "single",
          options: [
            { value: "React", label: "React", description: "Use React" },
            { value: "Vue", label: "Vue", description: "Use Vue" },
          ],
          required: true,
          allowOther: true,
        },
        {
          id: "q2",
          title: "Extras",
          prompt: "Which extras?",
          type: "multi",
          options: [{ value: "Tests", label: "Tests" }, { value: "Docs", label: "Docs" }],
          required: true,
          allowOther: true,
        },
      ],
    }],
  );
  assert.deepEqual(
    translateCommandCodeRecord({
      type: "event",
      event: { type: "tool_hook_blocked", toolCallId: "ask-1", toolName: "ask_user_question", hookOutput: "answered" },
    }, state),
    [],
  );
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

test("model request usage is recorded without pretending it is context occupancy", () => {
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
  assert.equal(events.some((event) => event.type === "context/updated"), false);
  const usage = events.find((event) => event.type === "usage/recorded");
  assert.equal(usage?.type, "usage/recorded");
  if (usage?.type === "usage/recorded") {
    assert.equal(usage.tokens.input, 82_000);
    assert.equal(usage.tokens.output, 1_200);
  }
});

test("missing native input usage is not misreported as zero context occupancy", () => {
  const state = createCommandCodeTranslateState("turn-output-only", {
    providerID: "anthropic",
    modelID: "anthropic/claude-sonnet-4-5",
  });
  const events = translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_end", usage: { output_tokens: 77 } },
  }, state);
  assert.equal(events.some((event) => event.type === "context/updated"), false);
  assert.equal(events.some((event) => event.type === "usage/recorded"), true);
});

test("compaction events report only unknown context state", () => {
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
