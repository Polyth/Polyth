import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultModelPrefs,
  filterModels,
  isFavorite,
  modelKey,
  parseModelPrefs,
  planFavoriteMigration,
  recordRecent,
  reorderFavorite,
  reorderProvider,
  serializeModelPrefs,
  setProviderExpanded,
  sortModels,
  toggleFavorite,
  validateProfile,
  type ModelPrefs,
} from "@polyth/models";
import {
  initialModelPickerState,
  modelPickerReducer,
  providerIsExpanded,
} from "@polyth/models/model-picker-state";
import {
  modelDetailsPresentation,
  modelMetaLine,
  modelModalityLabels,
  thinkingVariantLabel,
} from "@polyth/models/model-presentation";
import { interactiveMethods } from "../widgets/providerAuth.ts";

test("model providers are collapsed by default and expansion/order persist", () => {
  const initial = defaultModelPrefs();
  assert.deepEqual(initial.expandedProviders, []);
  assert.deepEqual(initial.providerOrder, []);

  const expanded = setProviderExpanded(initial, "anthropic", true);
  const reordered = reorderProvider(expanded, ["openai", "anthropic", "google"], "google", "openai");
  const parsed = parseModelPrefs(serializeModelPrefs(reordered));
  assert.deepEqual(parsed.expandedProviders, ["anthropic"]);
  assert.deepEqual(parsed.providerOrder, ["google", "openai", "anthropic"]);
});

test("provider auth interactive methods are the declared oauth/api methods", () => {
  assert.deepEqual(interactiveMethods({
    providerId: "openai",
    discovery: { status: "loaded", provenance: ["opencode-plugin"], revision: "1", authorityId: "a", generation: 1 },
    methods: [
      { id: "openai:0:abc", upstreamIndex: 0, fingerprint: "abc", provenance: "opencode-plugin", kind: "oauth", label: "Sign in", fields: [], usable: true },
    ],
  }).map((method) => method.kind), ["oauth"]);
});

const MODELS = [
  { providerID: "openai", modelID: "gpt-5", name: "GPT-5" },
  { providerID: "anthropic", modelID: "claude-4", name: "Claude 4" },
  { providerID: "anthropic", modelID: "claude-haiku", name: "Claude Haiku" },
  { providerID: "google", modelID: "gemini-3", name: "Gemini 3" },
];

test("parse round-trips and rejects garbage", () => {
  assert.deepEqual(parseModelPrefs(null), defaultModelPrefs());
  assert.deepEqual(parseModelPrefs("{nope"), defaultModelPrefs());
  const p = toggleFavorite(defaultModelPrefs(), "openai/gpt-5");
  const back = parseModelPrefs(serializeModelPrefs({ ...p, sort: "name" }));
  assert.deepEqual(back.favorites, ["openai/gpt-5"]);
  assert.equal(back.sort, "name");
  assert.equal(parseModelPrefs('{"sort":"bogus"}').sort, "provider");
});

test("toggleFavorite adds then removes; isFavorite reflects it", () => {
  let p = defaultModelPrefs();
  const key = modelKey(MODELS[1]!);
  p = toggleFavorite(p, key);
  assert.equal(isFavorite(p, key), true);
  p = toggleFavorite(p, key);
  assert.equal(isFavorite(p, key), false);
});

test("favorite reorder moves a saved favorite ahead of its drop target", () => {
  const prefs = { ...defaultModelPrefs(), favorites: ["p/first", "p/second", "p/third"] };
  assert.deepEqual(reorderFavorite(prefs, "p/third", "p/first").favorites, [
    "p/third", "p/first", "p/second",
  ]);
  assert.equal(reorderFavorite(prefs, "p/missing", "p/first"), prefs);
});

test("sortModels floats favorites first, then provider/name order", () => {
  let p = defaultModelPrefs();
  p = toggleFavorite(p, "google/gemini-3");
  p = toggleFavorite(p, "openai/gpt-5");

  const byProvider = sortModels(MODELS, p).map(modelKey);
  assert.deepEqual(byProvider, [
    "google/gemini-3", "openai/gpt-5", // favorites in saved order
    "anthropic/claude-4", "anthropic/claude-haiku",
  ]);

  const byName = sortModels(MODELS, { ...p, favorites: [], sort: "name" }).map((m) => m.name);
  assert.deepEqual(byName, ["Claude 4", "Claude Haiku", "Gemini 3", "GPT-5"]);
});

