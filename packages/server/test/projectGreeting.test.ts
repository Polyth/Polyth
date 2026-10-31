import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectPatch } from "@polyth/contracts";
import { createProjectService } from "../src/projects.ts";

test("project greeting can be customised, hidden and restored to the default", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-project-greeting-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const projects = createProjectService(join(root, "data"));
  const project = await projects.add(workspace, "Project");
  assert.equal(project.greeting, undefined);

  const custom = await projects.update(project.id, { greeting: "  Ship   {project}  today " });
  assert.equal(custom.greeting, "Ship {project} today");

  const hidden = await projects.update(project.id, { greeting: "" });
  assert.equal(hidden.greeting, "");
  assert.equal((await projects.get(project.id))?.greeting, "");

  const restored = await projects.update(project.id, { greeting: null });
  assert.equal("greeting" in restored, false);

  await assert.rejects(projects.update(project.id, { greeting: "x".repeat(161) }), { code: "invalid-input" });
  await assert.rejects(projects.update(project.id, { greeting: 7 } as unknown as ProjectPatch), { code: "invalid-input" });
});
