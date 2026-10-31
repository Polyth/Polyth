import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CreateSessionInput, Project, SessionProjection, SessionWorkspace } from "@polyth/contracts";
import { transitionIsolation } from "@polyth/contracts";
import { createGitService } from "../src/index.ts";
import { createManagedWorktrees } from "../src/managedWorktrees.ts";
import { createIsolationService, type IsolationSessionApi } from "../src/sessionIntegration.ts";

const git = createGitService();
const roots: string[] = [];
process.on("exit", () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function makeRepo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `polyth-life-${name}-`)); roots.push(root);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main"); run("config", "user.name", "Test"); run("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "README.md"), `${name}\n`); run("add", "."); run("commit", "-qm", "initial"); return root;
}

function fixture(options: { failRemove?: boolean } = {}) {
  const app = makeRepo("app"); const api = makeRepo("api");
  const project: Project = { id: "p", name: "P", path: app, repositories: [{ id: "app", alias: "App", path: app }, { id: "api", alias: "API", path: api }], primaryRepositoryId: "app", createdAt: Date.now() };
  const projections = new Map<string, SessionProjection>(); const releases: string[] = []; let releaseRejected = false;
  const sessions: IsolationSessionApi = {
    async create(input: CreateSessionInput) { const id = input.id ?? randomUUID(); const now = Date.now(); projections.set(id, { id, projectId: input.projectId, title: input.title ?? "S", status: "idle", createdAt: now, updatedAt: now, ...(input.workspace ? { workspace: structuredClone(input.workspace) } : {}), ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}), ...(input.isolation ? { isolation: structuredClone(input.isolation) } : {}) }); return { id }; },
    async snapshot(id) { const value = projections.get(id); if (!value) throw Object.assign(new Error("missing"), { code: "not-found" }); return structuredClone(value); },
    async list() { return [...projections.values()].map((value) => structuredClone(value)); },
    async send() { return {}; },
    async patchWorkspace(id, workspace, expectedRevision) {
      const current = projections.get(id)!;
      if (expectedRevision !== undefined && (current.workspace?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("stale"), { code: "conflict" });
      const next = { ...current, workspace: structuredClone(workspace) };
      projections.set(id, next);
      return structuredClone(next);
    },
    async withWorkspaceMutation(id, expected, mutate) {
      const current = projections.get(id)!; if ((current.workspace?.revision ?? 0) !== expected) throw Object.assign(new Error("stale"), { code: "conflict" });
      if (releaseRejected) throw Object.assign(new Error("release rejected"), { code: "conflict" });
      releases.push("released");
      let currentValue = structuredClone(projections.get(id)!);
      const result = await mutate({ snapshot: async () => structuredClone(currentValue), commit: async (workspace: SessionWorkspace, scalar) => { currentValue = { ...currentValue, workspace: structuredClone(workspace), ...(scalar?.worktreePath === null ? {} : scalar?.worktreePath ? { worktreePath: scalar.worktreePath } : {}), ...(scalar?.isolation === null ? {} : scalar?.isolation ? { isolation: structuredClone(scalar.isolation) } : {}) }; projections.set(id, currentValue); return structuredClone(currentValue); } });
      return result;
    },
  };
  const realManaged = createManagedWorktrees(git); let failRemove = options.failRemove === true;
  const managed = { ...realManaged, async removeOwned(...args: Parameters<typeof realManaged.removeOwned>) { if (failRemove) throw Object.assign(new Error("cleanup failed"), { code: "unavailable" }); return realManaged.removeOwned(...args); } };
  const service = createIsolationService({ git, managed, sessions, projects: { get: async (id) => id === project.id ? project : undefined, list: async () => [project] }, append: async () => undefined, readEvents: async () => [{ id: "e", sessionId: "x", seq: 1, time: Date.now(), type: "turn/stopped", data: { reason: "completed" }, v: 1 }] });
  return { app, api, project, sessions, service, releases, setReleaseRejected: (value: boolean) => { releaseRejected = value; }, setFailRemove: (value: boolean) => { failRemove = value; }, projections };
}

test("secondary discard releases first and preserves execution anchor and sibling", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" }); const before = await ctx.sessions.snapshot(created.id); const secondary = before.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  await ctx.service.discardRepository!(created.id, "api");
  const after = await ctx.sessions.snapshot(created.id);
  assert.equal(ctx.releases[0], "released"); assert.equal(after.workspace?.executionRepositoryId, "app"); assert.ok(after.workspace?.repositories.some((row) => row.repositoryId === "app")); assert.equal(after.workspace?.repositories.some((row) => row.repositoryId === "api"), false); assert.equal((await git.worktrees.list(ctx.api)).some((row) => resolve(row.path) === resolve(secondary.path)), false);
});