test("recent sort uses recorded recency", () => {
  let p: ModelPrefs = { ...defaultModelPrefs(), sort: "recent" };
  p = recordRecent(p, "anthropic/claude-haiku");
  p = recordRecent(p, "google/gemini-3"); // most recent first
  const keys = sortModels(MODELS, p).map(modelKey);
  assert.equal(keys[0], "google/gemini-3");
  assert.equal(keys[1], "anthropic/claude-haiku");
});

test("filterModels matches provider, id, and display name", () => {
  assert.equal(filterModels(MODELS, "haiku").length, 1);
  assert.equal(filterModels(MODELS, "ANTHROPIC").length, 2);
  assert.equal(filterModels(MODELS, "").length, 4);
  assert.equal(filterModels(MODELS, "zzz").length, 0);
});

test("model picker expansion has explicit, deterministic precedence", () => {
  assert.equal(providerIsExpanded({
    query: "opus",
    sessionOverride: false,
    persistedExpanded: false,
    selectedProvider: false,
  }), true, "search reveals matching groups");
  assert.equal(providerIsExpanded({
    query: "",
    sessionOverride: false,
    persistedExpanded: true,
    selectedProvider: true,
  }), false, "session collapse wins after search clears");
  assert.equal(providerIsExpanded({
    query: "",
    sessionOverride: true,
    persistedExpanded: false,
    selectedProvider: false,
  }), true, "session expansion wins");
  assert.equal(providerIsExpanded({
    query: "",
    persistedExpanded: true,
    selectedProvider: false,
  }), true, "persisted expansion wins without a session choice");
  assert.equal(providerIsExpanded({
    query: "",
    persistedExpanded: false,
    selectedProvider: true,
  }), true, "selected provider is the final fresh-state default");
});

test("clearing model search restores the prior manual collapse state", () => {
  let state = initialModelPickerState();
  state = modelPickerReducer(state, {
    type: "set-expanded",
    providerId: "anthropic",
    expanded: false,
  });
  state = modelPickerReducer(state, { type: "search", query: "claude" });
  assert.equal(providerIsExpanded({
    query: state.query,
    sessionOverride: state.expansion.anthropic,
    persistedExpanded: true,
    selectedProvider: true,
  }), true);
  state = modelPickerReducer(state, { type: "search", query: "" });
  assert.equal(providerIsExpanded({
    query: state.query,
    sessionOverride: state.expansion.anthropic,
    persistedExpanded: true,
    selectedProvider: true,
  }), false);
});

test("model presentation applies one fallback policy to missing catalog fields", () => {
  const sparse = { providerID: "local", modelID: "unknown", name: "Unknown" };
  assert.deepEqual(modelModalityLabels(sparse), ["Text"]);
  assert.equal(modelMetaLine(sparse), "Text");
  assert.equal(thinkingVariantLabel("xhigh"), "X-High");
  assert.deepEqual(modelDetailsPresentation(sparse), {
    provider: "local",
    context: "Context unknown",
    modalities: "Text",
    reasoning: "Not reported",
    tools: "Not reported",
    pricing: null,
    availability: null,
  });
});

test("parseModelPrefs sanitizes, deduplicates, and caps persisted keys", () => {
  const recents = Array.from({ length: 25 }, (_, i) => `p/m${i}`);
  const parsed = parseModelPrefs(JSON.stringify({
    favorites: ["p/a", 1, "p/a", "p/b"],
    recents: ["p/repeated", "p/repeated", ...recents],
    sort: "recent",
  }));

  assert.deepEqual(parsed.favorites, ["p/a", "p/b"]);
  assert.equal(parsed.recents.length, 20);
  assert.equal(new Set(parsed.recents).size, parsed.recents.length);
  assert.deepEqual(parsed.recents.slice(0, 3), ["p/repeated", "p/m0", "p/m1"]);
});

