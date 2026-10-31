import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreateSessionInput,
  JsonObject,
  SessionIsolation,
  SessionProjection,
  SessionRef,
} from "@polyth/contracts";
import { createGitService } from "../src/index.ts";
import { isolateBranchName } from "../src/managedWorktrees.ts";
import { createIsolationService, type IsolationSessionApi } from "../src/sessionIntegration.ts";
import { isolationRoutes } from "../src/serverEntry.ts";
import type { IsolationService } from "../src/sessionIntegration.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "polyth-isolate-existing-"));
  dirs.push(dir);
  runGit(dir, "init", "-q", "-b", "main");
  runGit(dir, "config", "user.email", "t@example.com");
  runGit(dir, "config", "user.name", "Test");
  runGit(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  runGit(dir, "add", ".");
  runGit(dir, "commit", "-qm", "init");
  return dir;
};

const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

/** Canonical-session stand-in. `rebindWorkspace` publishes the workspace
 *  first and the scalar isolation last, like the core rebind, so a failure
 *  injected between the two leaves the half-published state a lost epoch does. */
const makeSessions = () => {
  const projections = new Map<string, SessionProjection>();
  const control = { failRebind: undefined as undefined | "before" | "after-publish", rebinds: 0 };
  const api: IsolationSessionApi & { projections: typeof projections; control: typeof control } = {
    projections,
    control,
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
        ...(input.workspace ? { workspace: clone(input.workspace) } : {}),
        ...(input.isolation ? { isolation: clone(input.isolation) } : {}),
      });
      return { id };
    },
    async snapshot(sessionId) {
      const projection = projections.get(sessionId);
      if (!projection) throw Object.assign(new Error("not found"), { code: "not-found" });
      return clone(projection);
    },
    async list() {
      return [...projections.values()].map(clone);
    },
    async send() {
      return {};
    },
    async patchIsolation(sessionId, isolation) {
      const next: SessionProjection = { ...projections.get(sessionId)!, updatedAt: Date.now() };
      if (isolation) next.isolation = clone(isolation);
      else delete next.isolation;
      if (next.workspace) {
        next.workspace = {
          ...next.workspace,
          repositories: next.workspace.repositories.map((row) => row.repositoryId === next.workspace!.executionRepositoryId
            ? { ...row, isolation: isolation ? clone(isolation) : undefined }
            : row),
        };
      }
      projections.set(sessionId, next);
      return clone(next);
    },
    async rebindWorkspace(sessionId, input) {
      control.rebinds += 1;
      if (control.failRebind === "before") throw Object.assign(new Error("release refused"), { code: "conflict" });
      const current = projections.get(sessionId)!;
      if (input.expectedWorkspaceRevision !== undefined && input.expectedWorkspaceRevision !== (current.workspace?.revision ?? 0)) {
        throw Object.assign(new Error("workspace revision is stale"), { code: "conflict" });
      }
      const next: SessionProjection = { ...current, updatedAt: Date.now() };
      if (input.workspace) next.workspace = { ...clone(input.workspace), revision: (current.workspace?.revision ?? 0) + 1 };
      if (input.worktreePath === null) {
        delete next.worktreePath;
        delete next.worktreeState;
      } else if (typeof input.worktreePath === "string") {
        next.worktreePath = input.worktreePath;
        next.worktreeState = "ready";
      }
      if (input.branch) next.branch = input.branch;
      projections.set(sessionId, next);
      if (control.failRebind === "after-publish") {
        control.failRebind = undefined;
        throw Object.assign(new Error("epoch unconfirmed"), { code: "outcome-unknown" });
      }
      const finished: SessionProjection = { ...next };
      if (input.isolation === null) delete finished.isolation;
      else if (input.isolation) finished.isolation = clone(input.isolation);
      projections.set(sessionId, finished);
      return clone(finished);
    },
  };
  return api;
};

