import assert from "node:assert/strict";
import test from "node:test";
import { missingProjectPackageOverrides } from "../src/projectCompositionOverrides.ts";

const composition = {
  version: 1,
  directions: ["engineering"],
  packageOverrides: {
    git: "include",
    "removed-alpha": "exclude",
    "removed-zeta": "include",
  },
} as const;

test("missing package overrides stay visible in deterministic order", () => {
  assert.deepEqual(missingProjectPackageOverrides(composition as never, ["git", "browser"]), [
    { id: "removed-alpha", preference: "exclude" },
    { id: "removed-zeta", preference: "include" },
  ]);
});

test("reinstalled packages stop being missing without mutating saved intent", () => {
  const before = JSON.stringify(composition);
  assert.deepEqual(missingProjectPackageOverrides(composition as never, ["git", "removed-zeta"]), [
    { id: "removed-alpha", preference: "exclude" },
  ]);
  assert.equal(JSON.stringify(composition), before);
});

test("no stale overrides yields an empty recovery list", () => {
  assert.deepEqual(missingProjectPackageOverrides(composition as never, ["git", "removed-alpha", "removed-zeta"]), []);
});
