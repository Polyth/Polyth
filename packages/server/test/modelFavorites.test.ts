import assert from "node:assert/strict";
import test from "node:test";
import { modelFavoriteKeys } from "../src/clientSettings.ts";

test("model favorites are read from synced modelPrefs; legacy keys belong to OpenCode", () => {
  assert.deepEqual(modelFavoriteKeys({
    modelPrefs: { favorites: ["claude::anthropic/opus", "anthropic/sonnet", "claude::anthropic/opus", 7, "no-slash"] },
  }), ["claude::anthropic/opus", "opencode::anthropic/sonnet"]);
  assert.deepEqual(modelFavoriteKeys({}), []);
  assert.deepEqual(modelFavoriteKeys(null), []);
  assert.deepEqual(modelFavoriteKeys({ modelPrefs: { favorites: "claude::anthropic/opus" } }), []);
});
