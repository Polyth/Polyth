import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectService } from "../src/projects.ts";
import { projectRoutes } from "../src/routes/projects.ts";
import type { ProjectComposition } from "@polyth/contracts";

const composition = (): ProjectComposition => ({
  version: 1,
  directions: ["engineering", "research"],
  packageOverrides: { browser: "include" },
});

function fixture(t: { after(fn: () => void): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-project-setup-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const registry = createProjectService(dataDir);
  const space = { spaceId: "space-a" };
  const projects = registry.forSpace(space);
  const route = projectRoutes((() => ({ projects })) as never);
  return { dataDir, projects, route, space };
}

test("setup add commits composition with project creation in one route operation", async (t) => {
  const { dataDir, projects, route, space } = fixture(t);
  const path = join(dataDir, "existing");
  mkdirSync(path);
  let result: unknown;
  assert.equal(await route({
    path: "/api/projects/setup",
    method: "POST",
    space,
    body: async () => ({ mode: "add", path, name: "Composed", composition: composition() }),
    json: (_status: number, body: unknown) => { result = body; },
  } as never), true);
  const project = result as { id: string; composition?: ProjectComposition };
  assert.deepEqual(project.composition, composition());
  assert.deepEqual((await projects.get(project.id))!.composition, composition());
});

test("setup create validates composition before touching the filesystem", async (t) => {
  const { dataDir, projects, route, space } = fixture(t);
  const path = join(dataDir, "must-not-exist");
  await assert.rejects(() => route({
    path: "/api/projects/setup",
    method: "POST",
    space,
    body: async () => ({ mode: "create", path, composition: { version: 2, directions: [] } }),
    json: () => { throw new Error("must not succeed"); },
  } as never), { code: "invalid-input" });
  assert.deepEqual(await projects.list(), []);
  assert.equal((await import("node:fs")).existsSync(path), false);
});

test("setup rejects ambiguous modes instead of guessing project semantics", async (t) => {
  const { route, space } = fixture(t);
  await assert.rejects(() => route({
    path: "/api/projects/setup",
    method: "POST",
    space,
    body: async () => ({ mode: "clone", path: "/tmp/x", composition: composition() }),
    json: () => {},
  } as never), { code: "invalid-input" });
});
