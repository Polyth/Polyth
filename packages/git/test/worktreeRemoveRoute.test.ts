import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectService, SessionProjection, SessionService } from "@polyth/contracts";
import { gitRoutes } from "../src/serverEntry.ts";
import type { GitService } from "../src/index.ts";

const WT = "/repo-worktrees/wt";

function makeHarness(opts: {
  list: () => Array<{ path: string; branch: string | null }>;
  onRemove?: (input: {
    path: string;
    deleteBranch: boolean;
    force: boolean;
    ownedBranch?: string;
  }) => Promise<{ branchCleanupFailed?: boolean } | void>;
  onMark?: () => Promise<void>;
  sessions?: SessionProjection[];
}) {
  const createCalls: Array<{ branch: string; path?: string; base?: string }> = [];
  const removeCalls: Array<{
    path: string;
    deleteBranch: boolean;
    force: boolean;
    ownedBranch?: string;
  }> = [];
  const markCalls: Array<{ projectId: string; path: string }> = [];
  const git = {
    worktrees: {
      create: async (_root: string, input: { branch: string; path?: string; base?: string }) => {
        createCalls.push(input);
        return { path: input.path ?? "/repo-worktrees/new", branch: input.branch, head: "abc", isMain: false };
      },
      list: async () => opts.list().map((tree) => ({
        path: tree.path, branch: tree.branch, head: "abc", isMain: false,
      })),
      remove: async (
        _root: string,
        input: { path: string; deleteBranch: boolean; force: boolean; ownedBranch?: string },
      ) => {
        removeCalls.push({
          path: input.path,
          deleteBranch: input.deleteBranch,
          force: input.force,
          ...(input.ownedBranch ? { ownedBranch: input.ownedBranch } : {}),
        });
        if (opts.onRemove) return await opts.onRemove(input);
      },
    },
  } as unknown as GitService;
  const routes = gitRoutes({
    projects: {
      get: async (id: string) => (id === "p1" ? { id, path: "/repo", name: "repo" } : undefined),
    } as unknown as ProjectService,
    sessions: {
      list: async () => opts.sessions ?? [],
      markWorktreeMissing: async (projectId: string, path: string) => {
        markCalls.push({ projectId, path });
        if (opts.onMark) await opts.onMark();
      },
    } as unknown as SessionService,
    git,
    commitMessage: async () => "",
  });
  const call = async (
    body: Record<string, unknown> = { projectId: "p1", path: WT },
    path = "/api/worktrees/remove",
  ) => {
    let status = 0;
    let payload: unknown;
    const handled = await routes({
      req: {}, res: {},
      url: new URL(`http://x${path}`),
      path,
      method: "POST",
      body: async () => body,
      json: (code: number, data: unknown) => { status = code; payload = data; },
    } as never);
    return { handled, status, payload };
  };
  return { call, createCalls, removeCalls, markCalls };
}

const present = () => [{ path: WT, branch: "wt/one" }];
const absent = () => [] as Array<{ path: string; branch: string | null }>;

test("active isolation workspace cannot be removed through the generic route", async () => {
  const { call, removeCalls, markCalls } = makeHarness({
    list: present,
    sessions: [{
      id: "s1", projectId: "p1", title: "t", status: "idle",
      createdAt: 1, updatedAt: 1, worktreePath: WT, branch: "polyth/isolate/s1",
      isolation: {
        kind: "git-worktree",
        state: "active",
        worktreePath: WT,
        worktreeBranch: "polyth/isolate/s1",
        targetPath: "/repo",
        targetBranch: "main",
        baseCommit: "abc",
        createdAt: new Date(1).toISOString(),
      },
    } as SessionProjection],
  });

  await assert.rejects(
    () => call(),
    (err: Error & { code?: string }) => err.code === "conflict",
  );
  assert.equal(removeCalls.length, 0);
  assert.equal(markCalls.length, 0);
});

test("managed isolation branch cannot be created through the generic route", async () => {
  const { call, createCalls } = makeHarness({ list: absent });
  await assert.rejects(
    () => call({ projectId: "p1", branch: "polyth/isolate/s1" }, "/api/worktrees"),
    (err: Error & { code?: string }) => err.code === "invalid-input",
  );
  assert.equal(createCalls.length, 0);
});

test("Git success plus mark-missing failure still reports worktree removal success", async () => {
  const { call, removeCalls, markCalls } = makeHarness({
    list: present,
    onMark: async () => { throw new Error("projection write failed"); },
  });
  const result = await call();
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { ok: true, metadataCleanupFailed: true });
  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0]!.force, false);
  assert.equal(markCalls.length, 1);
});

test("already-absent worktree still reconciles metadata", async () => {
  const { call, removeCalls, markCalls } = makeHarness({ list: absent });
  const result = await call();
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { ok: true });
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(markCalls, [{ projectId: "p1", path: WT }]);
});

