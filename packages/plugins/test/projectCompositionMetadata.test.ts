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

test("current package metadata produces distinct real recommendations for requested combinations", async () => {
  const packages = (await discoverServerPackages(fileURLToPath(new URL("../../", import.meta.url)))).map((p) => p.descriptor);
  assert.ok(packages.length > 30);
  assert.ok(packages.every((p) => p.category && p.projectAffinity));
  const resolve = (directions: ProjectDirection[]) =>
    resolveProjectComposition({ version: 1, directions, packageOverrides: {} }, packages);

  const engineering = resolve(["engineering"]);
  assert.ok(engineering.recommendedPackageIds.includes("git"));
  assert.ok(!engineering.relevantPackageIds.includes("personal-coach"));

  const wellbeing = resolve(["wellbeing", "research"]);
  assert.ok(wellbeing.recommendedPackageIds.includes("personal-coach"));
  assert.ok(wellbeing.recommendedPackageIds.includes("browser"));
  assert.ok(!wellbeing.relevantPackageIds.includes("markets"));

  const finance = resolve(["finance", "research"]);
  assert.ok(finance.recommendedPackageIds.includes("markets"));
  assert.ok(!finance.relevantPackageIds.includes("personal-coach"));

  const home = resolve(["home", "operations"]);
  assert.ok(home.recommendedPackageIds.includes("schedule"));
  assert.equal(home.decisions.find((p) => p.id === "home-assistant")!.reason, "disabled", "direction never globally enables a package");
  assert.ok(!home.relevantPackageIds.includes("markets"));
});
