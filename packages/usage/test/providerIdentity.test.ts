import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import {
  canonicalProviderId,
  displayProvider,
  isPlaceholderProviderId,
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
  assert.equal(resolveSessionUsageProviderId(session()), undefined);
});

test("usage labels never surface default as a provider name", () => {
  assert.equal(providerUsageLabel("anthropic"), "Claude");
  assert.equal(providerUsageLabel("default"), "");
  assert.equal(displayProvider("openrouter"), "OpenRouter");
});
