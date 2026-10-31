import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptRenamedPackageData } from "../src/packageRename.ts";
import { createProjectService } from "../src/projects.ts";

const temp = (t: { after(fn: () => void): void }, prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a renamed package's data moves to its new id in every root, once", (t) => {
  const dir = temp(t, "polyth-rename-");
  const roots = ["deployment", "space-a", "space-b", "person"].map((name) => ({ spaceId: name.startsWith("space") ? name : null, dir: join(dir, name) }));
  for (const root of roots.slice(0, 3)) {
    mkdirSync(join(root.dir, "schedule"), { recursive: true });
    writeFileSync(join(root.dir, "schedule", "schedule.json"), root.dir);
  }
  mkdirSync(roots[3]!.dir, { recursive: true });
  const renames = [{ id: "agents", formerIds: ["schedule"] }];
  const report = adoptRenamedPackageData(roots, renames);
  assert.equal(report.moved.length, 3);
  assert.deepEqual(report.kept, []);
  for (const root of roots.slice(0, 3)) {
    assert.equal(readFileSync(join(root.dir, "agents", "schedule.json"), "utf8"), root.dir);
    assert.equal(existsSync(join(root.dir, "schedule")), false);
  }
  // A second boot has nothing to move.
  assert.deepEqual(adoptRenamedPackageData(roots, renames), { moved: [], kept: [], failed: [] });
});

test("existing data under the new id wins; the former directory is left for the owner", (t) => {
  const root = { spaceId: null, dir: temp(t, "polyth-rename-kept-") };
  mkdirSync(join(root.dir, "schedule"));
  writeFileSync(join(root.dir, "schedule", "schedule.json"), "old");
  mkdirSync(join(root.dir, "agents"));
  writeFileSync(join(root.dir, "agents", "schedule.json"), "current");
  const report = adoptRenamedPackageData([root], [{ id: "agents", formerIds: ["schedule"] }]);
  assert.deepEqual(report.moved, []);
  assert.deepEqual(report.kept, [join(root.dir, "schedule")]);
  assert.equal(readFileSync(join(root.dir, "agents", "schedule.json"), "utf8"), "current");
  assert.equal(readFileSync(join(root.dir, "schedule", "schedule.json"), "utf8"), "old");
});

test("links are never followed or replaced", (t) => {
  const outside = temp(t, "polyth-rename-outside-");
  mkdirSync(join(outside, "data"));
  const linked = { spaceId: null, dir: temp(t, "polyth-rename-link-") };
  symlinkSync(join(outside, "data"), join(linked.dir, "schedule"));
  const dangling = { spaceId: null, dir: temp(t, "polyth-rename-dangling-") };
  mkdirSync(join(dangling.dir, "schedule"));
  symlinkSync(join(outside, "missing"), join(dangling.dir, "agents"));
  const report = adoptRenamedPackageData([linked, dangling], [{ id: "agents", formerIds: ["schedule"] }]);
  assert.deepEqual(report.moved, []);
  assert.deepEqual(report.kept, [join(dangling.dir, "schedule")]);
  assert.equal(existsSync(join(linked.dir, "agents")), false);
});

test("project package choices saved under a former id follow the package", async (t) => {
  const dir = temp(t, "polyth-rename-projects-");
  const projects = createProjectService(dir);
  const first = await projects.create(join(dir, "one"), "One", { version: 1, directions: [], packageOverrides: { schedule: "exclude", files: "include" } });
  const second = await projects.create(join(dir, "two"), "Two", { version: 1, directions: [], packageOverrides: { schedule: "exclude", agents: "include" } });
  const third = await projects.create(join(dir, "three"), "Three");
  const renames = [{ id: "agents", formerIds: ["schedule"] }];
  assert.equal(projects.renamePackageChoices(renames), 2);
  assert.deepEqual((await projects.get(first.id))?.composition?.packageOverrides, { files: "include", agents: "exclude" });
  // A choice already made for the new id is kept.
  assert.deepEqual((await projects.get(second.id))?.composition?.packageOverrides, { agents: "include" });
  assert.equal((await projects.get(third.id))?.composition, undefined);
  assert.equal(projects.renamePackageChoices(renames), 0);
  const reopened = createProjectService(dir);
  assert.deepEqual((await reopened.get(first.id))?.composition?.packageOverrides, { files: "include", agents: "exclude" });
});

test("a saved on/off choice under a former id applies to the renamed package", async (t) => {
  const { createPackageRegistry } = await import("../src/packages.ts");
  const file = join(temp(t, "polyth-rename-enabled-"), "packages.json");
  const agents = { id: "agents", name: "Agents", description: "Agents.", core: false, enabled: true, hasSettings: false };
  const planner = { id: "planner", name: "Planner", description: "Planner.", core: false, enabled: true, hasSettings: false };
  writeFileSync(file, JSON.stringify({ schedule: false, planner: false }));
  const registry = createPackageRegistry({ file, descriptors: [agents, planner], formerIds: { agents: ["schedule"] } });
  assert.equal(registry.isEnabled("agents"), false, "the person turned Agents off while it was called schedule");
  assert.equal(registry.isEnabled("planner"), false);
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, boolean>;
  assert.equal(saved.agents, false);
  // A choice saved under the current id wins over a stale former one.
  writeFileSync(file, JSON.stringify({ schedule: false, agents: true }));
  assert.equal(createPackageRegistry({ file, descriptors: [agents], formerIds: { agents: ["schedule"] } }).isEnabled("agents"), true);
});
