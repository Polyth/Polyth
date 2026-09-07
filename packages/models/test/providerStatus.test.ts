import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveProviderStatus, filterProviderModels } from "../src/providerStatus.ts";

test("enabled is distinct from connection: disabled wins even if connected", () => {
  assert.equal(deriveProviderStatus({
    enabled: false,
    configured: true,
    hasCredential: true,
    connected: true,
  }), "disabled");
});

test("environment/runtime auth without a Polyth-owned key is Ready", () => {
  assert.equal(deriveProviderStatus({
    enabled: true,
    configured: true,
    hasCredential: false,
    connected: true,
  }), "ready");
});

test("configured without credential or models needs setup, not a connected badge", () => {
  assert.equal(deriveProviderStatus({
    enabled: true,
    configured: true,
    hasCredential: false,
    connected: false,
  }), "needs-setup");
});

test("no-auth custom endpoint is Ready when enabled", () => {
  assert.equal(deriveProviderStatus({
    enabled: true,
    configured: true,
    hasCredential: false,
    connected: false,
    authRequired: false,
  }), "ready");
});

test("known API-key custom provider without a stored key needs setup even with models", () => {
  assert.equal(deriveProviderStatus({
    enabled: true,
    configured: true,
    hasCredential: false,
    connected: false,
    authRequired: true,
  }), "needs-setup");
});

test("OpenRouter with a disconnected catalogue is not Ready from model count", () => {
  assert.equal(deriveProviderStatus({
    enabled: true,
    configured: true,
    hasCredential: false,
    connected: false,
  }), "needs-setup");
});

test("catalog status has no Error path — runtime failures are not persisted", () => {
  assert.equal(deriveProviderStatus({
    enabled: true,
    configured: true,
    hasCredential: true,
    connected: false,
  }), "ready");
});

test("filterProviderModels is local: only matching models of this list", () => {
  const models = [
    { name: "GPT-4o", key: "openai/gpt-4o" },
    { name: "Claude", key: "anthropic/claude" },
  ];
  const filtered = filterProviderModels(models, "gpt");
  assert.deepEqual(filtered.map((m) => m.key), ["openai/gpt-4o"]);
});
