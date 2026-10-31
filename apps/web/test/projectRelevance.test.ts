import test from "node:test";
import assert from "node:assert/strict";
import {
  isProjectContributionRelevant,
  projectPackageAffinity,
  replaceProjectPackageCatalog,
  resetProjectRelevanceForTest,
  setProjectCompositionContext,
} from "../src/packages/projectRelevance.ts";

test.afterEach(resetProjectRelevanceForTest);

const packages = [
  { id: "git", name: "Git", description: "", core: false, enabled: true, hasSettings: false, category: "engineering", projectAffinity: { directions: ["engineering"], recommended: true } },
  { id: "coach", name: "Coach", description: "", core: false, enabled: true, hasSettings: false, category: "wellbeing", projectAffinity: { directions: ["wellbeing"] } },
  { id: "home-assistant", name: "Home", description: "", core: false, enabled: false, hasSettings: false, category: "home", projectAffinity: { directions: ["home"] } },
] as const;

test("project switching changes relevance without changing package enablement", () => {
  replaceProjectPackageCatalog(packages as never);
  setProjectCompositionContext("a", { version: 1, directions: ["engineering"], packageOverrides: {} });
  assert.equal(isProjectContributionRelevant("git"), true);
  assert.equal(isProjectContributionRelevant("coach"), false);
  setProjectCompositionContext("b", { version: 1, directions: ["wellbeing"], packageOverrides: {} });
  assert.equal(isProjectContributionRelevant("git"), false);
  assert.equal(isProjectContributionRelevant("coach"), true);
});

test("explicit include beats affinity but never global disable", () => {
  replaceProjectPackageCatalog(packages as never);
  setProjectCompositionContext("a", { version: 1, directions: ["engineering"], packageOverrides: { coach: "include", "home-assistant": "include" } });
  assert.equal(isProjectContributionRelevant("coach", { directions: ["finance"] }), true);
  assert.equal(isProjectContributionRelevant("home-assistant"), false);
});

test("legacy, host and unknown external contributions remain compatible", () => {
  replaceProjectPackageCatalog(packages as never);
  setProjectCompositionContext("legacy", undefined);
  assert.equal(isProjectContributionRelevant("coach"), true);
  setProjectCompositionContext("a", { version: 1, directions: ["engineering"], packageOverrides: {} });
  assert.equal(isProjectContributionRelevant(), true);
  assert.equal(isProjectContributionRelevant("host"), true);
  assert.equal(isProjectContributionRelevant("third-party-not-catalogued"), true);
});

test("package affinity lookup is detached and suitable for one-time profile inheritance", () => {
  replaceProjectPackageCatalog(packages as never);
  const affinity = projectPackageAffinity("git");
  assert.deepEqual(affinity, { directions: ["engineering"], recommended: true });
  affinity!.directions = [];
  assert.deepEqual(projectPackageAffinity("git"), { directions: ["engineering"], recommended: true });
  assert.equal(projectPackageAffinity("missing"), undefined);
});
