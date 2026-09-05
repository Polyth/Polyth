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
  buildAvailableProviders,
  buildProviderCatalog,
  createModelVisibilityService,
  filterVisibleModels,
  humanizeProviderId,
  parseVisibility,
  shownProviderIds,
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
  assert.deepEqual(parseVisibility(null), { disabledProviders: [], disabledModels: [], addedProviders: [] });
  assert.deepEqual(parseVisibility("nope"), { disabledProviders: [], disabledModels: [], addedProviders: [] });
  assert.deepEqual(
    parseVisibility({ disabledProviders: ["b", "a", "b", 7, ""], disabledModels: ["p/m", "p/m"] }),
    { disabledProviders: ["a", "b"], disabledModels: ["p/m"], addedProviders: [] },
  );
});

test("parseVisibility normalizes addedProviders (plain ids or {id,name}, deduped by id)", () => {
  const v = parseVisibility({
    addedProviders: ["groq", { id: "groq", name: "Groq" }, { id: "cerebras" }, { id: "" }, "bad-dup", "bad-dup"],
  });
  assert.deepEqual(v.addedProviders, [{ id: "bad-dup" }, { id: "cerebras" }, { id: "groq", name: "Groq" }]);
});

test("visibilityFromBackendConfig reads disabled_providers and provider blacklists", () => {
  const v = visibilityFromBackendConfig({
    disabled_providers: ["ollama"],
    provider: {
      openai: { apiKey: "sk", blacklist: ["gpt-mini"] },
      anthropic: { baseURL: "https://x" },
    },
  });
  assert.deepEqual(v, { disabledProviders: ["ollama"], disabledModels: ["openai/gpt-mini"], addedProviders: [] });
  assert.deepEqual(visibilityFromBackendConfig({}), { disabledProviders: [], disabledModels: [], addedProviders: [] });
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
  assert.deepEqual(catalog.map((p) => p.id), ["anthropic", "openai"], "unconfigured providers stay out of the catalog");
  const openai = catalog.find((p) => p.id === "openai")!;
  assert.equal(openai.name, "OpenAI");
  assert.equal(openai.enabled, true);
  assert.equal(openai.connected, true);
  assert.deepEqual(
    openai.models.map((m) => [m.key, m.enabled]),
    [["openai/gpt-mini", false], ["openai/gpt-x", true]],
  );
});

test("buildProviderCatalog keeps configured providers with no discovered models", () => {
  const catalog = buildProviderCatalog([], parseVisibility({ disabledProviders: ["cursor"] }), [
    { id: "cursor", name: "Cursor" },
  ]);
  assert.deepEqual(catalog, [{
    id: "cursor",
    name: "Cursor",
    connected: false,
    enabled: false,
    models: [],
  }]);
});

test("buildProviderCatalog shows explicitly added providers with no config stanza and no models", () => {
  const state = parseVisibility({ addedProviders: [{ id: "groq", name: "Groq" }] });
  const catalog = buildProviderCatalog([], state);
  assert.deepEqual(catalog, [{ id: "groq", name: "Groq", connected: false, enabled: true, models: [] }]);
});

test("buildProviderCatalog prefers a config stanza's name over an added-provider hint for the same id", () => {
  const state = parseVisibility({ addedProviders: [{ id: "cursor", name: "stale hint" }] });
  const catalog = buildProviderCatalog([], state, [{ id: "cursor", name: "Cursor" }]);
  assert.deepEqual(catalog, [{ id: "cursor", name: "Cursor", connected: false, enabled: true, models: [] }]);
});

test("shownProviderIds unions configured, added, and model-bearing providers", () => {
  const state = parseVisibility({ addedProviders: [{ id: "groq" }] });
  const ids = shownProviderIds(MODELS, state, [{ id: "cursor" }]);
  assert.deepEqual([...ids].sort(), ["anthropic", "cursor", "groq", "openai"]);
});

test("humanizeProviderId title-cases kebab/snake ids", () => {
  assert.equal(humanizeProviderId("github-copilot"), "Github Copilot");
  assert.equal(humanizeProviderId("zai_coding_plan"), "Zai Coding Plan");
  assert.equal(humanizeProviderId("groq"), "Groq");
});

