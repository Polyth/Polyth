import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverServerPackages } from "../src/projectCompositionDiscovery.ts";
import { resolveProjectComposition, type ProjectDirection } from "@polyth/contracts/project-composition";

function fixture(t: { after(fn: () => void): void }, extra: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-affinity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "example"));
  writeFileSync(join(dir, "example", "package.json"), JSON.stringify({
    name: "@example/example", polyth: { serverEntry: "./entry.ts", descriptor: {
      name: "Example", description: "Example feature", core: false, enabled: true, hasSettings: false, ...extra,
    } },
  }));
  return dir;
}

test("discovery carries canonical descriptor affinity/category without changing enablement", async (t) => {
  const packages = await discoverServerPackages(fixture(t, {
    category: "wellbeing", projectAffinity: { directions: ["wellbeing", "research"], recommended: true },
  }));
  assert.deepEqual(packages[0]!.descriptor.projectAffinity, { directions: ["research", "wellbeing"], recommended: true });
  assert.equal(packages[0]!.descriptor.category, "wellbeing");
  assert.equal(packages[0]!.descriptor.enabled, true);
});

test("old external descriptors stay valid and universal", async (t) => {
  const [pkg] = await discoverServerPackages(fixture(t, {}));
  assert.equal(pkg!.descriptor.projectAffinity, undefined);
  assert.equal(pkg!.descriptor.category, undefined);
});

test("discovery refuses misspelled categories, directions and affinity flags", async (t) => {
  for (const value of [
    { category: "researching" },
    { projectAffinity: { directions: ["health"] } },
    { projectAffinity: { recommended: "yes" } },
  ]) {
    await assert.rejects(() => discoverServerPackages(fixture(t, value)), { code: "invalid-input" });
  }
});

test("preview maturity is carried, validated and requires off-by-default", async (t) => {
  const [pkg] = await discoverServerPackages(fixture(t, { enabled: false, maturity: "in-progress" }));
  assert.equal(pkg!.descriptor.maturity, "in-progress");
  const [beta] = await discoverServerPackages(fixture(t, { enabled: false, maturity: "beta" }));
  assert.equal(beta!.descriptor.maturity, "beta");
  const [stable] = await discoverServerPackages(fixture(t, { maturity: "stable" }));
  assert.equal(stable!.descriptor.maturity, undefined);
  await assert.rejects(() => discoverServerPackages(fixture(t, { maturity: "alpha" })), { code: "invalid-input" });
  for (const maturity of ["in-progress", "beta"]) {
    await assert.rejects(() => discoverServerPackages(fixture(t, { maturity })), {
      code: "invalid-input", message: /must be disabled by default/,
    });
  }
});

test("every optional package that ships off by default declares a preview maturity", async () => {
  const packages = (await discoverServerPackages(fileURLToPath(new URL("../../", import.meta.url)))).map((p) => p.descriptor);
  const unlabelled = packages.filter((p) => !p.core && !p.enabled && !p.maturity).map((p) => p.id);
  assert.deepEqual(unlabelled, []);
});

test("current package metadata produces distinct real recommendations for requested combinations", async () => {
  const packages = (await discoverServerPackages(fileURLToPath(new URL("../../", import.meta.url)))).map((p) => p.descriptor);
  assert.ok(packages.length > 30);
  assert.ok(packages.every((p) => p.category && p.projectAffinity));
  const present = new Set(packages.map((p) => p.id));
  const resolve = (directions: ProjectDirection[]) =>
    resolveProjectComposition({ version: 1, directions, packageOverrides: {} }, packages);
  const decision = (result: ReturnType<typeof resolve>, id: string) => result.decisions.find((p) => p.id === id);

  const engineering = resolve(["engineering"]);
  // The framework git package ships in every build, so this stays unconditional.
  assert.ok(engineering.recommendedPackageIds.includes("git"));
  if (present.has("playground")) {
    assert.equal(decision(engineering, "playground")!.reason, "disabled", "direction never globally enables a package");
  }
  if (present.has("personal-coach")) assert.ok(!engineering.relevantPackageIds.includes("personal-coach"));

  const wellbeing = resolve(["wellbeing", "research"]);
  if (present.has("personal-coach")) {
    // personal-coach ships disabled; a direction never globally enables it.
    assert.equal(decision(wellbeing, "personal-coach")!.reason, "disabled");
    assert.ok(!wellbeing.recommendedPackageIds.includes("personal-coach"));
  }
  if (present.has("browser")) assert.ok(wellbeing.recommendedPackageIds.includes("browser"));
  if (present.has("markets")) assert.ok(!wellbeing.relevantPackageIds.includes("markets"));

  const finance = resolve(["finance", "research"]);
  if (present.has("markets")) assert.ok(finance.recommendedPackageIds.includes("markets"));
  if (present.has("personal-coach")) assert.ok(!finance.relevantPackageIds.includes("personal-coach"));

  const home = resolve(["home", "operations"]);
  if (present.has("agents")) assert.ok(home.recommendedPackageIds.includes("agents"));
  if (present.has("markets")) assert.ok(!home.relevantPackageIds.includes("markets"));
});
