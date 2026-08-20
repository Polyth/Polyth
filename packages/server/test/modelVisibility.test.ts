// Provider/model visibility: parsing, filtering, catalog grouping, seeding
// from opencode.json, and the mirror-back on toggles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDescriptor } from "@polyth/contracts";
import {
  blacklistsOf,
  buildProviderCatalog,
  createModelVisibilityService,
  filterVisibleModels,
  parseVisibility,
  visibilityFromBackendConfig,
} from "../src/modelVisibility.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-vis-"));

const MODELS: ModelDescriptor[] = [
  { providerID: "openai", providerName: "OpenAI", modelID: "gpt-x", name: "GPT X", connected: true },
  { providerID: "openai", providerName: "OpenAI", modelID: "gpt-mini", name: "GPT Mini", connected: true },
  { providerID: "anthropic", providerName: "Anthropic", modelID: "claude", name: "Claude", connected: true },
  { providerID: "ollama", modelID: "llama", name: "Llama", connected: false },
];

test("parseVisibility survives garbage and dedupes", () => {
  assert.deepEqual(parseVisibility(null), { disabledProviders: [], disabledModels: [] });
  assert.deepEqual(parseVisibility("nope"), { disabledProviders: [], disabledModels: [] });
  assert.deepEqual(
    parseVisibility({ disabledProviders: ["b", "a", "b", 7, ""], disabledModels: ["p/m", "p/m"] }),
    { disabledProviders: ["a", "b"], disabledModels: ["p/m"] },
  );
});

test("visibilityFromBackendConfig reads disabled_providers and provider blacklists", () => {
  const v = visibilityFromBackendConfig({
    disabled_providers: ["ollama"],
    provider: {
      openai: { apiKey: "sk", blacklist: ["gpt-mini"] },
      anthropic: { baseURL: "https://x" },
    },
  });
  assert.deepEqual(v, { disabledProviders: ["ollama"], disabledModels: ["openai/gpt-mini"] });
  assert.deepEqual(visibilityFromBackendConfig({}), { disabledProviders: [], disabledModels: [] });
});

test("filterVisibleModels hides disabled + disconnected by default, but never everything", () => {
  const state = parseVisibility({ disabledProviders: ["anthropic"], disabledModels: ["openai/gpt-mini"] });
  const shown = filterVisibleModels(MODELS, state);
  assert.deepEqual(shown.map((m) => `${m.providerID}/${m.modelID}`), ["openai/gpt-x"]);
  const withDisconnected = filterVisibleModels(MODELS, state, { includeDisconnected: true });
  assert.deepEqual(withDisconnected.map((m) => m.modelID), ["gpt-x", "llama"]);

  // All providers disconnected → connected-only cut is dropped (fail-open).
  const offline = MODELS.map((m) => ({ ...m, connected: false }));
  const failOpen = filterVisibleModels(offline, { disabledProviders: [], disabledModels: [] });
  assert.equal(failOpen.length, MODELS.length, "nothing hidden when no provider is connected");
});

test("buildProviderCatalog groups by provider with enabled/connected flags", () => {
  const state = parseVisibility({ disabledProviders: ["ollama"], disabledModels: ["openai/gpt-mini"] });
  const catalog = buildProviderCatalog(MODELS, state);
  assert.deepEqual(catalog.map((p) => p.id), ["anthropic", "openai", "ollama"], "connected first, then name");
  const openai = catalog.find((p) => p.id === "openai")!;
  assert.equal(openai.name, "OpenAI");
  assert.equal(openai.enabled, true);
  assert.equal(openai.connected, true);
  assert.deepEqual(
    openai.models.map((m) => [m.key, m.enabled]),
    [["openai/gpt-mini", false], ["openai/gpt-x", true]],
  );
  const ollama = catalog.find((p) => p.id === "ollama")!;
  assert.equal(ollama.enabled, false);
  assert.equal(ollama.connected, false);
  assert.equal(ollama.models[0]!.enabled, false, "models inherit a disabled provider");
});

test("blacklistsOf splits keys per provider", () => {
  assert.deepEqual(
    blacklistsOf({ disabledProviders: [], disabledModels: ["openai/gpt-mini", "openai/gpt-x", "a/b", "broken"] }),
    { openai: ["gpt-mini", "gpt-x"], a: ["b"] },
  );
});

test("service seeds from opencode.json when the store file is missing", async () => {
  const dir = tmp();
  const configFile = join(dir, "opencode.json");
  writeFileSync(configFile, JSON.stringify({
    disabled_providers: ["ollama"],
    provider: { openai: { blacklist: ["gpt-mini"] } },
  }));
  const applier = {
    readConfig: async () => JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>,
    applyProviderVisibility: async () => {},
  };
  const svc = createModelVisibilityService({ file: join(dir, "model-visibility.json"), applier });
  await svc.seed();
  assert.deepEqual(svc.state(), { disabledProviders: ["ollama"], disabledModels: ["openai/gpt-mini"] });
  assert.equal(svc.providerEnabled("ollama"), false);
  assert.equal(svc.modelEnabled({ providerID: "openai", modelID: "gpt-mini" }), false);
  assert.equal(svc.modelEnabled({ providerID: "openai", modelID: "gpt-x" }), true);
  // Store persisted → a fresh service does not re-seed over local state.
  const again = createModelVisibilityService({ file: join(dir, "model-visibility.json"), applier });
  await again.seed();
  assert.deepEqual(again.state().disabledProviders, ["ollama"]);
});

test("toggles persist and mirror into the backend config", async () => {
  const dir = tmp();
  let applied: { disabledProviders: string[]; blacklists: Record<string, string[]> } | null = null;
  const svc = createModelVisibilityService({
    file: join(dir, "model-visibility.json"),
    applier: {
      readConfig: async () => ({}),
      applyProviderVisibility: async (v) => { applied = v; },
    },
  });
  await svc.seed();
  await svc.setProviderEnabled("ollama", false);
  await svc.setModelEnabled("openai/gpt-mini", false);
  assert.deepEqual(applied, { disabledProviders: ["ollama"], blacklists: { openai: ["gpt-mini"] } });
  const onDisk = JSON.parse(readFileSync(join(dir, "model-visibility.json"), "utf8"));
  assert.deepEqual(onDisk, { disabledProviders: ["ollama"], disabledModels: ["openai/gpt-mini"] });

  await svc.setModelEnabled("openai/gpt-mini", true);
  await svc.setProviderEnabled("ollama", true);
  assert.deepEqual(applied, { disabledProviders: [], blacklists: {} });
});

test("a failed backend apply rolls the toggle back", async () => {
  const dir = tmp();
  const svc = createModelVisibilityService({
    file: join(dir, "model-visibility.json"),
    applier: {
      readConfig: async () => ({}),
      applyProviderVisibility: async () => { throw new Error("disk full"); },
    },
  });
  await svc.seed();
  await assert.rejects(() => svc.setProviderEnabled("openai", false), /rolled back/);
  assert.deepEqual(svc.state().disabledProviders, []);
});

test("invalid model keys are rejected", async () => {
  const svc = createModelVisibilityService({ file: join(tmp(), "v.json") });
  for (const bad of ["", "noSlash", "/leading", "trailing/"]) {
    await assert.rejects(async () => svc.setModelEnabled(bad, false), (e: Error & { code?: string }) => e.code === "invalid-input");
  }
});
