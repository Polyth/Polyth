import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCodeTranslateState, translateCommandCodeRecord } from "../src/protocol.ts";

test("Command Code maps streaming, title, tools, usage, compaction and subagents", () => {
  const state = createCommandCodeTranslateState("turn-1", { providerID: "moonshotai", modelID: "moonshotai/Kimi-K3" });
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "turn_start" } }, state), [
    { type: "turn/started", turnId: "turn-1", model: { providerID: "moonshotai", modelID: "moonshotai/Kimi-K3" } },
  ]);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "text_delta", delta: "Hello" } }, state), [
    { type: "assistant/chunk", partId: "turn-1:answer", text: "Hello" },
  ]);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "session_titled", title: "Native title" } }, state), [
    { type: "session/title-generated", title: "Native title" },
  ]);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "tool_queued", toolCallId: "t1", toolName: "read_file", input: { file_path: "a.ts" } },
  }, state), []);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "tool_running", toolCallId: "t1", description: "Read a.ts" },
  }, state), [{ type: "tool/started", callId: "t1", tool: "read_file", input: { file_path: "a.ts" } }]);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_end", usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2 }, cost: 123 },
  }, state), [{
    type: "usage/recorded",
    model: { providerID: "moonshotai", modelID: "moonshotai/Kimi-K3" },
    tokens: { input: 10, output: 5, reasoning: 2 },
  }]);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "compaction_done", tokensSaved: 2000 } }, state), [
    { type: "session/compacted" },
  ]);
  const subagent = translateCommandCodeRecord({
    type: "event",
    event: { type: "subagent_start", toolCallId: "a1", subagentType: "explore" },
  }, state);
  assert.equal(subagent[0]?.type, "subagent/snapshot");
});

test("Command Code todo_write produces revisioned Polyth task snapshots from original queued input", () => {
  const state = createCommandCodeTranslateState("turn-todos");
  const queued = {
    type: "event",
    event: {
      type: "tool_queued",
      toolCallId: "todo-1",
      toolName: "todo_write",
      input: {
        todos: [
          { id: "a", content: "Inspect parser", status: "completed", activeForm: "Inspecting parser" },
          { id: "b", content: "Fix parser", status: "in_progress", activeForm: "Fixing parser" },
          { content: "Run tests", status: "pending", activeForm: "Running tests" },
        ],
      },
    },
  };
  assert.deepEqual(translateCommandCodeRecord(queued, state), [{
    type: "task/snapshot",
    listId: "todo",
    revision: 1,
    items: [
      { id: "a", text: "Inspect parser", status: "done" },
      { id: "b", text: "Fix parser", status: "active" },
      { id: "commandcode-todo:2:Run tests", text: "Run tests", status: "pending" },
    ],
  }]);
  assert.deepEqual(translateCommandCodeRecord(queued, state), []);

  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "tool_queued", toolCallId: "todo-2", toolName: "todo_write", input: { todos: [] } },
  }, state), [{ type: "task/snapshot", listId: "todo", revision: 2, items: [] }]);
});

test("placeholder native titles never replace a useful canonical title", () => {
  const state = createCommandCodeTranslateState("turn-title");
  for (const title of ["New session", "Untitled", "Command Code session", "   "]) {
    assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "session_titled", title } }, state), []);
  }
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "session_titled", title: "Fix flaky reconnect" } }, state), [
    { type: "session/title-generated", title: "Fix flaky reconnect" },
  ]);
});

test("Command Code private thinking never enters canonical events", () => {
  const state = createCommandCodeTranslateState("turn-private");
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "thinking_start" } }, state), []);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "thinking_delta", delta: "private chain" } }, state), []);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "thinking_end" } }, state), []);

  const events = translateCommandCodeRecord({
    type: "event",
    event: { type: "message_end", message: { content: [{ type: "text", text: "Public answer" }] } },
  }, state);
  assert.deepEqual(events, [{ type: "assistant/message", partId: "turn-private:answer", text: "Public answer" }]);
  assert.equal("reasoning" in (events[0] ?? {}), false);
});

test("run terminal events become control evidence without entering canonical history", () => {
  const state = createCommandCodeTranslateState("turn-control");
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "run_error", error: { message: "provider failed" } },
  }, state), []);
  assert.equal(state.runError, "provider failed");
  assert.equal(state.interrupted, false);

  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "interrupted" } }, state), []);
  assert.equal(state.interrupted, true);
});

test("undocumented native cost fields never become canonical cost telemetry", () => {
  const state = createCommandCodeTranslateState("turn-cost", { providerID: "command-code", modelID: "model" });
  const usage = translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_end", usage: { input: 2, output: 1, cost: 42 }, cost: 42 },
  }, state);
  assert.deepEqual(usage, [{
    type: "usage/recorded",
    model: { providerID: "command-code", modelID: "model" },
    tokens: { input: 2, output: 1 },
  }]);
  assert.equal("cost" in (usage[0] ?? {}), false);

  const fallback = translateCommandCodeRecord({
    type: "result",
    subtype: "success",
    finalText: "Done",
    usage: { input: 2, output: 1, cost: 42 },
    cost: 42,
  }, createCommandCodeTranslateState("turn-cost-result"));
  assert.equal("cost" in (fallback[0] ?? {}), false);
});

test("Command Code final result is a fallback answer only when streaming produced no text", () => {
  const state = createCommandCodeTranslateState("turn-2");
  assert.deepEqual(translateCommandCodeRecord({ type: "result", subtype: "success", finalText: "Done" }, state), [
    { type: "assistant/message", partId: "turn-2:final", text: "Done" },
  ]);
  const streamed = createCommandCodeTranslateState("turn-3");
  translateCommandCodeRecord({ type: "event", event: { type: "text_delta", delta: "Done" } }, streamed);
  assert.deepEqual(translateCommandCodeRecord({ type: "result", subtype: "success", finalText: "Done" }, streamed), []);
});
