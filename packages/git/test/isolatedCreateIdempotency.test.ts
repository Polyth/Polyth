// Keyed isolated create: a phone that lost the POST /api/isolation/sessions
// response resends the same clientOperationId. The resend must return the same
// canonical session and its managed checkout — never a second worktree/branch —
// and a leftover checkout without a canonical row stays fail-closed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CreateSessionInput, SessionProjection, SessionRef, SpaceContext } from "@polyth/contracts";
import { sessionIdForCreateOperation } from "@polyth/session/create-operation";
import { createGitService } from "../src/index.ts";
import { isolateBranchName, MANAGED_BRANCH_PREFIX } from "../src/managedWorktrees.ts";
import { createIsolationService, type IsolationSessionApi } from "../src/sessionIntegration.ts";
import { isolationRoutes } from "../src/serverEntry.ts";

const git = createGitService();
const dirs: string[] = [];
process.on("exit", () => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-iso-key-"));
  dirs.push(dir);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  run("add", ".");
  run("commit", "-qm", "init");
  return dir;
};

const managedBranches = (root: string): string[] => execFileSync(
  "git", ["for-each-ref", "--format=%(refname:short)", `refs/heads/${MANAGED_BRANCH_PREFIX}`],
  { cwd: root, stdio: "pipe" },
).toString().split("\n").filter(Boolean);
const worktreeCount = (root: string): number => execFileSync(
  "git", ["worktree", "list", "--porcelain"], { cwd: root, stdio: "pipe" },
).toString().split("\n").filter((line) => line.startsWith("worktree ")).length;

function harness(root: string) {
  const projections = new Map<string, SessionProjection>();
  let creates = 0;
  let gate: Promise<void> | undefined;
  const sessions: IsolationSessionApi = {
    async create(input: CreateSessionInput): Promise<SessionRef> {
      creates += 1;
      await gate;
      const id = input.id ?? randomUUID();
      if (projections.has(id)) throw Object.assign(new Error("session already exists"), { code: "conflict" });
      const now = Date.now();
      projections.set(id, {
        id, projectId: input.projectId, title: input.title || "New session", status: "idle", createdAt: now, updatedAt: now,
        ...(input.worktreePath ? { worktreePath: input.worktreePath, worktreeState: "ready" as const } : {}),
        ...(input.isolation ? { isolation: input.isolation } : {}),
      });
      return { id };
    },
    async snapshot(sessionId) {
      const projection = projections.get(sessionId);
      if (!projection) throw Object.assign(new Error("not found"), { code: "not-found" });
      return { ...projection };
    },
    async list() { return [...projections.values()]; },
    async send() { return {}; },
    async patchIsolation() { throw new Error("unused"); },
    async rebindWorkspace() { throw new Error("unused"); },
  } as IsolationSessionApi;
  const isolation = createIsolationService({
    git,
    sessions,
    projects: { get: async (id) => id === "p1" ? { id, path: root } : undefined, list: async () => [{ id: "p1", path: root }] },
    append: async () => {},
    readEvents: async () => [],
    closeWorkspaceProcesses: async () => {},
  });
  return {
    isolation, projections,
    creates: () => creates,
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { gate = undefined; release(); };
    },
  };
}

test("a resend for the same key returns the first isolated session and allocates no second worktree", async () => {
  const root = repo();
  const h = harness(root);
  const sessionId = randomUUID();
  const first = await h.isolation.createIsolatedSession({ projectId: "p1", title: "A" }, { sessionId });
  assert.equal(first.id, sessionId);
  const again = await h.isolation.createIsolatedSession({ projectId: "p1", title: "A" }, { sessionId });
  assert.deepEqual(again, { id: sessionId });
  assert.equal(h.creates(), 1);
  assert.deepEqual(managedBranches(root), [isolateBranchName(sessionId)]);
  assert.equal(worktreeCount(root), 2, "main checkout + exactly one managed worktree");
});

test("a resend that overtakes the in-flight original waits for it instead of racing a second allocation", async () => {
  const root = repo();
  const h = harness(root);
  const sessionId = randomUUID();
  const release = h.hold();
  const original = h.isolation.createIsolatedSession({ projectId: "p1" }, { sessionId });
  while (h.creates() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const resend = h.isolation.createIsolatedSession({ projectId: "p1" }, { sessionId });
  release();
  assert.deepEqual(await resend, await original);
  assert.equal(h.creates(), 1);
  assert.equal(managedBranches(root).length, 1);
});

test("a resend after a settled failure reports the rejection and leaves the preserved checkout alone", async () => {
  const root = repo();
  const h = harness(root);
  const sessionId = randomUUID();
  await h.isolation.createIsolatedSession({ projectId: "p1" }, { sessionId });
  h.projections.set(sessionId, { ...h.projections.get(sessionId)!, status: "failed" });
  await assert.rejects(
    h.isolation.createIsolatedSession({ projectId: "p1" }, { sessionId }),
    (error: { code?: string; mutationOutcome?: string; sessionId?: string }) =>
      error.code === "session-create-failed" && error.mutationOutcome === "rejected" && error.sessionId === sessionId,
  );
  assert.equal(h.creates(), 1);
  assert.equal(managedBranches(root).length, 1);
});

test("a leftover managed checkout without a canonical row fails closed and is not rolled back", async () => {
  const root = repo();
  const h = harness(root);
  const sessionId = randomUUID();
  // A crash between checkout allocation and the canonical create.
  await h.isolation.managed.create({ root, sessionId, targetBranch: "main", targetPath: root });
  await assert.rejects(
    h.isolation.createIsolatedSession({ projectId: "p1" }, { sessionId }),
    (error: { code?: string }) => error.code === "conflict",
  );
  assert.equal(h.creates(), 0);
  assert.deepEqual(managedBranches(root), [isolateBranchName(sessionId)], "the ambiguous resource is preserved for recovery");
  assert.equal(worktreeCount(root), 2);
});

test("POST /api/isolation/sessions derives the canonical id from (account, Space, key)", async () => {
  const root = repo();
  const h = harness(root);
  const route = isolationRoutes({ isolation: h.isolation as never });
  const space = { spaceId: "spc_home", userId: "usr_1" } as SpaceContext;
  const post = async (body: Record<string, unknown>, ctx: SpaceContext = space) => {
    let response: { status: number; body: unknown } | undefined;
    await route({
      path: "/api/isolation/sessions",
      method: "POST",
      url: new URL("http://local/api/isolation/sessions"),
      body: async () => body,
      json: (status: number, value: unknown) => { response = { status, body: value }; },
      space: ctx,
    } as never);
    return response!;
  };
  const key = randomUUID();
  const first = await post({ projectId: "p1", clientOperationId: key });
  assert.deepEqual(first.body, { id: sessionIdForCreateOperation(key, space) });
  assert.deepEqual((await post({ projectId: "p1", clientOperationId: key.toUpperCase() })).body, first.body);
  assert.equal(h.creates(), 1);
  const otherSpace = await post({ projectId: "p1", clientOperationId: key }, { ...space, spaceId: "spc_work" });
  assert.notDeepEqual(otherSpace.body, first.body, "the same token in another Space is a different session");
  await assert.rejects(post({ projectId: "p1", clientOperationId: "nope" }), (error: { code?: string }) => error.code === "invalid-input");
  assert.equal(managedBranches(root).length, 2);
});
