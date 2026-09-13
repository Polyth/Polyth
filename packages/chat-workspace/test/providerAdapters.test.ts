import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExternalChatHandoff,
  normalizeExternalChatText,
  providerAdapter,
  sanitizeExternalChatUrl,
} from "../src/providerAdapters.ts";

test("normalizes external response text without flattening structure", () => {
  assert.equal(
    normalizeExternalChatText("  answer  \r\n\r\n\r\n\r\n```ts\r\nconst x = 1;   \r\n```  "),
    "answer\n\n\n```ts\nconst x = 1;\n```",
  );
});

test("sanitizes external chat provenance urls", () => {
  assert.equal(
    sanitizeExternalChatUrl("https://claude.ai/chat/abc?token=secret&utm_source=test#fragment"),
    "https://claude.ai/chat/abc",
  );
  assert.equal(sanitizeExternalChatUrl("javascript:alert(1)"), undefined);
  assert.equal(sanitizeExternalChatUrl("not a url"), undefined);
});

test("builds explicit manual handoff provenance", () => {
  const handoff = buildExternalChatHandoff({
    providerId: "claude",
    providerName: "Claude",
    profileId: "profile-1",
    tabId: "tab-1",
    projectId: "project-1",
    url: "https://claude.ai/chat/abc?token=secret#fragment",
    scope: "response",
    text: "  useful answer  ",
    capturedAt: 42,
  });
  assert.equal(handoff.sourceKind, "external-llm-chat");
  assert.equal(handoff.text, "useful answer");
  assert.equal(handoff.url, "https://claude.ai/chat/abc");
  assert.equal(handoff.capturedAt, 42);
});

test("keeps brittle DOM knowledge isolated to provider adapters", () => {
  const chatgpt = providerAdapter("chatgpt");
  const claude = providerAdapter("claude");
  const custom = providerAdapter("custom");
  assert.ok(chatgpt?.assistantMessageSelectors.length);
  assert.ok(claude?.assistantMessageSelectors.length);
  assert.deepEqual(custom?.assistantMessageSelectors, []);
  assert.equal(providerAdapter("unknown"), null);
});
