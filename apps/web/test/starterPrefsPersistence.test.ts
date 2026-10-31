import test from "node:test";
import assert from "node:assert/strict";

const stored = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
};

stored.set("polyth.starters.v1", JSON.stringify({
  pinned: ["builtin:explore"],
  hidden: [],
  recents: [],
  custom: [],
}));

const starters = await import("../src/starters.ts");
const { activateProject } = await import("../src/store.ts");

test("starter prefs migrate lazily, isolate projects, and honor explicit sharing", () => {
  activateProject("project-a");
  assert.deepEqual(starters.getStarterPrefs().pinned, ["builtin:explore"]);
  assert.equal(stored.has(starters.starterPrefsStorageKey("project-a")), false,
    "legacy fallback is not copied until the user changes it");

  starters.toggleStarterPinned("builtin:debug");
  const projectA = starters.parseStarterPrefs(stored.get(starters.starterPrefsStorageKey("project-a")) ?? null);
  assert.deepEqual(projectA.pinned, ["builtin:explore", "builtin:debug"]);
  assert.equal(projectA.shared, false);

  activateProject("project-b");
  assert.deepEqual(starters.getStarterPrefs().pinned, ["builtin:explore"],
    "a project without prefs still sees the read-only migration fallback");
  starters.toggleStarterPinned("builtin:plan-feature");
  assert.deepEqual(
    starters.parseStarterPrefs(stored.get(starters.starterPrefsStorageKey("project-b")) ?? null).pinned,
    ["builtin:explore", "builtin:plan-feature"],
  );

  starters.setStarterShared(true);
  assert.equal(starters.getStarterPrefs().shared, true);
  assert.equal(starters.parseStarterPrefs(stored.get(starters.STARTER_PREFS_KEY) ?? null).shared, true);

  activateProject("project-a");
  assert.deepEqual(starters.getStarterPrefs().pinned, ["builtin:explore", "builtin:plan-feature"],
    "an explicitly shared global record overrides existing project records");

  starters.setStarterShared(false);
  assert.equal(stored.has(starters.STARTER_PREFS_KEY), false,
    "disabling sharing removes the global override");
  assert.equal(
    starters.parseStarterPrefs(stored.get(starters.starterPrefsStorageKey("project-a")) ?? null).shared,
    false,
  );

  activateProject("project-b");
  assert.deepEqual(starters.getStarterPrefs().pinned, ["builtin:explore", "builtin:plan-feature"],
    "the original project record becomes active again");
});
