import test from "node:test";
import assert from "node:assert/strict";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => void mem.set(key, value),
  removeItem: (key: string) => void mem.delete(key),
};

const {
  THINKING_PREFS_KEY,
  getModelThinking,
  setModelThinking,
} = await import("../src/thinkingPrefs.ts");
const { accountStorageKey } = await import("../src/accountStorage.ts");

test("thinking effort saves immediately and independently for each model", () => {
  mem.clear();
  const gpt = { providerID: "openai", modelID: "gpt-5" };
  const claude = { providerID: "anthropic", modelID: "claude-4" };

  setModelThinking(gpt, "high");
  setModelThinking(claude, "low");
  assert.equal(getModelThinking(gpt), "high");
  assert.equal(getModelThinking(claude), "low");
  assert.equal(mem.get(accountStorageKey(THINKING_PREFS_KEY)), '{"local/anthropic/claude-4":"low","local/openai/gpt-5":"high"}');
  assert.equal(mem.has(THINKING_PREFS_KEY), false, "reasoning preferences must not leak into unscoped storage");

  setModelThinking(gpt, undefined);
  assert.equal(getModelThinking(gpt), undefined);
  assert.equal(getModelThinking(claude), "low");
});

test("identical provider/model ids keep independent thinking per harness", () => {
  mem.clear();
  const left = { harnessId: "claude", providerID: "shared", modelID: "same" };
  const right = { harnessId: "acp", providerID: "shared", modelID: "same" };
  setModelThinking(left, "high");
  setModelThinking(right, "low");
  assert.equal(getModelThinking(left), "high");
  assert.equal(getModelThinking(right), "low");
});
