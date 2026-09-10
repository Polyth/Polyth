import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import { packageWorkspace } from "@polyth/plugins";
import { createProjectService } from "../src/projects.ts";

const space = (root: string, spaceId: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: join(root, "spaces", spaceId),
});

const storage = (ctx: SpaceContext): SpaceStorage => ({
  root: resolve(ctx.storageDir),
  packageDir(packageId) {
    return join(resolve(ctx.storageDir), "packages", packageId);
  },
  path(relative) {
    return join(resolve(ctx.storageDir), relative);
  },
});

test("package workspace is runtime-visible but absent from user project lists", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-package-workspace-"));
  const projects = createProjectService(root);
  const ctx = space(root, "space-a");
  const workspace = await packageWorkspace({
    pluginId: "personal-coach",
    projects,
    spaceStorage: storage,
  }, ctx);

  assert.match(workspace.projectId, /^__polyth_pkg_[a-f0-9]{32}$/);
  assert.equal(workspace.cwd, join(resolve(ctx.storageDir), "packages", "personal-coach", "workspace"));
  assert.equal((await projects.get(workspace.projectId))?.path, workspace.cwd);
  assert.equal((await projects.forSpace(ctx).get(workspace.projectId))?.spaceId, ctx.spaceId);
  assert.equal((await projects.list()).some((project) => project.id === workspace.projectId), false);
  assert.equal((await projects.forSpace(ctx).list()).some((project) => project.id === workspace.projectId), false);

  await assert.rejects(
    () => projects.forSpace(ctx).remove(workspace.projectId),
    (cause: Error & { code?: string }) => cause.code === "not-found",
  );
});

test("package workspace ownership is Space-scoped and survives registry restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-package-workspace-"));
  let projects = createProjectService(root);
  const a = space(root, "space-a");
  const b = space(root, "space-b");
  const host = (pluginId: string) => ({ pluginId, projects, spaceStorage: storage });

  const first = await packageWorkspace(host("personal-coach"), a);
  const otherSpace = await packageWorkspace(host("personal-coach"), b);
  const otherPackage = await packageWorkspace(host("knowledge"), a);
  assert.notEqual(first.projectId, otherSpace.projectId);
  assert.notEqual(first.projectId, otherPackage.projectId);
  assert.equal(await projects.forSpace(b).get(first.projectId), undefined);

  projects = createProjectService(root);
  const restored = await packageWorkspace(host("personal-coach"), a);
  assert.equal(restored.projectId, first.projectId);
  assert.equal(restored.cwd, first.cwd);
  assert.equal((await projects.list()).length, 0);
});

test("ordinary projects remain visible and mutable", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-package-workspace-"));
  const projects = createProjectService(root);
  const ctx = space(root, "space-a");
  const path = join(root, "ordinary");
  const project = await projects.forSpace(ctx).create(path, "Ordinary");
  await packageWorkspace({ pluginId: "personal-coach", projects, spaceStorage: storage }, ctx);

  assert.deepEqual((await projects.forSpace(ctx).list()).map((item) => item.id), [project.id]);
  assert.equal((await projects.forSpace(ctx).update?.(project.id, { name: "Renamed" }))?.name, "Renamed");
  await projects.forSpace(ctx).remove(project.id);
  assert.equal((await projects.forSpace(ctx).list()).length, 0);
});
