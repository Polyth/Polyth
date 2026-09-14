import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCodeTranslateState, translateCommandCodeRecord } from "../src/protocol.ts";

test("one Command Code run maps many native rounds to one canonical turn with distinct assistant parts", () => {
  const state = createCommandCodeTranslateState("canonical-turn", {
    providerID: "moonshotai",
    modelID: "moonshotai/kimi-k2.5",
  });

  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "turn_start", turnNumber: 1 } }, state), [{
    type: "turn/started",
    turnId: "canonical-turn",
    model: { providerID: "moonshotai", modelID: "moonshotai/kimi-k2.5" },
  }]);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "message_start" } }, state), []);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_start", model: "moonshotai/kimi-k2.5" },
  }, state), []);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "text_delta", delta: "I'll inspect it." } }, state), [{
    type: "assistant/chunk",
    partId: "canonical-turn:answer",
    text: "I'll inspect it.",
  }]);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_end", model: "moonshotai/kimi-k2.5", usage: { input: 10, output: 4 } },
  }, state), [{
    type: "usage/recorded",
    model: { providerID: "moonshotai", modelID: "moonshotai/kimi-k2.5" },
    tokens: { input: 10, output: 4 },
  }]);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "message_end", message: { content: [{ type: "text", text: "I'll inspect it." }] } },
  }, state), [{
    type: "assistant/message",
    partId: "canonical-turn:answer",
    text: "I'll inspect it.",
  }]);

  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "tool_queued", toolCallId: "read-1", toolName: "read_file", input: { file_path: "/workspace/a.ts" } },
  }, state), []);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "tool_running", toolCallId: "read-1", toolName: "read_file" },
  }, state), [{
    type: "tool/started",
    callId: "read-1",
    tool: "read_file",
    input: { file_path: "/workspace/a.ts" },
  }]);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "tool_completed", toolCallId: "read-1", toolName: "read_file", result: "contents" },
  }, state), [{ type: "tool/result", callId: "read-1", tool: "read_file", output: "contents" }]);

  // Native turn_start is a model round boundary, not a new canonical user turn.
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "turn_start", turnNumber: 2 } }, state), []);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "message_start" } }, state), []);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_start", model: "openai/gpt-5.5" },
  }, state), []);
  assert.deepEqual(translateCommandCodeRecord({ type: "event", event: { type: "text_delta", delta: "Done." } }, state), [{
    type: "assistant/chunk",
    partId: "canonical-turn:answer:2",
    text: "Done.",
  }]);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_end", model: "openai/gpt-5.5", usage: { input: 20, output: 2 } },
  }, state), [{
    type: "usage/recorded",
    model: { providerID: "openai", modelID: "openai/gpt-5.5" },
    tokens: { input: 20, output: 2 },
  }]);
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "message_end", message: { content: [{ type: "text", text: "Done." }] } },
  }, state), [{
    type: "assistant/message",
    partId: "canonical-turn:answer:2",
    text: "Done.",
  }]);

  // A duplicated message_end or final result must not duplicate the final part.
  assert.deepEqual(translateCommandCodeRecord({
    type: "event",
    event: { type: "message_end", message: { content: [{ type: "text", text: "Done." }] } },
  }, state), []);
  assert.deepEqual(translateCommandCodeRecord({
    type: "result",
    subtype: "success",
    finalText: "Done.",
    usage: { input: 30, output: 6 },
  }, state), []);
});
