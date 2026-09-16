import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProjectComposition, parseProjectAffinity, projectPackageDecision,
  isProjectContributionRelevant, resolveProjectComposition,
  type ProjectComposition, type CompositionPackage,
} from "../src/projectComposition.ts";

const engineering = (): ProjectComposition => ({ version: 1, directions: ["engineering"], packageOverrides: {} });
const finance: CompositionPackage = { id: "finance", enabled: true, projectAffinity: { directions: ["finance"], recommended: true } };

test("legacy and general projects keep enabled unclassified/affine packages, without mutation", () => {
  assert.equal(projectPackageDecision(undefined, finance).reason, "legacy");
  assert.equal(projectPackageDecision({ ...engineering(), directions: [] }, finance).relevant, true);
  assert.equal(projectPackageDecision(engineering(), { id: "custom", enabled: true }).reason, "universal");
});
test("recommendations come from matching affinity, not General or manual Show", () => {
  const general = { ...engineering(), directions: [] };
  assert.equal(projectPackageDecision(general, finance).recommended, false);
  const manual = engineering();
  manual.packageOverrides.finance = "include";
  assert.equal(projectPackageDecision(manual, finance).reason, "included");
  assert.equal(projectPackageDecision(manual, finance).recommended, false);
  assert.equal(projectPackageDecision(
    engineering(),
    { id: "universal", enabled: true, projectAffinity: { recommended: true } },
  ).recommended, true);
});
test("precedence: disabled > excluded > included > affinity, including mini-widget affinity", () => {
  const c = engineering();
  assert.equal(projectPackageDecision(c, finance).reason, "unrelated");
  c.packageOverrides.finance = "include";
  assert.equal(isProjectContributionRelevant(c, finance, { directions: ["wellbeing"] }), true);
  assert.equal(projectPackageDecision(c, { ...finance, enabled: false }).reason, "disabled");
  c.packageOverrides.finance = "exclude";
  assert.equal(isProjectContributionRelevant(c, finance), false);
});
test("multi-direction resolution is a deterministic union and does not change input/catalog", () => {
  const c = parseProjectComposition({ version: 1, directions: ["wellbeing", "research"], packageOverrides: {} });
  const packages: CompositionPackage[] = [
    finance, { id: "coach", enabled: true, projectAffinity: { directions: ["wellbeing"], recommended: true } },
    { id: "knowledge", enabled: true, projectAffinity: { directions: ["research"], recommended: true } },
  ];
  const snapshot = structuredClone({ c, packages });
  const resolved = resolveProjectComposition(c, packages);
  assert.deepEqual(resolved.relevantPackageIds, ["coach", "knowledge"]);
  assert.deepEqual(resolved.recommendedPackageIds, ["coach", "knowledge"]);
  assert.deepEqual(resolveProjectComposition(c, [...packages].reverse()), resolved);
  assert.deepEqual({ c, packages }, snapshot);
});
test("narrow contribution affinity cannot reopen an irrelevant owner", () => {
  assert.equal(isProjectContributionRelevant(engineering(), finance, { directions: ["engineering"] }), false);
  const pkg = { ...finance, projectAffinity: { directions: ["engineering"] as const } };
  assert.equal(isProjectContributionRelevant(engineering(), pkg, { directions: ["finance"] }), false);
});
test("composition parsing canonicalizes/copies selection and preserves unknown package overrides", () => {
  const raw = { version: 1, directions: ["home", "engineering", "home"], packageOverrides: { "future-plugin": "include" } };
  const result = parseProjectComposition(raw);
  assert.deepEqual(result.directions, ["engineering", "home"]);
  raw.directions.length = 0;
  assert.deepEqual(result.directions, ["engineering", "home"]);
  assert.deepEqual(result.packageOverrides, { "future-plugin": "include" });
});
test("malformed, future-version and pollution-shaped writes fail explicitly", () => {
  const invalid: unknown[] = [null, [], "engineering", {}, { version: 2, directions: [] },
    { version: 1, directions: ["unknown"] }, { version: 1, directions: "engineering" },
    { ...engineering(), packageOverrides: { tool: true } },
    { ...engineering(), packageOverrides: [] }, { ...engineering(), extra: true },
    { ...engineering(), packageOverrides: JSON.parse('{"__proto__":"include"}') },
    { ...engineering(), packageOverrides: { constructor: "include" } }];
  for (const value of invalid) assert.throws(() => parseProjectComposition(value), { code: "invalid-input" });
});
test("affinity validation rejects typo metadata rather than silently hiding packages", () => {
  assert.deepEqual(parseProjectAffinity({ directions: ["finance", "research"], recommended: true }),
    { directions: ["research", "finance"], recommended: true });
  for (const value of [{ directions: ["finances"] }, { recommended: "true" }, { category: "home" }, null]) {
    assert.throws(() => parseProjectAffinity(value), { code: "invalid-input" });
  }
});
test("restoring relevance does not require modifying a globally enabled package", () => {
  const c = engineering(); const before = structuredClone(finance);
  c.packageOverrides.finance = "include";
  assert.equal(projectPackageDecision(c, finance).relevant, true);
  assert.deepEqual(finance, before);
  assert.equal(projectPackageDecision(engineering(), finance).relevant, false, "another project is unaffected");
});
