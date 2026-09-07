// Provider/model visibility: parsing, filtering, catalog grouping, seeding
// from opencode.json, and the mirror-back on toggles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelDescriptor } from "@polyth/contracts";
import {
  dropGhostCustomProviders,
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
  assert.deepEqual(catalog.map((p) => p.id), ["anthropic", "openai", "ollama"]);
  const ollama = catalog.find((p) => p.id === "ollama")!;
  assert.equal(ollama.enabled, false);
  assert.equal(ollama.status, "disabled");
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
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.id, "cursor");
  assert.equal(catalog[0]!.name, "Cursor");
  assert.equal(catalog[0]!.connected, false);
  assert.equal(catalog[0]!.enabled, false);
  assert.equal(catalog[0]!.status, "disabled");
  assert.deepEqual(catalog[0]!.models, []);
});

test("buildProviderCatalog shows explicitly added providers with no config stanza and no models", () => {
  const state = parseVisibility({ addedProviders: [{ id: "groq", name: "Groq" }] });
  const catalog = buildProviderCatalog([], state);
  assert.equal(catalog[0]!.id, "groq");
  assert.equal(catalog[0]!.name, "Groq");
  assert.equal(catalog[0]!.connected, false);
  assert.equal(catalog[0]!.enabled, true);
  assert.equal(catalog[0]!.status, "needs-setup");
  assert.deepEqual(catalog[0]!.models, []);
});

test("buildProviderCatalog prefers a config stanza's name over an added-provider hint for the same id", () => {
  const state = parseVisibility({ addedProviders: [{ id: "cursor", name: "stale hint" }] });
  const catalog = buildProviderCatalog([], state, [{ id: "cursor", name: "Cursor" }]);
  assert.equal(catalog[0]!.id, "cursor");
  assert.equal(catalog[0]!.name, "Cursor");
  assert.equal(catalog[0]!.enabled, true);
  assert.deepEqual(catalog[0]!.models, []);
});

test("disabled OpenRouter stays visible even with no live models", () => {
  const catalog = buildProviderCatalog(
    [{ providerID: "openai", providerName: "OpenAI", modelID: "gpt-x", name: "GPT X", connected: true }],
    parseVisibility({ disabledProviders: ["openrouter"] }),
  );
  const ids = catalog.map((p) => p.id);
  assert.ok(ids.includes("openrouter"));
  assert.ok(ids.includes("openai"));
  const row = catalog.find((p) => p.id === "openrouter")!;
  assert.equal(row.enabled, false);
  assert.equal(row.status, "disabled");
});

