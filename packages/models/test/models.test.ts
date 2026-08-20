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
  serializeModelPrefs,
  sortModels,
  toggleFavorite,
  validateProfile,
  type ModelPrefs,
} from "@polyth/models";

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
