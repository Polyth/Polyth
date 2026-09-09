import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectService } from "../src/projects.ts";

test("project removal publishes the stable project identity after durable deletion", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-project-cleanup-"));
  const root = join(dataDir, "repo");
  mkdirSync(root, { recursive: true });
  const removed: Array<{ id: string; name: string; stillVisible: boolean }> = [];
  let projects: ReturnType<typeof createProjectService>;
  projects = createProjectService(dataDir, {
    onRemoved: async (project) => {
      removed.push({
        id: project.id,
        name: project.name,
        stillVisible: Boolean(await projects.get(project.id)),
      });
    },
  });
  const created = await projects.add(root, "Mutable display name");
  await projects.remove(created.id);

  assert.deepEqual(removed, [{
    id: created.id,
    name: "Mutable display name",
    stillVisible: false,
  }]);
  assert.equal(await projects.get(created.id), undefined);
});

test("project deletion stays canonical when best-effort capability cleanup fails", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-project-cleanup-failure-"));
  const root = join(dataDir, "repo");
  mkdirSync(root, { recursive: true });
  const projects = createProjectService(dataDir, {
    onRemoved: async () => { throw new Error("simulated cleanup failure"); },
  });
  const created = await projects.add(root, "Project");
  await projects.remove(created.id);
  assert.equal(await projects.get(created.id), undefined, "cleanup failure must not resurrect a deleted project");
});