test("unconfigured managed provider stays visible and is not conflated with enabled", () => {
  const catalog = buildProviderCatalog([], parseVisibility({
    addedProviders: [{ id: "openrouter", name: "OpenRouter" }],
  }));
  assert.equal(catalog[0]!.id, "openrouter");
  assert.equal(catalog[0]!.enabled, true);
  assert.equal(catalog[0]!.connected, false);
  assert.equal(catalog[0]!.status, "needs-setup");
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

test("npm-matching custom adapter without Polyth origin stays externally-configured", async () => {
  const svc = createModelVisibilityService({
    file: join(tmp(), "model-visibility.json"),
    applier: {
      readConfig: async () => ({
        provider: {
          lab: {
            npm: "@ai-sdk/openai-compatible",
            name: "Lab",
            options: { baseURL: "http://10.0.0.8:8000/v1", headers: { Authorization: "Bearer secret" } },
          },
        },
      }),
      applyProviderVisibility: async () => {},
    },
  });
  await svc.seed();
  const row = svc.catalog([])[0]!;
  assert.equal(row.origin, "externally-configured");
  assert.equal(row.editable, false);
  assert.equal(row.custom?.hasHeaders, true);
  assert.deepEqual(row.custom?.headerNames, ["Authorization"]);
  assert.equal(JSON.stringify(row).includes("Bearer"), false);
  assert.equal(JSON.stringify(row).includes("secret"), false);
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
  const cursor = svc.catalog([])[0]!;
  assert.equal(cursor.id, "cursor");
  assert.equal(cursor.name, "Cursor");
  assert.equal(cursor.connected, false);
  assert.equal(cursor.enabled, true);
  assert.equal(cursor.status, "needs-setup");
  assert.deepEqual(cursor.models, []);
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
  const seeded = svc.catalog([]);
  assert.equal(seeded[0]!.id, "groq");
  assert.equal(seeded[0]!.enabled, false, "disabled OpenCode providers stay visible");

  await svc.addProvider("groq", "Groq");
  const added = svc.catalog([])[0]!;
  assert.equal(added.id, "groq");
  assert.equal(added.name, "Groq");
  assert.equal(added.enabled, true);
  assert.equal(svc.providerEnabled("groq"), true, "adding clears a stale disabled flag");
  assert.deepEqual(applied, { disabledProviders: [], blacklists: {} });

  const onDisk = JSON.parse(readFileSync(join(dir, "model-visibility.json"), "utf8"));
  assert.deepEqual(onDisk.addedProviders, [{ id: "groq", name: "Groq" }]);
});

test("addProvider rejects a missing id; removeProvider hides the row", async () => {
  const svc = createModelVisibilityService({ file: join(tmp(), "v.json") });
  await assert.rejects(async () => svc.addProvider(""), (e: Error & { code?: string }) => e.code === "invalid-input");
  await assert.rejects(async () => svc.removeProvider(""), (e: Error & { code?: string }) => e.code === "invalid-input");

  await svc.addProvider("groq", "Groq");
  await svc.setProviderEnabled("groq", false);
  assert.equal(svc.catalog([])[0]!.enabled, false);
  assert.equal(svc.catalog([])[0]!.status, "disabled");

  await svc.removeProvider("groq");
  assert.deepEqual(svc.catalog([]), [], "removed provider is hidden again");
  assert.deepEqual(svc.state().disabledProviders, [], "remove drops the disabled flag so the row cannot ghost");
});

test("connected runtime models do not imply Polyth stored a credential", () => {
  const catalog = buildProviderCatalog(MODELS, parseVisibility({}));
  const openai = catalog.find((p) => p.id === "openai")!;
  assert.equal(openai.connected, true);
  assert.equal(openai.hasCredential, false);
});

test("external custom provider is read-only and not rewritten as Polyth-owned", () => {
  const catalog = buildProviderCatalog([], parseVisibility({}), [{
    id: "lab-gateway",
    name: "Lab Gateway",
    origin: "externally-configured",
    protocol: "openai-compatible",
    baseURL: "http://10.0.0.8:8000/v1",
    owned: false,
    headerNames: ["X-Org"],
    hasHeaders: true,
  }]);
  assert.equal(catalog[0]!.origin, "externally-configured");
  assert.equal(catalog[0]!.editable, false);
  assert.equal(catalog[0]!.custom?.headerNames?.[0], "X-Org");
  assert.equal(catalog[0]!.custom?.hasHeaders, true);
  assert.equal(JSON.stringify(catalog[0]).includes("secret"), false);
});

test("custom provider catalog shows config models before runtime discovery", () => {
  const catalog = buildProviderCatalog([], parseVisibility({
    addedProviders: [{ id: "company-gateway", name: "Company Gateway", origin: "custom" }],
  }), [{
    id: "company-gateway",
    name: "Company Gateway",
    origin: "custom",
    protocol: "openai-compatible",
    authMode: "none",
    baseURL: "http://127.0.0.1:8080/v1",
    owned: true,
    models: [{ id: "llama-3", name: "Llama 3", context: 8192 }],
  }]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.custom?.baseURL, "http://127.0.0.1:8080/v1");
  assert.equal(catalog[0]!.status, "ready");
  assert.deepEqual(catalog[0]!.models.map((m) => [m.key, m.name, m.connected, m.enabled]), [
    ["company-gateway/llama-3", "Llama 3", false, true],
  ]);
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

test("boot drops ghost custom ownership when the physical stanza never landed", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "model-visibility.json"), `${JSON.stringify({
    disabledProviders: [],
    disabledModels: [],
    addedProviders: [
      { id: "ghost-lab", name: "Ghost", origin: "custom", authMode: "api-key", hasStoredCredential: true },
      { id: "openai", name: "OpenAI", origin: "builtin" },
    ],
  }, null, 2)}\n`);
  const svc = createModelVisibilityService({
    file: join(dir, "model-visibility.json"),
    applier: {
      readConfig: async () => ({ provider: {} }),
      applyProviderVisibility: async () => {},
    },
  });
  await svc.seed();
  assert.deepEqual(svc.state().addedProviders.map((p) => p.id), ["openai"]);
  assert.equal(svc.catalog([]).some((p) => p.id === "ghost-lab"), false);
  const onDisk = JSON.parse(readFileSync(join(dir, "model-visibility.json"), "utf8"));
  assert.deepEqual(onDisk.addedProviders.map((p: { id: string }) => p.id), ["openai"]);
});

test("boot keeps a Polyth-owned custom provider when the physical stanza exists", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "model-visibility.json"), `${JSON.stringify({
    disabledProviders: [],
    disabledModels: [],
    addedProviders: [{ id: "lab", name: "Lab", origin: "custom", authMode: "none" }],
  }, null, 2)}\n`);
  const svc = createModelVisibilityService({
    file: join(dir, "model-visibility.json"),
    applier: {
      readConfig: async () => ({
        provider: {
          lab: {
            npm: "@ai-sdk/openai-compatible",
            name: "Lab",
            options: { baseURL: "http://127.0.0.1:9/v1" },
          },
        },
      }),
      applyProviderVisibility: async () => {},
    },
  });
  await svc.seed();
  const row = svc.catalog([])[0]!;
  assert.equal(row.id, "lab");
  assert.equal(row.origin, "custom");
  assert.equal(row.editable, true);
});

test("dropGhostCustomProviders never auto-owns an npm-matching external stanza", () => {
  const kept = dropGhostCustomProviders(
    [{ id: "lab", origin: "externally-configured" }],
    new Set(),
  );
  assert.deepEqual(kept.map((p) => p.origin), ["externally-configured"]);
});