test("favorite and recent updates are immutable and preserve ordering", () => {
  const original = {
    ...defaultModelPrefs(),
    favorites: ["p/a"],
    sort: "provider" as const,
    recents: ["p/b", "p/a"],
  };

  const favorited = toggleFavorite(original, "p/c");
  const recent = recordRecent(original, "p/a");
  assert.deepEqual(original, {
    favorites: ["p/a"],
    sort: "provider",
    recents: ["p/b", "p/a"],
    providerOrder: [],
    expandedProviders: [],
  });
  assert.deepEqual(favorited.favorites, ["p/a", "p/c"]);
  assert.deepEqual(recent.recents, ["p/a", "p/b"]);
});

test("recordRecent keeps only the twenty newest unique keys", () => {
  let prefs = defaultModelPrefs();
  for (let i = 0; i < 25; i++) prefs = recordRecent(prefs, `p/m${i}`);

  assert.equal(prefs.recents.length, 20);
  assert.equal(prefs.recents[0], "p/m24");
  assert.equal(prefs.recents.at(-1), "p/m5");

  prefs = recordRecent(prefs, "p/m10");
  assert.equal(prefs.recents[0], "p/m10");
  assert.equal(prefs.recents.filter((key) => key === "p/m10").length, 1);
});

test("sortModels and filterModels return new arrays without mutating input", () => {
  const input = Object.freeze([...MODELS]);
  const sorted = sortModels(input, { ...defaultModelPrefs(), sort: "name" });
  const filtered = filterModels(input, "  CLAUDE-4 ");
  const all = filterModels(input, "  ");

  assert.deepEqual(input.map(modelKey), MODELS.map(modelKey));
  assert.notEqual(sorted, input);
  assert.notEqual(all, input);
  assert.deepEqual(filtered.map(modelKey), ["anthropic/claude-4"]);
});

test("recent sorting falls back to provider order for unseen models", () => {
  const prefs = {
    ...defaultModelPrefs(),
    sort: "recent" as const,
    recents: ["google/gemini-3"],
    favorites: ["openai/gpt-5"],
  };
  assert.deepEqual(sortModels(MODELS, prefs).map(modelKey), [
    "openai/gpt-5",
    "google/gemini-3",
    "anthropic/claude-4",
    "anthropic/claude-haiku",
  ]);
});

// ---------------------------------------------------------------- WP8: profiles

test("validateProfile proposes repairs but never silently mutates", () => {
  const agents = [{ name: "build" }, { name: "review" }];

  // Nothing checkable when the adapter reported no models.
  const unchecked = validateProfile({ providerID: "gone", modelID: "x" }, [], agents);
  assert.deepEqual(unchecked, { valid: true, checked: false, repairs: [] });

  const ok = validateProfile(
    { providerID: "openai", modelID: "gpt-5", agent: "build", thinking: "low" },
    MODELS,
    agents,
  );
  assert.equal(ok.valid, true);
  assert.equal(ok.checked, true);

  const broken = validateProfile(
    { providerID: "gone", modelID: "dead", agent: "ghost", thinking: "ultra" },
    MODELS,
    agents,
  );
  assert.equal(broken.valid, false);
  assert.deepEqual(broken.repairs.map((r) => r.field), ["model", "agent", "thinking"]);
  assert.equal(broken.repairs[0]!.from, "gone/dead");
  assert.equal(broken.repairs[1]!.to, "");
  assert.equal(broken.repairs[2]!.to, "default");
});

test("planFavoriteMigration is idempotent and skips vanished models", () => {
  const prefs: ModelPrefs = {
    ...defaultModelPrefs(),
    favorites: ["openai/gpt-5", "anthropic/claude-4", "gone/dead"],
  };

  const plan = planFavoriteMigration(prefs, MODELS, []);
  assert.deepEqual(plan.map((p) => `${p.providerID}/${p.modelID}`), ["openai/gpt-5", "anthropic/claude-4"]);
  assert.equal(plan[0]!.name, "GPT-5");

  // Re-running with the created profiles present yields an empty plan.
  const again = planFavoriteMigration(prefs, MODELS, plan);
  assert.deepEqual(again, []);
});
