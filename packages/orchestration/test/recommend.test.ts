import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY, modelKey, type ModelOption } from "../src/contracts.ts";
import { parsePolicy } from "../src/policy.ts";
import { buildModelOptions } from "../src/models.ts";
import { recommendPolicy, tierOf } from "../src/recommend.ts";

const opt = (harnessId: string, modelID: string, extra: Partial<ModelOption> = {}): ModelOption => ({
  key: modelKey({ harnessId, providerID: "p", modelID }), harnessId, providerID: "p", modelID, name: modelID,
  favorite: false, turns: 0, vision: false, tier: tierOf(modelID, modelID), available: true, ...extra,
});

test("tierOf", () => {
  assert.equal(tierOf("Claude Opus 5.5", "opus"), "strong");
  assert.equal(tierOf("Gemini Flash", "gemini-3.8-flash"), "fast");
  assert.equal(tierOf("Claude Sonnet 5.5", "sonnet"), "balanced");
});

test("recommend fills roles from favorites and use, keeps thresholds and custom roles", () => {
  const saved = parsePolicy({
    ...DEFAULT_POLICY, quotaCeiling: 90, maxChildren: 2, whenExhausted: "direct", excluded: ["claude::p/banned"],
    roles: [{ id: "custom-t", label: "T", when: "w", models: [] }],
  });
  const options = [
    opt("a", "fast-flash", { favorite: true, favoriteIndex: 0 }),
    opt("a", "fast-mini", { turns: 5 }),
    opt("b", "fast-lite", { favorite: true, favoriteIndex: 1 }),
    opt("a", "mid", { favorite: true, favoriteIndex: 2 }),
    opt("c", "opus-x", { turns: 9, vision: true }),
    opt("claude", "banned", { favorite: true, favoriteIndex: 3 }),
    opt("d", "unused", {}),
  ];
  const out = recommendPolicy(saved, options);
  assert.equal(out.mode, "roles");
  assert.equal(out.quotaCeiling, 90);
  assert.equal(out.maxChildren, 2);
  assert.equal(out.whenExhausted, "direct");
  assert.equal(out.roles.length, 7);
  assert.equal(out.roles[6]!.id, "custom-t");
  const ids = (id: string) => out.roles.find((r) => r.id === id)!.models.map((c) => c.modelID);
  // fast first (starred order), then position 2 from another harness
  assert.deepEqual(ids("explore"), ["fast-flash", "fast-lite", "fast-mini"]);
  assert.deepEqual(ids("implement"), ["mid", "fast-lite", "fast-flash"]);
  assert.deepEqual(ids("review"), ["opus-x", "mid"]);
  assert.deepEqual(ids("vision"), ["opus-x"]);
  assert.ok(out.roles.every((r) => r.models.every((c) => c.modelID !== "banned" && c.modelID !== "unused")));
  assert.deepEqual(recommendPolicy(saved, options), out);
});

test("model options order: favorites, used, rest; hides disconnected and harness-less rows", () => {
  const res = buildModelOptions({
    catalog: [
      { harnessId: "b", providerID: "p", modelID: "z", name: "Z" },
      { harnessId: "a", providerID: "p", modelID: "used", name: "Used", capabilities: ["input:image"] },
      { harnessId: "a", providerID: "p", modelID: "fav2", name: "Fav2" },
      { harnessId: "a", providerID: "p", modelID: "fav1", name: "Fav1" },
      { harnessId: "a", providerID: "p", modelID: "off", name: "Off", connected: false },
      { providerID: "p", modelID: "noharness", name: "N" },
    ],
    favorites: ["a::p/fav1", "a::p/fav2"],
    used: [{ harnessId: "a", providerID: "p", modelID: "used", turns: 4 }],
    available: (h) => h === "a",
  });
  assert.deepEqual(res.models.map((x) => x.modelID), ["fav1", "fav2", "used", "z"]);
  assert.equal(res.models[2]!.vision, true);
  assert.equal(res.models[3]!.available, false);
  assert.equal(buildModelOptions({ catalog: undefined, favorites: [], used: [], available: () => true }).catalogUnavailable, true);
});
