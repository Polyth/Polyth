import test from "node:test";
import assert from "node:assert/strict";
import type { ModelDescriptor } from "@polyth/contracts";
import {
  displayModelName,
  friendlyModelId,
  presentModelDescriptor,
  resolveModelPresentation,
} from "../src/modelPresentation.ts";

test("technical runtime model ids become concise human labels", () => {
  assert.equal(friendlyModelId("gpt-5-6-luna"), "GPT-5.6 Luna");
  assert.equal(friendlyModelId("openai/gpt-5-6-codex-max"), "GPT-5.6 Codex Max");
  assert.equal(friendlyModelId("claude-opus-4-1-20250805"), "Claude Opus 4.1");
  assert.equal(friendlyModelId("claude-sonnet-4-5-20250929"), "Claude Sonnet 4.5");
  assert.equal(friendlyModelId("gemini-2-5-pro"), "Gemini 2.5 Pro");
  assert.equal(friendlyModelId("gemini-2-5-flash"), "Gemini 2.5 Flash");
  assert.equal(friendlyModelId("deepseek-v3-2"), "DeepSeek V3.2");
  assert.equal(friendlyModelId("qwen3-coder"), "Qwen3 Coder");
  assert.equal(friendlyModelId("kimi-k2-5"), "Kimi K2.5");
  assert.equal(friendlyModelId("glm-4-7"), "GLM 4.7");
  assert.equal(friendlyModelId("auto"), "Auto");
  assert.equal(friendlyModelId("default"), "Auto");
});

test("presentation preserves genuine provider-authored names", () => {
  const named = {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 · 1M",
  } as ModelDescriptor;
  assert.equal(displayModelName(named), "Claude Sonnet 4.5 · 1M");
  assert.equal(presentModelDescriptor(named), named);

  const technical = {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    name: "anthropic/claude-sonnet-4-5",
  } as ModelDescriptor;
  assert.equal(presentModelDescriptor(technical).name, "Claude Sonnet 4.5");
});

test("runtime model presentation is harness-qualified and never echoes technical ids", () => {
  const catalog = [
    { harnessId: "codex", providerID: "openai", modelID: "shared", name: "GPT Codex" },
    { harnessId: "opencode", providerID: "openai", modelID: "shared", name: "OpenRouter Friendly" },
    { harnessId: "claude", providerID: "anthropic", modelID: "claude-sonnet-4-5", name: "claude-sonnet-4-5" },
  ] as ModelDescriptor[];

  assert.equal(resolveModelPresentation({ providerID: "openai", modelID: "shared" }, catalog, "opencode").name, "OpenRouter Friendly");
  assert.equal(resolveModelPresentation({ providerID: "anthropic", modelID: "claude-sonnet-4-5" }, catalog, "claude").name, "Claude Sonnet 4.5");
  assert.equal(resolveModelPresentation({ providerID: "x-ai", modelID: "grok-4-fast" }, catalog, "opencode").name, "Grok 4 Fast");
});