const harness = (root: string) => {
  const sessions = makeSessions();
  const notices: Array<{ sessionId: string; type: string; data: JsonObject }> = [];
  const isolation = createIsolationService({
    git,
    sessions,
    projects: {
      get: async (id) => id === "p1" ? { id, path: root } : undefined,
      list: async () => [{ id: "p1", path: root }],
    },
    append: async (sessionId, type, data) => { notices.push({ sessionId, type, data }); },
    readEvents: async () => [],
    closeWorkspaceProcesses: async () => undefined,
  });
  return { sessions, isolation, notices };
};

test("an ordinary chat moves into its own checkout from the one it works in, and merges straight back", async () => {
  const root = repo();
  const { sessions, isolation, notices } = harness(root);
  const ref = await sessions.create({ projectId: "p1", title: "Shared chat" });
  writeFileSync(join(root, "draft.txt"), "uncommitted, maybe another chat's\n");
  const head = runGit(root, "rev-parse", "HEAD");

  const result = await isolation.isolateSession(ref.id);
  const meta = result.session.isolation as SessionIsolation;
  assert.ok(meta, "the scalar isolation record is published");
  assert.equal(result.targetBranch, "main");
  assert.equal(result.originUncommitted, 1);
  assert.equal(meta.worktreeBranch, isolateBranchName(ref.id));
  assert.equal(meta.originPath, resolve(root));
  assert.equal(meta.baseCommit, head);
  assert.equal(meta.sourceSessionId, undefined, "a chat without a parent has no delegator");
  assert.equal(result.session.worktreePath, meta.worktreePath);
  assert.equal(result.session.workspace?.repositories[0]?.isolation?.worktreePath, meta.worktreePath);
  assert.equal(runGit(meta.worktreePath, "rev-parse", "HEAD"), head);
  assert.equal(existsSync(join(meta.worktreePath, "draft.txt")), false, "uncommitted work is not carried");
  assert.equal(readFileSync(join(root, "draft.txt"), "utf8"), "uncommitted, maybe another chat's\n");
  assert.deepEqual(notices.map((notice) => [notice.type, notice.data]), [
    ["isolation/started", { targetBranch: "main", originUncommitted: 1 }],
  ]);

  const status = await isolation.getStatus(ref.id);
  assert.equal(status.isolation?.state, "active");

  writeFileSync(join(meta.worktreePath, "feature.txt"), "isolated work\n");
  const merged = await isolation.mergeBack(ref.id);
  assert.equal(merged.finalized, true);
  assert.equal(runGit(root, "show", "main:feature.txt"), "isolated work");
  const after = await sessions.snapshot(ref.id);
  assert.equal(after.isolation, undefined);
  assert.equal(existsSync(meta.worktreePath), false);
});

test("a running, archived or already isolated chat is refused without allocating a checkout", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const running = await sessions.create({ projectId: "p1" });
  sessions.projections.set(running.id, { ...sessions.projections.get(running.id)!, status: "working" });
  await assert.rejects(() => isolation.isolateSession(running.id), /still running/);
  const archived = await sessions.create({ projectId: "p1" });
  sessions.projections.set(archived.id, { ...sessions.projections.get(archived.id)!, status: "archived" });
  await assert.rejects(() => isolation.isolateSession(archived.id), /archived/);
  const isolated = await isolation.createIsolatedSession({ projectId: "p1" });
  await assert.rejects(() => isolation.isolateSession(isolated.id), /already isolated/);
  // A conversation has no agent and no runtime workspace to move.
  const conversation = await sessions.create({ projectId: "p1" });
  sessions.projections.set(conversation.id, { ...sessions.projections.get(conversation.id)!, purpose: "conversation" });
  await assert.rejects(() => isolation.isolateSession(conversation.id), /conversation cannot be isolated/);
  assert.equal(sessions.control.rebinds, 0);
  for (const id of [running.id, archived.id, conversation.id]) {
    assert.throws(() => runGit(root, "rev-parse", "--verify", isolateBranchName(id)));
  }
});

