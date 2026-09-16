import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectService } from "../src/projects.ts";
import type { ProjectComposition } from "@polyth/contracts";
const composition = (): ProjectComposition => ({ version: 1, directions: ["research", "wellbeing"], packageOverrides: { markets: "exclude" } });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-composition-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const root = join(dir, "work"); mkdirSync(root);
  return { dir, root, file: join(dir, "projects.json"), registry: createProjectService(dir) };
}
test("composition is durable from creation and all returned/input nested values are detached", async (t) => {
  const { dir, root, registry } = fixture(t); const input = composition();
  const project = await registry.add(root, "Research", input);
  input.directions.length = 0; project.composition!.packageOverrides.markets = "include";
  assert.deepEqual((await registry.get(project.id))!.composition, composition());
  assert.deepEqual((await createProjectService(dir).get(project.id))!.composition, composition());
  const read = (await registry.list())[0]!; read.composition!.directions.length = 0;
  assert.deepEqual((await registry.get(project.id))!.composition, composition());
});
test("reads and deduplicated add leave a legacy project and its file byte-for-byte unchanged", async (t) => {
  const { root, file, registry } = fixture(t);
  const project = await registry.add(root, "Existing"); const before = readFileSync(file, "utf8");
  assert.equal((await registry.get(project.id))!.composition, undefined);
  assert.equal((await registry.add(root, "Ignored", composition())).composition, undefined);
  assert.equal(readFileSync(file, "utf8"), before);
});
test("invalid composition/default/icon patches never publish earlier valid field changes", async (t) => {
  const { root, file, registry } = fixture(t); const project = await registry.add(root, "Original", composition());
  const before = readFileSync(file, "utf8");
  for (const bad of [
    { name: "Changed", composition: { version: 99 } },
    { name: "Changed", icon: "data:unsafe" },
    { name: "Changed", composition: { ...composition(), directions: ["engineering"] }, defaults: { rememberModelSelection: "yes" } },
  ]) {
    await assert.rejects(() => registry.update!(project.id, bad as never), { code: "invalid-input" });
    assert.deepEqual(await registry.get(project.id), project);
    assert.equal(readFileSync(file, "utf8"), before);
  }
});
test("failed atomic file replacement does not publish the staged composition", async (t) => {
  const { root, file, registry } = fixture(t); const project = await registry.add(root, "Original");
  const before = readFileSync(file, "utf8"); rmSync(file); mkdirSync(file);
  await assert.rejects(() => registry.update!(project.id, { composition: composition() }));
  assert.deepEqual(await registry.get(project.id), project);
  rmSync(file, { recursive: true }); writeFileSync(file, before);
});
test("invalid composition fails before creating a directory or project", async (t) => {
  const { dir, registry } = fixture(t); const path = join(dir, "must-not-exist");
  await assert.rejects(() => registry.create(path, "Invalid", { version: 2 } as never), { code: "invalid-input" });
  assert.equal(existsSync(path), false); assert.deepEqual(await registry.list(), []);
});
test("Space A cannot inspect or modify Space B composition even when they share a path", async (t) => {
  const { root, registry } = fixture(t);
  const a = registry.forSpace({ spaceId: "a" }); const b = registry.forSpace({ spaceId: "b" });
  const pa = await a.add(root, "A", composition()); const pb = await b.add(root, "B");
  assert.equal(await a.get(pb.id), undefined);
  await assert.rejects(() => a.update!(pb.id, { composition: composition() }), { code: "not-found" });
  await a.update!(pa.id, { composition: null });
  assert.equal((await a.get(pa.id))!.composition, undefined);
  assert.deepEqual(await b.get(pb.id), pb);
});
test("an explicit reset preserves defaults and all other project metadata", async (t) => {
  const { root, registry } = fixture(t); const project = await registry.add(root, "Original", composition());
  await registry.update!(project.id, { defaults: { rememberModelSelection: true }, color: "#123abc" });
  const reset = await registry.update!(project.id, { composition: null });
  assert.equal(reset.composition, undefined); assert.deepEqual(reset.defaults, { rememberModelSelection: true });
  assert.equal(reset.color, "#123abc");
});
test("undefined composition is an omitted patch field, not a reset", async (t) => {
  const { root, registry } = fixture(t); const project = await registry.add(root, "Original", composition());
  const updated = await registry.update!(project.id, { name: "Renamed", composition: undefined });
  assert.equal(updated.name, "Renamed"); assert.deepEqual(updated.composition, composition());
});
test("composition and current project-icon normalization commit atomically", async (t) => {
  const { root, registry } = fixture(t); const project = await registry.add(root, "Original");
  const engineering: ProjectComposition = { version: 1, directions: ["engineering"], packageOverrides: {} };
  const safeSvg = "data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%201%201%22%3E%3Cpath%20d%3D%22M0%200h1v1H0z%22/%3E%3C/svg%3E";
  const updated = await registry.update!(project.id, { composition: engineering, icon: safeSvg });
  assert.deepEqual(updated.composition, engineering);
  assert.match(updated.icon ?? "", /^data:image\/svg\+xml;base64,/);
  const committedIcon = updated.icon;

  const finance: ProjectComposition = { version: 1, directions: ["finance"], packageOverrides: {} };
  const unsafeSvg = "data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C/script%3E%3C/svg%3E";
  await assert.rejects(() => registry.update!(project.id, { composition: finance, icon: unsafeSvg }), { code: "invalid-input" });
  const after = await registry.get(project.id);
  assert.deepEqual(after!.composition, engineering);
  assert.equal(after!.icon, committedIcon);
});
test("canonical PATCH route persists composition and the old organization route does not intercept it", async (t) => {
  const { projectRoutes } = await import("../src/routes/projects.ts");
  const { orgRoutes } = await import("../src/routes/org.ts");
  const { root, registry } = fixture(t);
  const scope = { spaceId: "scope" }; const projects = registry.forSpace(scope);
  const project = await projects.add(root, "Original");
  const path = `/api/projects/${encodeURIComponent(project.id)}`;
  const oldRoute = orgRoutes({ spaces: (() => { throw new Error("must not resolve a Space for another route"); }) as never, store: {} as never });
  assert.equal(await oldRoute({ path, method: "PATCH", get space() { throw new Error("must not read Space"); } } as never), false);
  const route = projectRoutes((() => ({ projects })) as never);
  let output: unknown; let status = 0;
  assert.equal(await route({
    path, method: "PATCH", space: scope,
    body: async () => ({ composition: composition() }),
    json: (code: number, data: unknown) => { status = code; output = data; },
  } as never), true);
  assert.equal(status, 200);
  assert.deepEqual(output, await projects.get(project.id));
  assert.deepEqual((await projects.get(project.id))!.composition, composition());
});
test("canonical PATCH route rejects invalid composition without committing the other fields", async (t) => {
  const { projectRoutes } = await import("../src/routes/projects.ts");
  const { root, registry } = fixture(t); const project = await registry.add(root, "Original");
  const route = projectRoutes((() => ({ projects: registry })) as never);
  await assert.rejects(() => route({
    path: `/api/projects/${project.id}`, method: "PATCH", space: { spaceId: "scope" },
    body: async () => ({ name: "Must not change", composition: { version: 2 } }),
    json: () => { throw new Error("must not return success"); },
  } as never), { code: "invalid-input" });
  assert.deepEqual(await registry.get(project.id), project);
});
