import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import {
  UNKNOWN_HARNESS_ID,
  canonicalHarnessId,
  canonicalProviderId,
  displayHarness,
  displayProvider,
  isPlaceholderProviderId,
  resolveSessionUsageProviderId,
} from "../src/providerIdentity.ts";

const session = (
  model?: SessionProjection["model"],
  resolvedHarnessId?: string,
): SessionProjection => ({
  id: "s",
  projectId: "p",
  title: "s",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...(model ? { model } : {}),
  ...(resolvedHarnessId ? { resolvedHarnessId } : {}),
});

test("placeholder provider ids are never treated as concrete providers", () => {
  for (const value of ["default", "Default", " DEFAULT ", "__default__", ""]) {
    assert.equal(isPlaceholderProviderId(value), true);
    assert.equal(canonicalProviderId(value), "");
    assert.equal(displayProvider(value), "");
  }
});

test("provider aliases normalize only for usage attribution", () => {
  assert.equal(canonicalProviderId("claude"), "anthropic");
  assert.equal(canonicalProviderId("claude-code"), "anthropic");
  assert.equal(canonicalProviderId("codex"), "openai");
  assert.equal(canonicalProviderId("chatgpt"), "openai");
  assert.equal(canonicalProviderId("gemini"), "google");
  assert.equal(canonicalProviderId("github-copilot-addon"), "github-copilot");
  assert.equal(displayProvider("anthropic"), "Claude");
  assert.equal(displayProvider("openrouter"), "OpenRouter");
});

test("harness ids normalize to one slug and a missing id is the explicit unknown bucket", () => {
  assert.equal(canonicalHarnessId("claude"), "claude");
  assert.equal(canonicalHarnessId("  Claude "), "claude");
  for (const value of [undefined, "", "   "]) assert.equal(canonicalHarnessId(value), UNKNOWN_HARNESS_ID);
  assert.equal(UNKNOWN_HARNESS_ID, "unknown");
});

test("harness display names follow the registered backends and fall back to the prettified id", () => {
  assert.equal(displayHarness("claude"), "Claude Code");
  assert.equal(displayHarness("Codex"), "Codex");
  assert.equal(displayHarness("opencode"), "OpenCode");
  assert.equal(displayHarness("commandcode"), "Command Code");
  assert.equal(displayHarness(UNKNOWN_HARNESS_ID), "Unknown harness");
  assert.equal(displayHarness(""), "Unknown harness");
  assert.equal(displayHarness("my-custom_harness"), "My Custom Harness");
});

test("session attribution prefers the concrete model provider then harness fallback", () => {
  assert.equal(
    resolveSessionUsageProviderId(session({ providerID: "openai", modelID: "gpt" })),
    "openai",
  );
  assert.equal(
    resolveSessionUsageProviderId(session({ providerID: "default", modelID: "sonnet" }, "claude")),
    "anthropic",
  );
  assert.equal(resolveSessionUsageProviderId(session(undefined, "codex")), "openai");
  assert.equal(resolveSessionUsageProviderId(session()), undefined);
});
