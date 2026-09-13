import test from "node:test";
import assert from "node:assert/strict";
import type { ModelDescriptor } from "@polyth/contracts";
import {
  friendlyModelId,
  normalizeModelDescriptor,
  resolveModelPresentation,
} from "../src/modelPresentation.ts";

test("technical runtime model ids become concise human labels", () => {
  assert.equal(friendlyModelId("claude-opus-4-1-20250805"), "Claude Opus 4.1");
  assert.equal(friendlyModelId("openai/gpt-5-1-codex-max"), "GPT 5.1 Codex Max");
  assert.equal(friendlyModelId("qwen3-coder"), "Qwen3 Coder");
  assert.equal(friendlyModelId("deepseek-r1"), "DeepSeek R1");
  assert.equal(friendlyModelId("auto"), "Auto");
});

test("catalog normalization preserves real names and replaces wire ids", () => {
  const named = {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 · 1M",
  } as ModelDescriptor;
  assert.equal(normalizeModelDescriptor(named), named);

  const technical = {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    name: "anthropic/claude-sonnet-4-5",
  } as ModelDescriptor;
  assert.equal(normalizeModelDescriptor(technical).name, "Claude Sonnet 4.5");
});

test("runtime model presentation is harness-qualified and never echoes technical ids", () => {
  const catalog = [
    { harnessId: "codex", providerID: "openai", modelID: "shared", name: "GPT Codex" },
    { harnessId: "opencode", providerID: "openai", modelID: "shared", name: "OpenRouter Friendly" },
    { harnessId: "claude", providerID: "anthropic", modelID: "claude-sonnet-4-5", name: "claude-sonnet-4-5" },
  ] as ModelDescriptor[];

  assert.equal(
    resolveModelPresentation({ providerID: "openai", modelID: "shared" }, catalog, "opencode").name,
    "OpenRouter Friendly",
  );
  assert.equal(
    resolveModelPresentation({ providerID: "anthropic", modelID: "claude-sonnet-4-5" }, catalog, "claude").name,
    "Claude Sonnet 4.5",
  );
  assert.equal(
    resolveModelPresentation({ providerID: "x-ai", modelID: "grok-4-fast" }, catalog, "opencode").name,
    "Grok 4 Fast",
  );
});
