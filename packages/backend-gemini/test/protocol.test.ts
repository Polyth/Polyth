import assert from "node:assert/strict";
import { test } from "node:test";
import {
  translateGeminiPromptError,
  translateGeminiPromptResult,
} from "../src/protocol.ts";

test("Gemini ACP model usage becomes canonical usage records", () => {
  const result = translateGeminiPromptResult({
    stopReason: "end_turn",
    _meta: {
      quota: {
        token_count: { input_tokens: 130, output_tokens: 31 },
        model_usage: [
          { model: "gemini-3.1-pro-preview", token_count: { input_tokens: 100, output_tokens: 20 } },
          { model: "gemini-3-flash", token_count: { input_tokens: 30, output_tokens: 11 } },
        ],
      },
    },
  }, {
    turnId: "turn-a",
    hadToolActivity: false,
    model: { providerID: "gemini", modelID: "gemini-3.1-pro-preview" },
  });

  assert.deepEqual(result?.events, [
    {
      type: "usage/recorded",
      model: { providerID: "google", modelID: "gemini-3.1-pro-preview" },
      tokens: { input: 100, output: 20 },
    },
    {
      type: "usage/recorded",
      model: { providerID: "google", modelID: "gemini-3-flash" },
      tokens: { input: 30, output: 11 },
    },
  ]);
});

test("Gemini ACP total token count is retained when per-model usage is absent", () => {
  const result = translateGeminiPromptResult({
    stopReason: "end_turn",
    _meta: {
      quota: {
        token_count: { input_tokens: 90, output_tokens: 12 },
        model_usage: [],
      },
    },
  }, {
    turnId: "turn-a",
    hadToolActivity: false,
    model: { providerID: "gemini", modelID: "gemini-3.1-pro-preview" },
  });

  assert.deepEqual(result?.events, [{
    type: "usage/recorded",
    model: { providerID: "google", modelID: "gemini-3.1-pro-preview" },
    tokens: { input: 90, output: 12 },
  }]);
});

test("zero-only Gemini ACP command metadata does not create fake usage", () => {
  const result = translateGeminiPromptResult({
    stopReason: "end_turn",
    _meta: { quota: { token_count: { input_tokens: 0, output_tokens: 0 }, model_usage: [] } },
  }, { turnId: "turn-a", hadToolActivity: false });
  assert.equal(result, undefined);
});

test("Gemini ACP 429 becomes a durable Google rate-limit retry hint", () => {
  assert.deepEqual(translateGeminiPromptError({
    code: "runtime-rejected",
    rpcCode: 429,
    remoteMessage: "Rate limit exceeded. Try again later.",
  }, { turnId: "turn-a", hadToolActivity: false }), {
    admitted: true,
    error: "Gemini rate limit reached",
    code: "rate-limited",
    retry: { scope: "rate", provider: "google", resumeMode: "replay" },
  });
});

test("Gemini rate-limit retry continues instead of replaying after native tool activity", () => {
  assert.deepEqual(translateGeminiPromptError({
    code: "runtime-rejected",
    rpcCode: 429,
    remoteMessage: "Rate limit exceeded. Try again later.",
  }, { turnId: "turn-a", hadToolActivity: true }), {
    admitted: true,
    error: "Gemini rate limit reached",
    code: "rate-limited",
    retry: { scope: "rate", provider: "google", resumeMode: "continue" },
  });
});

test("Gemini adapter does not guess semantics for unrelated ACP failures", () => {
  assert.equal(translateGeminiPromptError({
    code: "runtime-rejected",
    rpcCode: 500,
    remoteMessage: "Internal error",
  }, { turnId: "turn-a", hadToolActivity: false }), undefined);
});


test("Gemini max_tokens is terminal failure, not a fake completed turn", () => {
  assert.deepEqual(translateGeminiPromptResult({
    stopReason: "max_tokens",
    _meta: { quota: { token_count: { input_tokens: 0, output_tokens: 0 }, model_usage: [] } },
  }, { turnId: "turn-a", hadToolActivity: false }), {
    terminal: {
      reason: "error",
      error: "Gemini stopped because the context/token limit was reached",
      code: "unknown",
    },
  });
});

test("Gemini max_turn_requests is terminal failure, not a fake completed turn", () => {
  assert.deepEqual(translateGeminiPromptResult({
    stopReason: "max_turn_requests",
    _meta: { quota: { token_count: { input_tokens: 0, output_tokens: 0 }, model_usage: [] } },
  }, { turnId: "turn-a", hadToolActivity: false }), {
    terminal: {
      reason: "error",
      error: "Gemini stopped after reaching its agent-loop turn limit",
      code: "unknown",
    },
  });
});