test("buildAvailableProviders merges live + auth-only providers and excludes anything already shown", () => {
  const shown = new Set(["openai"]);
  const available = buildAvailableProviders(
    [{ id: "openai", name: "OpenAI" }, { id: "huggingface", name: "Hugging Face" }],
    ["cursor", "huggingface"],
    shown,
  );
  assert.deepEqual(available, [
    { id: "cursor", name: "Cursor" },
    { id: "huggingface", name: "Hugging Face" },
  ]);
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
  assert.deepEqual(svc.state(), {
    disabledProviders: ["ollama"],
    disabledModels: ["openai/gpt-mini"],
    addedProviders: [],
  });
  assert.equal(svc.providerEnabled("ollama"), false);
  assert.equal(svc.modelEnabled({ providerID: "openai", modelID: "gpt-mini" }), false);
  assert.equal(svc.modelEnabled({ providerID: "openai", modelID: "gpt-x" }), true);
  // Store persisted → a fresh service does not re-seed over local state.
  const again = createModelVisibilityService({ file: join(dir, "model-visibility.json"), applier });
  await again.seed();
  assert.deepEqual(again.state().disabledProviders, ["ollama"]);
});

test("service lists configured providers even when runtime discovery has no models", async () => {
  const svc = createModelVisibilityService({
    file: join(tmp(), "model-visibility.json"),
    applier: {
      readConfig: async () => ({ provider: { cursor: { name: "Cursor" } } }),
      applyProviderVisibility: async () => {},
    },
  });
  await svc.seed();
  assert.deepEqual(svc.catalog([]), [{
    id: "cursor",
    name: "Cursor",
    connected: false,
    enabled: true,
    models: [],
  }]);
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
  assert.deepEqual(onDisk, { disabledProviders: ["ollama"], disabledModels: ["openai/gpt-mini"], addedProviders: [] });

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

test("addProvider shows a zero-model row and clears a stale disabled flag", async () => {
  const dir = tmp();
  let applied: { disabledProviders: string[]; blacklists: Record<string, string[]> } | null = null;
  const svc = createModelVisibilityService({
    file: join(dir, "model-visibility.json"),
    applier: {
      readConfig: async () => ({ disabled_providers: ["groq"] }),
      applyProviderVisibility: async (v) => { applied = v; },
    },
  });
  await svc.seed();
  assert.equal(svc.providerEnabled("groq"), false, "seeded disabled, as it was never added");
  assert.deepEqual(svc.catalog([]), [], "not added yet, so not shown");

  await svc.addProvider("groq", "Groq");
  assert.deepEqual(svc.catalog([]), [{ id: "groq", name: "Groq", connected: false, enabled: true, models: [] }]);
  assert.equal(svc.providerEnabled("groq"), true, "adding clears a stale disabled flag");
  assert.deepEqual(applied, { disabledProviders: [], blacklists: {} });

  const onDisk = JSON.parse(readFileSync(join(dir, "model-visibility.json"), "utf8"));
  assert.deepEqual(onDisk.addedProviders, [{ id: "groq", name: "Groq" }]);
});

test("addProvider rejects a missing id; removeProvider hides the row again without touching disabledProviders", async () => {
  const svc = createModelVisibilityService({ file: join(tmp(), "v.json") });
  await assert.rejects(async () => svc.addProvider(""), (e: Error & { code?: string }) => e.code === "invalid-input");
  await assert.rejects(async () => svc.removeProvider(""), (e: Error & { code?: string }) => e.code === "invalid-input");

  await svc.addProvider("groq", "Groq");
  await svc.setProviderEnabled("groq", false);
  assert.deepEqual(svc.catalog([])[0]!.enabled, false);

  await svc.removeProvider("groq");
  assert.deepEqual(svc.catalog([]), [], "removed provider is hidden again");
  assert.deepEqual(svc.state().disabledProviders, ["groq"], "remove does not touch the disabled flag");
});

test("available() excludes catalog()-shown providers and surfaces auth-only ones by humanized name", async () => {
  const svc = createModelVisibilityService({
    file: join(tmp(), "v.json"),
    applier: { readConfig: async () => ({ provider: { cursor: {} } }), applyProviderVisibility: async () => {} },
  });
  await svc.seed();
  const available = svc.available(
    MODELS, // only connected model-bearing providers are already shown
    [{ id: "openai", name: "OpenAI" }, { id: "huggingface", name: "Hugging Face" }],
    ["cursor", "github-copilot"],
  );
  assert.deepEqual(available, [
    { id: "github-copilot", name: "Github Copilot" },
    { id: "huggingface", name: "Hugging Face" },
  ]);
});
