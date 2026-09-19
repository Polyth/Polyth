import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import {
  canonicalProviderId,
  displayProvider,
  isPlaceholderProviderId,
  isProviderHidden,
  providerPreferenceKey,
  providerUsageLabel,
  resolveSessionUsageProviderId,
} from "../widgets/providerIdentity.ts";

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

test("resolveSessionUsageProviderId prefers the session model over harness fallback", () => {
  assert.equal(
    resolveSessionUsageProviderId(session({ providerID: "openai", modelID: "gpt" })),
    "openai",
  );
  assert.equal(
    resolveSessionUsageProviderId(session(
      { providerID: "default", modelID: "sonnet" },
      "claude",
    )),
    "anthropic",
  );
  assert.equal(
    resolveSessionUsageProviderId(session(undefined, "codex")),
    "openai",
  );
  assert.equal(
    resolveSessionUsageProviderId(session({ providerID: "antigravity", modelID: "gemini-3.8-flash-high" })),
    "antigravity",
  );
  assert.equal(
    resolveSessionUsageProviderId(session(undefined, "antigravity")),
    "antigravity",
  );
  assert.equal(resolveSessionUsageProviderId(session()), undefined);
});

test("usage labels never surface default as a provider name", () => {
  assert.equal(providerUsageLabel("anthropic"), "Claude");
  assert.equal(providerUsageLabel("default"), "");
  assert.equal(displayProvider("openrouter"), "OpenRouter");
  assert.equal(displayProvider("antigravity"), "Antigravity");
  assert.equal(providerUsageLabel("antigravity"), "Antigravity");
});

test("provider preference keys canonicalize aliases across Usage surfaces", () => {
  assert.equal(providerPreferenceKey("claude"), "anthropic");
  assert.equal(providerPreferenceKey("anthropic"), "anthropic");
  assert.equal(providerPreferenceKey("codex"), "openai");
  assert.equal(providerPreferenceKey("chatgpt"), "openai");
  assert.equal(providerPreferenceKey("gemini"), "google");
  assert.equal(providerPreferenceKey("github-copilot-addon"), "github-copilot");
  assert.equal(providerPreferenceKey(" openrouter "), "openrouter");
});

// Regression: the dashboard provider card stores the canonical provider id
// while quota snapshots carry the raw provider id (claude, codex). Hiding on
// the card must hide the provider from the usage widgets too.
test("a hide stored under one provider alias hides every alias spelling", () => {
  assert.equal(isProviderHidden(["anthropic"], "claude"), true);
  assert.equal(isProviderHidden(["claude"], "anthropic"), true);
  assert.equal(isProviderHidden(["openai"], "codex"), true);
  assert.equal(isProviderHidden(["gemini"], "google"), true);
  assert.equal(isProviderHidden(["anthropic"], "openai"), false);
  assert.equal(isProviderHidden([], "anthropic"), false);
  assert.equal(isProviderHidden(["anthropic"], " default "), false);
});