test("secondary merge publishes its branch while preserving the execution anchor", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" }); const before = await ctx.sessions.snapshot(created.id); const secondary = before.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  const run = (...args: string[]) => execFileSync("git", args, { cwd: secondary.path, stdio: "pipe" });
  writeFileSync(join(secondary.path, "merged.txt"), "merged\n"); run("add", "."); run("commit", "-qm", "secondary change");
  const result = await ctx.service.mergeRepository!(created.id, "api");
  const after = await ctx.sessions.snapshot(created.id);
  assert.equal(result.ok, true); assert.equal(after.workspace?.executionRepositoryId, "app"); assert.ok(after.workspace?.repositories.some((row) => row.repositoryId === "app")); assert.equal(readFileSync(join(ctx.api, "merged.txt"), "utf8"), "merged\n");
});

test("release rejection leaves execution checkout and refs untouched", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" }); const before = await ctx.sessions.snapshot(created.id); ctx.setReleaseRejected(true);
  await assert.rejects(() => ctx.service.discardRepository!(created.id, "api"), /release rejected/);
  const after = await ctx.sessions.snapshot(created.id); assert.deepEqual(after.workspace, before.workspace); assert.equal((await git.worktrees.list(ctx.api)).filter((row) => !row.isMain).length, 1);
});

test("anchor discard rebinds to a replacement and preserves the sibling row", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  await ctx.service.discardRepository!(created.id, "app");
  const after = await ctx.sessions.snapshot(created.id); assert.equal(after.workspace?.executionRepositoryId, "api"); assert.equal(after.workspace?.repositories.some((row) => row.repositoryId === "app"), false); assert.ok(after.workspace?.repositories.some((row) => row.repositoryId === "api"));
});

test("cleanup failure leaves a durable cleanup-pending row for recovery", async () => {
  const ctx = fixture({ failRemove: true }); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  await assert.rejects(() => ctx.service.discardRepository!(created.id, "api"), /cleanup failed/);
  const after = await ctx.sessions.snapshot(created.id); const row = after.workspace?.repositories.find((candidate) => candidate.repositoryId === "api");
  assert.equal(row?.state, "missing"); assert.equal(row?.isolation?.state, "cleanup-pending");
});

test("restart recovery retries a pending secondary cleanup through the canonical seam", async () => {
  const ctx = fixture({ failRemove: true }); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  await assert.rejects(() => ctx.service.discardRepository!(created.id, "api"), /cleanup failed/);
  ctx.setFailRemove(false);
  const recovered = await ctx.service.recoverRepository!(created.id, "api");
  assert.equal(recovered.workspace?.repositories.some((row) => row.repositoryId === "api"), false);
  assert.equal(recovered.workspace?.executionRepositoryId, "app");
  assert.equal(ctx.releases.length, 2);
});

test("restart recovery preserves an uncertain secondary publication without replay", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  const current = ctx.projections.get(created.id)!;
  const rows = current.workspace!.repositories.map((row) => row.repositoryId === "api"
    ? { ...row, isolation: transitionIsolation(row.isolation!, { state: "publishing", publish: { expectedTargetSha: "0".repeat(40), resultCommit: "1".repeat(40), snapshotSha: "2".repeat(40), targetRef: "refs/heads/main", receiptRef: `refs/polyth/isolation/${created.id}`, checkoutPath: row.isolation!.originPath ?? row.isolation!.targetPath } }) }
    : row);
  ctx.projections.set(created.id, { ...current, workspace: { ...current.workspace!, repositories: rows } });
  const before = await ctx.sessions.snapshot(created.id);
  const recovered = await ctx.service.recoverRepository!(created.id, "api");
  assert.deepEqual(recovered.workspace, before.workspace);
  // Unknown publication is observational only; recovery must not acquire the
  // mutation seam or release a runtime before a proven receipt exists.
  assert.equal(ctx.releases.length, 0);
});

test("restart recovery preserves an uncertain anchor publication and sibling row", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  const current = ctx.projections.get(created.id)!;
  const rows = current.workspace!.repositories.map((row) => row.repositoryId === "app"
    ? { ...row, isolation: transitionIsolation(row.isolation!, { state: "publishing", publish: { expectedTargetSha: "0".repeat(40), resultCommit: "1".repeat(40), snapshotSha: "2".repeat(40), targetRef: "refs/heads/main", receiptRef: `refs/polyth/isolation/${created.id}`, checkoutPath: row.isolation!.originPath ?? row.isolation!.targetPath } }) }
    : row);
  ctx.projections.set(created.id, { ...current, workspace: { ...current.workspace!, repositories: rows } });
  const before = await ctx.sessions.snapshot(created.id);
  const recovered = await ctx.service.recoverRepository!(created.id, "app");
  assert.deepEqual(recovered.workspace, before.workspace);
  assert.equal(recovered.workspace?.executionRepositoryId, "app");
  assert.ok(recovered.workspace?.repositories.some((row) => row.repositoryId === "api"));
});