test("a refused rebind removes the new checkout; the chat stays where it was", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const ref = await sessions.create({ projectId: "p1" });
  sessions.control.failRebind = "before";
  await assert.rejects(() => isolation.isolateSession(ref.id), /release refused/);
  const session = await sessions.snapshot(ref.id);
  assert.equal(session.isolation, undefined);
  assert.equal(session.worktreePath, undefined);
  assert.throws(() => runGit(root, "rev-parse", "--verify", isolateBranchName(ref.id)), "the managed branch is gone");
  assert.equal(runGit(root, "worktree", "list").split("\n").length, 1);
});

test("an unconfirmed epoch keeps the published checkout and a retry finishes the same isolation", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const ref = await sessions.create({ projectId: "p1" });
  sessions.control.failRebind = "after-publish";
  await assert.rejects(() => isolation.isolateSession(ref.id), /epoch unconfirmed/);
  const half = await sessions.snapshot(ref.id);
  const row = half.workspace?.repositories[0];
  assert.ok(row?.isolation, "the workspace already names the managed checkout");
  assert.equal(half.isolation, undefined);
  assert.equal(existsSync(row.isolation.worktreePath), true, "evidence is preserved");

  const retried = await isolation.isolateSession(ref.id);
  assert.equal(retried.session.isolation?.worktreePath, row.isolation.worktreePath, "no second checkout");
  assert.equal(runGit(root, "worktree", "list").split("\n").length, 2);
  await assert.rejects(() => isolation.isolateSession(ref.id), /already isolated/);
});

test("a shared child of an isolated parent nests into the parent's checkout and blocks its merge", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const parentRef = await isolation.createIsolatedSession({ projectId: "p1", title: "Isolated parent" });
  const parent = await sessions.snapshot(parentRef.id);
  const parentWorktree = parent.isolation!.worktreePath;
  const child = await sessions.create({ projectId: "p1", parentId: parent.id, worktreePath: parentWorktree });

  const result = await isolation.isolateSession(child.id);
  const meta = result.session.isolation!;
  assert.equal(meta.targetBranch, parent.isolation!.worktreeBranch);
  assert.equal(meta.originPath, resolve(parentWorktree));
  assert.equal(meta.sourceSessionId, parent.id, "the parent sees the child as its delegated work");
  await assert.rejects(() => isolation.mergeBack(parent.id), /Delegated agents still have isolated work/);
});

test("the isolate route reads and rebinds through the requester's scoped sessions", async () => {
  const calls: unknown[] = [];
  // The route first resolves the chat in the requester's scope (access check).
  const scoped = {
    snapshot: async (id: string) => ({ id, projectId: "p1", title: "T", status: "idle", createdAt: 1, updatedAt: 1 }),
    rebindWorkspace: async () => { throw new Error("unused"); },
    create: async () => ({ id: "x" }),
  };
  const route = isolationRoutes({
    isolation: {
      isolateSession: async (sessionId: string, options: unknown) => {
        calls.push([sessionId, options]);
        return { ok: true, session: { id: sessionId }, targetBranch: "main", originUncommitted: 0 };
      },
    } as unknown as IsolationService,
    scopedSessions: () => scoped as never,
  });
  const url = new URL("http://x/api/isolation/s1/isolate");
  let payload: unknown;
  await route({
    req: {}, res: {}, space: { userId: "u1" }, url, path: url.pathname, method: "POST",
    body: async () => ({}),
    json: (_status: number, data: unknown) => { payload = data; },
  } as never);
  assert.deepEqual(calls, [["s1", { sessions: scoped }]]);
  assert.deepEqual(payload, { ok: true, session: { id: "s1" }, targetBranch: "main", originUncommitted: 0 });
});

test("a session the requester cannot read is never isolated", async () => {
  const root = repo();
  const { sessions, isolation } = harness(root);
  const ref = await sessions.create({ projectId: "p1" });
  const foreign = {
    snapshot: async () => { throw Object.assign(new Error("session not found"), { code: "not-found" }); },
    rebindWorkspace: sessions.rebindWorkspace!,
  };
  await assert.rejects(() => isolation.isolateSession(ref.id, { sessions: foreign }), { code: "not-found" });
  assert.throws(() => runGit(root, "rev-parse", "--verify", isolateBranchName(ref.id)));
  assert.equal(sessions.control.rebinds, 0);
});
