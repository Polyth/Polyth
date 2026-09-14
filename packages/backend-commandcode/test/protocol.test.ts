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
    event: { type: "tool_running", toolCallId: "t1", toolName: "read", input: { path: "a.ts" } },
  }, state), [{ type: "tool/started", callId: "t1", tool: "read", input: { path: "a.ts" } }]);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_end", usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2 } },
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

test("Command Code final result is a fallback answer only when streaming produced no text", () => {
  const state = createCommandCodeTranslateState("turn-2");
  assert.deepEqual(translateCommandCodeRecord({ type: "result", subtype: "success", finalText: "Done" }, state), [
    { type: "assistant/message", partId: "turn-2:final", text: "Done" },
  ]);
  const streamed = createCommandCodeTranslateState("turn-3");
  translateCommandCodeRecord({ type: "event", event: { type: "text_delta", delta: "Done" } }, streamed);
  assert.deepEqual(translateCommandCodeRecord({ type: "result", subtype: "success", finalText: "Done" }, streamed), []);
});
