import assert from "node:assert/strict";
import test from "node:test";
import { createCommandCodeTranslateState, translateCommandCodeRecord } from "../src/protocol.ts";

test("final-result usage fallback belongs to the latest active model round", () => {
  const state = createCommandCodeTranslateState("turn-fallback", {
    providerID: "moonshotai",
    modelID: "moonshotai/kimi-k2.5",
  });

  translateCommandCodeRecord({
    type: "event",
    event: { type: "model_request_start", model: "openai/gpt-5.5" },
  }, state);

  const events = translateCommandCodeRecord({
    type: "result",
    subtype: "success",
    finalText: "Done",
    usage: { input: 12, output: 3 },
  }, state);

  assert.deepEqual(events, [
    {
      type: "assistant/message",
      partId: "turn-fallback:answer",
      text: "Done",
      tokens: { input: 12, output: 3 },
    },
    {
      type: "usage/recorded",
      model: { providerID: "openai", modelID: "openai/gpt-5.5" },
      tokens: { input: 12, output: 3 },
    },
  ]);
});

test("assistant message token metadata does not replace the dedicated usage event", () => {
  const state = createCommandCodeTranslateState("turn-accounting", {
    providerID: "openai",
    modelID: "openai/gpt-5.5",
  });
  const events = translateCommandCodeRecord({
    type: "result",
    subtype: "success",
    finalText: "Done",
    usage: { input: 4, output: 2 },
  }, state);
  assert.equal(events.filter((event) => event.type === "usage/recorded").length, 1);
  assert.equal(events.filter((event) => event.type === "assistant/message").length, 1);
});