test("recoverAll finalizes a published secondary row and preserves the registered repository", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  const current = ctx.projections.get(created.id)!;
  const apiRow = current.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  const sourceSnapshotSha = await git.revParse(apiRow.path, "HEAD");
  execFileSync("git", ["update-ref", `refs/polyth/isolation/${created.id}`, sourceSnapshotSha], { cwd: ctx.api, stdio: "pipe" });
  const rows = current.workspace!.repositories.map((row) => row.repositoryId === "api"
    ? { ...row, isolation: transitionIsolation(row.isolation!, { state: "cleanup-pending", resultCommit: sourceSnapshotSha, sourceSnapshotSha }) }
    : row);
  ctx.projections.set(created.id, { ...current, workspace: { ...current.workspace!, repositories: rows } });
  await ctx.service.recoverAll();
  const recovered = await ctx.sessions.snapshot(created.id);
  const retained = recovered.workspace?.repositories.find((row) => row.repositoryId === "api");
  assert.equal(retained?.isolation, undefined);
  assert.equal(retained?.path, ctx.api);
  assert.equal(recovered.workspace?.executionRepositoryId, "app");
});

test("recoverAll retains a published row when its source was edited after the snapshot", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  const current = ctx.projections.get(created.id)!;
  const apiRow = current.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  const sourceSnapshotSha = await git.revParse(apiRow.path, "HEAD");
  execFileSync("git", ["update-ref", `refs/polyth/isolation/${created.id}`, sourceSnapshotSha], { cwd: ctx.api, stdio: "pipe" });
  writeFileSync(join(apiRow.path, "unexpected.txt"), "edited after publication\n");
  const rows = current.workspace!.repositories.map((row) => row.repositoryId === "api"
    ? { ...row, isolation: transitionIsolation(row.isolation!, { state: "cleanup-pending", resultCommit: sourceSnapshotSha, sourceSnapshotSha }) }
    : row);
  ctx.projections.set(created.id, { ...current, workspace: { ...current.workspace!, repositories: rows } });
  await ctx.service.recoverAll();
  const recovered = await ctx.sessions.snapshot(created.id);
  const retained = recovered.workspace?.repositories.find((row) => row.repositoryId === "api");
  assert.equal(retained?.isolation?.state, "cleanup-pending");
  assert.equal(readFileSync(join(apiRow.path, "unexpected.txt"), "utf8"), "edited after publication\n");
});

test("recoverAll dispatches a row-only session without scalar isolation", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  const current = ctx.projections.get(created.id)!;
  const apiRow = current.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  const commit = await git.revParse(apiRow.path, "HEAD");
  execFileSync("git", ["update-ref", `refs/polyth/isolation/${created.id}`, commit], { cwd: ctx.api, stdio: "pipe" });
  const rows = current.workspace!.repositories.map((row) => row.repositoryId === "api"
    ? { ...row, isolation: transitionIsolation(row.isolation!, { state: "cleanup-pending", resultCommit: commit, sourceSnapshotSha: commit }) }
    : row);
  ctx.projections.set(created.id, { ...current, isolation: undefined, workspace: { ...current.workspace!, repositories: rows } });
  await ctx.service.recoverAll();
  const recovered = await ctx.sessions.snapshot(created.id);
  assert.equal(recovered.workspace?.repositories.find((row) => row.repositoryId === "api")?.isolation, undefined);
});

test("membership updates remove omitted ordinary rows while retaining managed evidence", async () => {
  const ctx = fixture(); const created = await ctx.service.createIsolatedSession({ projectId: "p" });
  const current = ctx.projections.get(created.id)!;
  ctx.projections.set(created.id, { ...current, workspace: { ...current.workspace!, repositories: [...current.workspace!.repositories, { repositoryId: "ordinary", alias: "Ordinary", path: ctx.app, state: "ready" }] } });
  const updated = await ctx.service.updateIsolatedWorkspace!(created.id, { repositoryIds: ["app", "api"] });
  assert.equal(updated.workspace?.repositories.some((row) => row.repositoryId === "ordinary"), false);
  assert.equal(updated.workspace?.repositories.filter((row) => row.isolation).length, 2);
});
