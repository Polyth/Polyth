import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_PROVIDERS, providerById } from "../src/providers.ts";
import { clampViewport } from "../src/serverEntry.ts";

test("client viewport sizes are clamped before reaching Chromium", () => {
  assert.deepEqual(clampViewport(900, 640), { width: 900, height: 640 });
  assert.deepEqual(clampViewport(10, 10), { width: 320, height: 240 });
  assert.deepEqual(clampViewport(99999, 99999), { width: 4096, height: 4096 });
  assert.deepEqual(clampViewport("abc", undefined), { width: 1280, height: 800 });
  assert.deepEqual(clampViewport(1000.6, 500.4), { width: 1001, height: 500 });
});

test("provider catalog includes major chats and custom", () => {
  assert.ok(providerById("chatgpt"));
  assert.ok(providerById("claude"));
  assert.ok(providerById("custom"));
  assert.equal(CHAT_PROVIDERS.length, 9);
});
