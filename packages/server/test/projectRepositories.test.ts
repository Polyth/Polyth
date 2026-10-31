import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectService } from "../src/projects.ts";
import { testTenancy } from "./support/spaces.ts";

function gitRepository(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path);
  execFileSync("git", ["-C", path, "init", "--quiet"], { stdio: "ignore" });
  return path;
}

test("repository add preserves the legacy primary and survives reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-repositories-"));
  const projectRoot = join(dir, "project");
  mkdirSync(projectRoot);
  const repositoryRoot = gitRepository(dir, "api");
  const projects = createProjectService(dir);
  const project = await projects.add(projectRoot, "Workspace");

  const updated = await projects.update!(project.id, {
    repository: { action: "add", path: repositoryRoot, alias: "API" },
  });
  assert.equal(updated.path, projectRoot);
  assert.deepEqual(updated.repositories, [
    { id: "primary", alias: "Workspace", path: projectRoot },
    { id: updated.repositories?.[1]?.id, alias: "API", path: repositoryRoot },
  ]);
  assert.equal(updated.primaryRepositoryId, "primary");

  const reopened = createProjectService(dir);
  assert.deepEqual(await reopened.get!(project.id), updated);
  const persisted = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8")) as Array<{ path: string }>;
  assert.equal(persisted[0]?.path, projectRoot);
});

test("repository add is idempotent across symlink aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-repositories-"));
  const projectRoot = join(dir, "project");
  mkdirSync(projectRoot);
  const repositoryRoot = gitRepository(dir, "api");
  const symlink = join(dir, "api-link");
  symlinkSync(repositoryRoot, symlink, "dir");
  const projects = createProjectService(dir);
  const project = await projects.add(projectRoot);

  const first = await projects.update!(project.id, { repository: { action: "add", path: repositoryRoot, alias: "API" } });
  const second = await projects.update!(project.id, { repository: { action: "add", path: symlink, alias: "Ignored" } });
  assert.equal(second.repositories?.length, 2);
  assert.deepEqual(second.repositories, first.repositories);
});

test("repository add requires a local Git directory and bounds aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-repositories-"));
  const projectRoot = join(dir, "project");
  const plainDirectory = join(dir, "plain");
  mkdirSync(projectRoot);
  mkdirSync(plainDirectory);
  const projects = createProjectService(dir);
  const project = await projects.add(projectRoot);

  await assert.rejects(
    () => projects.update!(project.id, { repository: { action: "add", path: plainDirectory } }),
    (error: Error & { code?: string }) => error.code === "invalid-input" && /Git repository/.test(error.message),
  );
  const repositoryRoot = gitRepository(dir, "valid");
  await assert.rejects(
    () => projects.update!(project.id, { repository: { action: "add", path: repositoryRoot, alias: "x".repeat(81) } }),
    (error: Error & { code?: string }) => error.code === "invalid-input" && /alias/.test(error.message),
  );
});

test("repository mutations preserve tenant not-found behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-repositories-"));
  const projectRoot = join(dir, "project");
  mkdirSync(projectRoot);
  const projects = createProjectService(dir);
  const tenancy = await testTenancy({ dataDir: dir, projects });
  const own = tenancy.services(tenancy.defaultContext).projects;
  const foreign = tenancy.services(tenancy.addSpace("Other")).projects;
  const project = await own.add(projectRoot);

  await assert.rejects(
    () => foreign.update!(project.id, { repository: { action: "add", path: "/definitely/not/a/path" } }),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
  await assert.rejects(
    () => own.update!(project.id, { repository: { action: "remove", repositoryId: "missing" } }),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
});

test("rename and metadata-only removal keep the primary and files intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-repositories-"));
  const projectRoot = join(dir, "project");
  mkdirSync(projectRoot);
  const repositoryRoot = gitRepository(dir, "api");
  const projects = createProjectService(dir);
  const project = await projects.add(projectRoot, "Workspace");
  const added = await projects.update!(project.id, { repository: { action: "add", path: repositoryRoot } });
  const repositoryId = added.repositories?.find((repository) => repository.id !== "primary")?.id;
  assert.ok(repositoryId);

  const renamed = await projects.update!(project.id, {
    repository: { action: "rename", repositoryId, alias: "Backend" },
  });
  assert.equal(renamed.repositories?.find((repository) => repository.id === repositoryId)?.alias, "Backend");
  await assert.rejects(
    () => projects.update!(project.id, { repository: { action: "remove", repositoryId: "primary" } }),
    (error: Error & { code?: string }) => error.code === "invalid-input" && /primary repository cannot/.test(error.message),
  );

  const removed = await projects.update!(project.id, { repository: { action: "remove", repositoryId } });
  assert.deepEqual(removed.repositories, [{ id: "primary", alias: "Workspace", path: projectRoot }]);
  assert.equal(existsSync(repositoryRoot), true);
});



test("primary defaults change without retargeting existing scalar sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-primary-"));
  try {
    const app = gitRepository(dir, "app");
    const api = gitRepository(dir, "api");
    const projects = createProjectService(dir);
    const project = await projects.add(app);
    const added = await projects.update!(project.id, { repository: { action: "add", path: api } });
    const secondary = added.repositories!.find((row) => row.path === api)!;
    const updated = await projects.update!(project.id, { repository: { action: "make-primary", repositoryId: secondary.id } });
    const { workspaceExecutionPath } = await import("@polyth/contracts/workspace");
    assert.equal(updated.primaryRepositoryId, secondary.id);
    assert.equal(updated.path, app);
    assert.equal(workspaceExecutionPath(updated), api);
    assert.equal(workspaceExecutionPath(updated, { id: "old", projectId: project.id }), app);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("locating a moved repository verifies persisted identity and keeps credentials private", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-relocate-"));
  try {
    const app = gitRepository(dir, "app");
    const oldPath = gitRepository(dir, "api");
    execFileSync("git", ["-C", oldPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial"], { stdio: "ignore" });
    execFileSync("git", ["-C", oldPath, "remote", "add", "origin", "https://fixture-user:fixture-password@example.invalid/api.git"]);
    const projects = createProjectService(dir);
    const project = await projects.add(app);
    const added = await projects.update!(project.id, { repository: { action: "add", path: oldPath } });
    const secondary = added.repositories!.find((row) => row.path === oldPath)!;
    const moved = join(dir, "moved-api");
    renameSync(oldPath, moved);
    const repaired = await projects.update!(project.id, { repository: { action: "relocate", repositoryId: secondary.id, path: moved } });
    assert.equal(repaired.repositories!.find((row) => row.id === secondary.id)!.path, moved);
    assert.equal("repositoryIdentities" in repaired, false);
    const saved = readFileSync(join(dir, "projects.json"), "utf8");
    assert.doesNotMatch(saved, /fixture-password|fixture-user|example.invalid/);
    const other = gitRepository(dir, "unrelated");
    await assert.rejects(() => projects.update!(project.id, { repository: { action: "relocate", repositoryId: secondary.id, path: other } }), /identity could not be verified/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
