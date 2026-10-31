import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreateSessionInput,
  SessionIsolation,
  SessionProjection,
  SessionRef,
} from "@polyth/contracts";
import { createGitService } from "../src/index.ts";
import { createIsolationService, type IsolationSessionApi } from "../src/sessionIntegration.ts";

const git = createGitService();
const dirs: string[] = [];

process.on("exit", () => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-polyth-isolate`, { recursive: true, force: true });
    rmSync(`${dir}-polyth-integrate`, { recursive: true, force: true });
  }
});

const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-delegated-"));
  dirs.push(dir);
  runGit(dir, "init", "-q", "-b", "main");
  runGit(dir, "config", "user.email", "t@example.com");
  runGit(dir, "config", "user.name", "Test");
  runGit(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, "shared.txt"), "one\ntwo\nthree\n");
  runGit(dir, "add", ".");
  runGit(dir, "commit", "-qm", "init");
  return dir;
};

const clone = (isolation: SessionIsolation | undefined): SessionIsolation | undefined =>
  isolation ? JSON.parse(JSON.stringify(isolation)) as SessionIsolation : undefined;

/** Canonical-session stand-in: just enough projection state for the
 *  isolation lifecycle, including parent links. */
const makeSessions = () => {
  const projections = new Map<string, SessionProjection>();
  const copy = (projection: SessionProjection): SessionProjection => ({ ...projection, isolation: clone(projection.isolation) });
  const api: IsolationSessionApi & { projections: typeof projections; setStatus(id: string, status: SessionProjection["status"]): void } = {
    projections,
    setStatus(id, status) {
      projections.set(id, { ...projections.get(id)!, status });
    },
    async create(input: CreateSessionInput): Promise<SessionRef> {
      const id = input.id ?? randomUUID();
      const now = Date.now();
      projections.set(id, {
        id,
        projectId: input.projectId,
        title: input.title || "New session",
        status: "idle",
        createdAt: now,
        updatedAt: now,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(input.worktreePath ? { worktreePath: input.worktreePath, worktreeState: "ready" as const } : {}),
        ...(input.isolation ? { isolation: clone(input.isolation) } : {}),
      });
      return { id };
    },
    async snapshot(sessionId) {
      const projection = projections.get(sessionId);
      if (!projection) throw Object.assign(new Error("not found"), { code: "not-found" });
      return copy(projection);
    },
    async list() {
      return [...projections.values()].map(copy);
    },
    async send() {
      return {};
    },
    async patchIsolation(sessionId, isolation) {
      const current = projections.get(sessionId)!;
      const next: SessionProjection = { ...current, updatedAt: Date.now() };
      if (isolation) next.isolation = clone(isolation);
      else delete next.isolation;
      projections.set(sessionId, next);
      return copy(next);
    },
    async rebindWorkspace(sessionId, input) {
      const current = projections.get(sessionId)!;
      const next: SessionProjection = { ...current, updatedAt: Date.now() };
      if (input.worktreePath === null) {
        delete next.worktreePath;
        delete next.worktreeState;
      } else if (typeof input.worktreePath === "string") {
        next.worktreePath = input.worktreePath;
        next.worktreeState = "ready";
      }
      if (input.branch) next.branch = input.branch;
      if (input.isolation === null) delete next.isolation;
      else if (input.isolation) next.isolation = clone(input.isolation);
      projections.set(sessionId, next);
      return copy(next);
    },
  };
  return api;
};

const harness = (root: string) => {
  const sessions = makeSessions();
  const isolation = createIsolationService({
    git,
    sessions,
    projects: {
      get: async (id) => id === "p1" ? { id, path: root } : undefined,
      list: async () => [{ id: "p1", path: root }],
    },
    append: async () => undefined,
    readEvents: async () => [],
    closeWorkspaceProcesses: async () => undefined,
  });
  return { sessions, isolation };
};

test("a delegated child of a main-checkout parent branches from it and merges straight back", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const parent = await sessions.create({ projectId: "p1", title: "Orchestrator" });
  writeFileSync(join(root, "parent-dirty.txt"), "not committed\n");

  const created = await isolation.createDelegatedSession({ parentSessionId: parent.id, title: "Worker" });
  const child = await sessions.snapshot(created.id);
  assert.equal(child.parentId, parent.id, "the child is a canonical subagent of the parent");
  assert.equal(created.isolation.targetBranch, "main");
  assert.equal(created.isolation.originPath, resolve(root));
  assert.equal(created.isolation.sourceSessionId, parent.id);
  assert.equal(created.isolation.baseCommit, runGit(root, "rev-parse", "HEAD"));
  assert.equal(created.originUncommitted, 1, "the parent learns what the child cannot see");
  assert.equal(existsSync(join(created.isolation.worktreePath, "parent-dirty.txt")), false);

  writeFileSync(join(created.isolation.worktreePath, "feature.txt"), "from the worker\n");
  const [summary] = await isolation.delegatedChildren(parent.id);
  assert.equal(summary?.sessionId, created.id);
  assert.equal(summary?.hasChanges, true);
  assert.equal(summary?.state, "active");

  const merged = await isolation.mergeDelegated(created.id);
  assert.equal(merged.merged, true);
  assert.equal(merged.finalized, true);
  assert.equal(merged.targetBranch, "main");
  assert.equal(runGit(root, "show", "main:feature.txt"), "from the worker");
  assert.equal(readFileSync(join(root, "parent-dirty.txt"), "utf8"), "not committed\n", "parent work is carried forward");
  const after = await sessions.snapshot(created.id);
  assert.equal(after.isolation, undefined);
  assert.equal(existsSync(created.isolation.worktreePath), false);
  assert.deepEqual(await isolation.delegatedChildren(parent.id), []);
});

test("an isolated parent's child nests into the parent's workspace, and the parent cannot merge until it is merged", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const mainBefore = runGit(root, "rev-parse", "main");
  const parentRef = await isolation.createIsolatedSession({ projectId: "p1", title: "Isolated orchestrator" });
  const parent = await sessions.snapshot(parentRef.id);
  const parentWorktree = parent.isolation!.worktreePath;
  writeFileSync(join(parentWorktree, "plan.md"), "parent plan\n");
  runGit(parentWorktree, "add", "plan.md");
  runGit(parentWorktree, "commit", "-qm", "plan");
  const parentHead = runGit(parentWorktree, "rev-parse", "HEAD");

  const created = await isolation.createDelegatedSession({ parentSessionId: parent.id, title: "Nested worker" });
  assert.equal(created.isolation.targetBranch, parent.isolation!.worktreeBranch, "merge-back targets the parent's managed branch");
  assert.equal(created.isolation.originPath, resolve(parentWorktree));
  assert.equal(created.isolation.baseCommit, parentHead);
  assert.equal(readFileSync(join(created.isolation.worktreePath, "plan.md"), "utf8"), "parent plan\n");

  // While the child holds isolated work, the parent's checkout must survive.
  writeFileSync(join(parentWorktree, "own.txt"), "parent change\n");
  await assert.rejects(() => isolation.mergeBack(parent.id), (error: Error & { reason?: string; sessionIds?: string[] }) => {
    assert.match(error.message, /Delegated agents still have isolated work/);
    assert.equal(error.reason, "delegated-pending");
    assert.deepEqual(error.sessionIds, [created.id]);
    return true;
  });
  await assert.rejects(() => isolation.discard(parent.id), /Delegated agents still have isolated work/);
  await assert.rejects(() => isolation.cleanupForSessionDelete(parent, async () => undefined), /another session still depends/);
  const status = await isolation.getStatus(parent.id);
  assert.equal(status.delegated?.length, 1);
  assert.equal(status.delegated?.[0]?.sessionId, created.id);
  assert.equal(status.actions?.canMerge, false);
  assert.equal(status.actions?.canDiscard, false);
  assert.equal(runGit(root, "rev-parse", "main"), mainBefore, "nothing reached main");

  writeFileSync(join(created.isolation.worktreePath, "nested.txt"), "nested work\n");
  const merged = await isolation.mergeDelegated(created.id);
  assert.equal(merged.merged, true);
  assert.equal(merged.targetBranch, parent.isolation!.worktreeBranch);
  assert.equal(runGit(parentWorktree, "show", "HEAD:nested.txt"), "nested work");
  assert.equal(readFileSync(join(parentWorktree, "nested.txt"), "utf8"), "nested work\n", "the parent's checkout is synchronized");
  assert.equal(readFileSync(join(parentWorktree, "own.txt"), "utf8"), "parent change\n", "the parent's own edits survive");
  const child = await sessions.snapshot(created.id);
  assert.equal(child.isolation, undefined);
  assert.equal(child.worktreePath, resolve(parentWorktree), "a merged child returns to the parent's checkout");
  assert.equal(existsSync(created.isolation.worktreePath), false);

  // Everything now travels to main through the parent's own merge.
  const published = await isolation.mergeBack(parent.id);
  assert.equal(published.finalized, true);
  assert.equal(runGit(root, "show", "main:nested.txt"), "nested work");
  assert.equal(runGit(root, "show", "main:plan.md"), "parent plan");
  assert.equal(runGit(root, "show", "main:own.txt"), "parent change");
  assert.equal(existsSync(parentWorktree), false);
  const relocated = await sessions.snapshot(created.id);
  assert.equal(relocated.worktreePath, resolve(root), "the finished child follows its parent back to main");
});

test("merging a delegated child without changes only releases its checkout", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const parentRef = await isolation.createIsolatedSession({ projectId: "p1", title: "Parent" });
  const created = await isolation.createDelegatedSession({ parentSessionId: parentRef.id, title: "Reader" });
  const before = runGit(root, "rev-parse", (await sessions.snapshot(parentRef.id)).isolation!.worktreeBranch);
  const result = await isolation.mergeDelegated(created.id);
  assert.equal(result.merged, false);
  assert.equal(result.finalized, true);
  assert.equal((await sessions.snapshot(created.id)).isolation, undefined);
  assert.equal(existsSync(created.isolation.worktreePath), false);
  assert.equal(runGit(root, "rev-parse", (await sessions.snapshot(parentRef.id)).isolation!.worktreeBranch), before);
});

test("overlapping uncommitted parent work is refused without an AI repair, then merges after the parent commits", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const parentRef = await isolation.createIsolatedSession({ projectId: "p1", title: "Parent" });
  const parentWorktree = (await sessions.snapshot(parentRef.id)).isolation!.worktreePath;
  const created = await isolation.createDelegatedSession({ parentSessionId: parentRef.id, title: "Editor" });
  writeFileSync(join(created.isolation.worktreePath, "shared.txt"), "one\ntwo\nchild three\n");
  writeFileSync(join(parentWorktree, "shared.txt"), "one\ntwo\nparent three\n");
  const parentHead = runGit(parentWorktree, "rev-parse", "HEAD");

  await assert.rejects(() => isolation.mergeDelegated(created.id), (error: Error & { code?: string; reason?: string; files?: string[] }) => {
    assert.equal(error.code, "conflict");
    assert.equal(error.reason, "target-overlap");
    assert.deepEqual(error.files, ["shared.txt"]);
    return true;
  });
  const refused = await sessions.snapshot(created.id);
  assert.equal(refused.isolation?.state, "merge-ready");
  assert.equal(refused.isolation?.targetRepair, undefined, "no AI repair receipt is prepared for a delegated merge");
  assert.equal(runGit(parentWorktree, "rev-parse", "HEAD"), parentHead);
  assert.equal(readFileSync(join(parentWorktree, "shared.txt"), "utf8"), "one\ntwo\nparent three\n");

  // Once the parent commits, the same edit is an ordinary merge conflict the
  // child can be asked to resolve.
  runGit(parentWorktree, "commit", "-qam", "parent edit");
  await assert.rejects(() => isolation.mergeDelegated(created.id), (error: Error & { files?: string[] }) => {
    assert.deepEqual(error.files, ["shared.txt"]);
    return true;
  });
  const [summary] = await isolation.delegatedChildren(parentRef.id);
  assert.equal(summary?.state, "conflict");
  assert.deepEqual(summary?.conflictFiles, ["shared.txt"]);
});

test("a running delegated child reports no result yet, and discard needs the child settled", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const parent = await sessions.create({ projectId: "p1", title: "Parent" });
  const created = await isolation.createDelegatedSession({ parentSessionId: parent.id, title: "Busy worker" });
  writeFileSync(join(created.isolation.worktreePath, "wip.txt"), "wip\n");
  sessions.setStatus(created.id, "working");
  const [running] = await isolation.delegatedChildren(parent.id);
  assert.equal(running?.status, "working");
  assert.equal(running?.hasChanges, false);
  assert.equal(running?.revision, "");
  await assert.rejects(() => isolation.discard(created.id), /still running/);
  sessions.setStatus(created.id, "idle");
  await isolation.discard(created.id);
  assert.equal(existsSync(created.isolation.worktreePath), false);
  assert.deepEqual(await isolation.delegatedChildren(parent.id), []);
});

test("delegation into a managed checkout requires it to belong to the parent's own lineage", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const owner = await isolation.createIsolatedSession({ projectId: "p1", title: "Owner" });
  const ownerWorktree = (await sessions.snapshot(owner.id)).isolation!.worktreePath;
  const stranger = await sessions.create({ projectId: "p1", title: "Stranger", worktreePath: ownerWorktree });
  await assert.rejects(
    () => isolation.createDelegatedSession({ parentSessionId: stranger.id, title: "Hijack" }),
    /does not belong to the parent or its ancestors/,
  );
  // A shared child of the owner may delegate into the owner's checkout.
  const sharedChild = await sessions.create({ projectId: "p1", title: "Shared", parentId: owner.id, worktreePath: ownerWorktree });
  const nested = await isolation.createDelegatedSession({ parentSessionId: sharedChild.id, title: "Grandchild" });
  assert.equal(nested.isolation.originPath, resolve(ownerWorktree));
  assert.equal(nested.isolation.sourceSessionId, sharedChild.id);
  assert.equal((await isolation.delegatedChildren(sharedChild.id)).length, 1);
  await assert.rejects(() => isolation.mergeBack(owner.id), /Delegated agents still have isolated work/);
  // The public isolation entry point still refuses ordinary nesting.
  await assert.rejects(
    () => isolation.createIsolatedSession({ projectId: "p1", sourceSessionId: owner.id }),
    /nested session isolation is not supported/,
  );
});
