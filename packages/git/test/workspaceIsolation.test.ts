import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CreateSessionInput, Project, SessionProjection, SessionWorkspace } from "@polyth/contracts";
import { createGitService } from "../src/index.ts";
import { createManagedWorktrees, type ManagedWorktreeService } from "../src/managedWorktrees.ts";
import { createIsolationService } from "../src/sessionIntegration.ts";

const git = createGitService();
const dirs: string[] = [];
process.on("exit", () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const makeRepo = (label: string): string => {
  const root = mkdtempSync(join(tmpdir(), `polyth-multi-${label}-`));
  dirs.push(root);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Polyth Test");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), `${label}\n`);
  run("add", ".");
  run("commit", "-qm", "initial");
  return root;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture() {
  const app = makeRepo("app");
  const api = makeRepo("api");
  const project: Project = {
    id: "project",
    name: "Project",
    path: app,
    repositories: [
      { id: "app", alias: "App", path: app },
      { id: "api", alias: "API", path: api },
    ],
    primaryRepositoryId: "app",
    createdAt: Date.now(),
  };
  const projections = new Map<string, SessionProjection>();
  const sessions = {
    async create(input: CreateSessionInput) {
      const id = input.id ?? randomUUID();
      const now = Date.now();
      projections.set(id, {
        id,
        projectId: input.projectId,
        title: input.title ?? "New session",
        status: "idle",
        createdAt: now,
        updatedAt: now,
        ...(input.workspace ? { workspace: clone(input.workspace) } : {}),
        ...(input.worktreePath ? { worktreePath: input.worktreePath, worktreeState: "ready" as const } : {}),
        ...(input.isolation ? { isolation: clone(input.isolation) } : {}),
      });
      return { id };
    },
    async snapshot(id: string) {
      const value = projections.get(id);
      if (!value) throw Object.assign(new Error("not found"), { code: "not-found" });
      return clone(value);
    },
    async list() { return [...projections.values()].map(clone); },
    async send() { return {}; },
    async patchIsolation(id: string, isolation: NonNullable<SessionProjection["isolation"]> | null) {
      const value = projections.get(id)!;
      const next = { ...value, ...(isolation ? { isolation: clone(isolation) } : {}) };
      if (!isolation) delete next.isolation;
      projections.set(id, next);
      return clone(next);
    },
    async patchWorkspace(id: string, workspace: SessionWorkspace) {
      const value = projections.get(id)!;
      const next = { ...value, workspace: clone(workspace) };
      projections.set(id, next);
      return clone(next);
    },
    async rebindWorkspace() { throw new Error("unused"); },
  };
  const managed = createManagedWorktrees(git);
  const service = createIsolationService({
    git,
    managed,
    sessions,
    projects: { get: async (id) => id === project.id ? project : undefined, list: async () => [project] },
    append: async () => undefined,
  });
  return { app, api, project, projections, sessions, managed, service };
}

test("isolated creation allocates one owned checkout per selected repository", async () => {
  const ctx = fixture();
  const created = await ctx.service.createIsolatedSession({ projectId: "project" });
  const session = await ctx.sessions.snapshot(created.id);
  assert.equal(session.workspace?.repositories.length, 2);
  assert.equal(session.workspace?.executionRepositoryId, "app");
  assert.equal(session.isolation?.targetPath, resolve(ctx.app));
  for (const row of session.workspace!.repositories) {
    assert.equal(row.state, "ready");
    assert.ok(row.isolation);
    assert.ok(existsSync(row.path));
    assert.equal((await ctx.managed.inspect(row.isolation!.targetPath, row.path))?.meta.sessionId, created.id);
  }
});

test("scalar target branch applies only to the execution repository", async () => {
  const ctx = fixture();
  execFileSync("git", ["branch", "feature"], { cwd: ctx.app, stdio: "pipe" });
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-multi-feature-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(ctx.app, { branch: "feature", path: featureWt });

  const created = await ctx.service.createIsolatedSession({
    projectId: "project",
    targetBranch: "feature",
  });
  const session = await ctx.sessions.snapshot(created.id);
  const app = session.workspace!.repositories.find((row) => row.repositoryId === "app")!;
  const api = session.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  assert.equal(app.isolation?.targetBranch, "feature");
  assert.equal(app.isolation?.originPath, resolve(featureWt));
  assert.equal(api.isolation?.targetBranch, "main");
  assert.equal(api.isolation?.originPath, resolve(ctx.api));
});

test("primary-excluded subset executes from its selected repository", async () => {
  const ctx = fixture();
  const created = await ctx.service.createIsolatedSession({ projectId: "project", repositoryIds: ["api"] });
  const session = await ctx.sessions.snapshot(created.id);
  assert.deepEqual(session.workspace?.repositories.map((row) => row.repositoryId), ["api"]);
  assert.equal(session.workspace?.executionRepositoryId, "api");
  assert.equal(session.isolation?.targetPath, resolve(ctx.api));
});

test("partial allocation failure rolls back only proven owned checkouts", async () => {
  const ctx = fixture();
  const real = ctx.managed;
  let creates = 0;
  const managed = {
    ...real,
    async create(input: Parameters<ManagedWorktreeService["create"]>[0]) {
      creates += 1;
      if (creates === 2) throw Object.assign(new Error("secondary allocation failed"), { code: "unavailable" });
      return real.create(input);
    },
  } as ManagedWorktreeService;
  const service = createIsolationService({
    git, managed, sessions: ctx.sessions,
    projects: { get: async () => ctx.project, list: async () => [ctx.project] },
    append: async () => undefined,
  });
  await assert.rejects(() => service.createIsolatedSession({ projectId: "project" }), /secondary allocation failed/);
  assert.equal((await git.worktrees.list(ctx.app)).filter((row) => !row.isMain).length, 0);
  assert.equal((await git.worktrees.list(ctx.api)).filter((row) => !row.isMain).length, 0);
});

test("restart recovery scans every repository and deletion releases once then removes all", async () => {
  const ctx = fixture();
  const created = await ctx.service.createIsolatedSession({ projectId: "project" });
  const before = await ctx.sessions.snapshot(created.id);
  const restarted = createIsolationService({
    git, managed: ctx.managed, sessions: ctx.sessions,
    projects: { get: async () => ctx.project, list: async () => [ctx.project] },
    append: async () => undefined,
  });
  await restarted.recoverAll();
  const recovered = await ctx.sessions.snapshot(created.id);
  assert.deepEqual(recovered.workspace?.repositories.map((row) => row.path), before.workspace?.repositories.map((row) => row.path));
  const released: string[] = [];
  const closed: string[] = [];
  await restarted.cleanupForSessionDelete(recovered, async (cwd) => { released.push(cwd); });
  // closeWorkspaceProcesses is optional in the fixture; ownership is still
  // verified and every Git checkout is removed by the deletion owner.
  assert.equal(released.length, 1);
  assert.equal((await git.worktrees.list(ctx.app)).filter((row) => !row.isMain).length, 0);
  assert.equal((await git.worktrees.list(ctx.api)).filter((row) => !row.isMain).length, 0);
  assert.deepEqual(closed, []);
});

test("idle isolated sessions can lazily materialize an additional repository", async () => {
  const ctx = fixture();
  const created = await ctx.service.createIsolatedSession({ projectId: "project", repositoryIds: ["app"] });
  const next = await ctx.service.materializeRepositories(created.id, ["app", "api"]);
  assert.deepEqual(next.workspace?.repositories.map((row) => row.repositoryId), ["app", "api"]);
  const apiRow = next.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  assert.ok(apiRow.isolation);
  assert.ok(existsSync(apiRow.path));
});

test("deletion refuses an unknown checkout without removing other repositories", async () => {
  const ctx = fixture();
  const created = await ctx.service.createIsolatedSession({ projectId: "project" });
  const session = await ctx.sessions.snapshot(created.id);
  const secondary = session.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  secondary.isolation = { ...secondary.isolation!, worktreeBranch: "polyth/isolate/foreign" };
  await assert.rejects(
    () => ctx.service.cleanupForSessionDelete(session, async () => undefined),
    /ownership is not proven/,
  );
  assert.equal((await git.worktrees.list(ctx.app)).filter((row) => !row.isMain).length, 1);
  assert.equal((await git.worktrees.list(ctx.api)).filter((row) => !row.isMain).length, 1);
});

test("legacy scalar lifecycle operations refuse multi-repository sessions", async () => {
  const ctx = fixture();
  const created = await ctx.service.createIsolatedSession({ projectId: "project" });
  const status = await ctx.service.getStatus(created.id);
  assert.ok(status.actions);
  assert.equal(status.actions.canMerge, false);
  assert.equal(status.actions.canDiscard, false);
  await assert.rejects(() => ctx.service.mergeBack(created.id), /multi-repository isolation/);
  await assert.rejects(() => ctx.service.keepIsolated(created.id), /multi-repository isolation/);
});