test("retry after Git success reconciles metadata without treating cleanup as Git failure", async () => {
  let trees = present();
  let markShouldFail = true;
  const { call, removeCalls, markCalls } = makeHarness({
    list: () => trees,
    onRemove: async () => { trees = []; },
    onMark: async () => {
      if (markShouldFail) throw new Error("first mark failed");
    },
  });
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal((first.payload as { metadataCleanupFailed?: boolean }).metadataCleanupFailed, true);
  assert.equal(removeCalls.length, 1);

  markShouldFail = false;
  const second = await call();
  assert.equal(second.status, 200);
  assert.deepEqual(second.payload, { ok: true });
  assert.equal(removeCalls.length, 2);
  assert.equal(markCalls.length, 2);
});

test("dirty Git refusal does not mark sessions missing", async () => {
  const { call, markCalls } = makeHarness({
    list: present,
    onRemove: async () => {
      throw Object.assign(new Error("dirty"), { code: "worktree-dirty", changes: 2 });
    },
  });
  await assert.rejects(
    () => call(),
    (err: Error & { code?: string }) => err.code === "worktree-dirty",
  );
  assert.equal(markCalls.length, 0);
});

test("GitService remove failure is not converted into HTTP 200", async () => {
  const { call, removeCalls, markCalls } = makeHarness({
    list: present,
    onRemove: async () => {
      throw Object.assign(new Error("remove and verification failed"), { code: "git-failed" });
    },
  });
  await assert.rejects(
    () => call(),
    (err: Error & { code?: string }) => err.code === "git-failed",
  );
  assert.equal(removeCalls.length, 1);
  assert.equal(markCalls.length, 0);
});

test("branch deletion success is ok without cleanup flags", async () => {
  const { call, removeCalls } = makeHarness({
    list: present,
    sessions: [{
      id: "s1", projectId: "p1", title: "t", status: "idle",
      createdAt: 1, updatedAt: 1, worktreePath: WT, branch: "wt/one",
    } as SessionProjection],
  });
  const result = await call({ projectId: "p1", path: WT, deleteBranch: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { ok: true });
  assert.equal(removeCalls[0]!.deleteBranch, true);
  assert.equal(removeCalls[0]!.ownedBranch, "wt/one");
});

test("branch deletion failure after physical success is a warning, not HTTP 500", async () => {
  const { call } = makeHarness({
    list: present,
    onRemove: async () => ({ branchCleanupFailed: true }),
  });
  const result = await call({ projectId: "p1", path: WT, deleteBranch: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { ok: true, branchCleanupFailed: true });
});

test("retry after worktree gone still requests owned branch cleanup", async () => {
  const { call, removeCalls } = makeHarness({
    list: absent,
    sessions: [{
      id: "s1", projectId: "p1", title: "t", status: "idle",
      createdAt: 1, updatedAt: 1, worktreePath: WT, branch: "wt/one",
    } as SessionProjection],
    onRemove: async (input) => {
      if (!input.ownedBranch) return { branchCleanupFailed: true };
    },
  });
  const result = await call({ projectId: "p1", path: WT, deleteBranch: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { ok: true });
  assert.equal(removeCalls.length, 1);
  assert.equal(removeCalls[0]!.ownedBranch, "wt/one");
});

test("already-absent worktree without identifiable branch reports branchCleanupFailed", async () => {
  const { call } = makeHarness({
    list: absent,
    onRemove: async () => ({ branchCleanupFailed: true }),
  });
  const result = await call({ projectId: "p1", path: WT, deleteBranch: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { ok: true, branchCleanupFailed: true });
});

test("client-supplied branch name is ignored for cleanup identity", async () => {
  const { call, removeCalls } = makeHarness({
    list: present,
    sessions: [{
      id: "s1", projectId: "p1", title: "t", status: "idle",
      createdAt: 1, updatedAt: 1, worktreePath: WT, branch: "wt/one",
    } as SessionProjection],
  });
  await call({ projectId: "p1", path: WT, deleteBranch: true, branch: "main" });
  assert.equal(removeCalls[0]!.ownedBranch, "wt/one");
  assert.notEqual(removeCalls[0]!.ownedBranch, "main");
});

test("remove plus verification failure with deleteBranch still does not mark missing", async () => {
  const { call, markCalls } = makeHarness({
    list: present,
    sessions: [{
      id: "s1", projectId: "p1", title: "t", status: "idle",
      createdAt: 1, updatedAt: 1, worktreePath: WT, branch: "wt/one",
    } as SessionProjection],
    onRemove: async () => {
      throw Object.assign(new Error("remove and verification failed"), { code: "git-failed" });
    },
  });
  await assert.rejects(
    () => call({ projectId: "p1", path: WT, deleteBranch: true }),
    (err: Error & { code?: string }) => err.code === "git-failed",
  );
  assert.equal(markCalls.length, 0);
});
