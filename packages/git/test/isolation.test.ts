import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreateSessionInput,
  JsonObject,
  SessionEvent,
  SessionIsolation,
  SessionProjection,
  SessionRef,
} from "@polyth/contracts";
import { createGitService } from "../src/index.ts";
import { createManagedWorktrees, isManagedBranch, MANAGED_BRANCH_PREFIX } from "../src/managedWorktrees.ts";
import { createIsolationService, type IsolationSessionApi } from "../src/sessionIntegration.ts";

const git = createGitService();
const dirs: string[] = [];

process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-iso-"));
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

const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const completedTurn = (sessionId: string): SessionEvent => ({
  id: randomUUID(),
  sessionId,
  seq: 1,
  time: Date.now(),
  type: "turn/stopped",
  data: { reason: "completed" },
  v: 1,
});

const makeSessions = (): IsolationSessionApi & { events: SessionEvent[]; projections: Map<string, SessionProjection> } => {
  const projections = new Map<string, SessionProjection>();
  const events: SessionEvent[] = [];
  return {
    projections,
    events,
    async create(input: CreateSessionInput): Promise<SessionRef> {
      const id = randomUUID();
      const now = Date.now();
      const projection: SessionProjection = {
        id,
        projectId: input.projectId,
        title: input.title || "New session",
        status: "idle",
        createdAt: now,
        updatedAt: now,
        ...(input.worktreePath ? { worktreePath: input.worktreePath, worktreeState: "ready" as const } : {}),
        ...(input.isolation ? { isolation: input.isolation } : {}),
      };
      projections.set(id, projection);
      return { id };
    },
    async snapshot(sessionId: string): Promise<SessionProjection> {
      const projection = projections.get(sessionId);
      if (!projection) throw Object.assign(new Error("not found"), { code: "not-found" });
      return { ...projection, isolation: projection.isolation ? { ...projection.isolation } : undefined };
    },
    async list(): Promise<SessionProjection[]> {
      return [...projections.values()].map((projection) => ({ ...projection }));
    },
    async send() {
      return {};
    },
    async patchIsolation(sessionId, isolation) {
      const current = projections.get(sessionId);
      if (!current) throw Object.assign(new Error("not found"), { code: "not-found" });
      const next: SessionProjection = { ...current, updatedAt: Date.now() };
      if (isolation) next.isolation = isolation;
      else delete next.isolation;
      projections.set(sessionId, next);
      return { ...next };
    },
    async rebindWorkspace(sessionId, input) {
      const current = projections.get(sessionId);
      if (!current) throw Object.assign(new Error("not found"), { code: "not-found" });
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
      else if (input.isolation) next.isolation = input.isolation;
      projections.set(sessionId, next);
      return { ...next };
    },
  };
};

const harness = (root: string) => {
  const sessions = makeSessions();
  const isolation = createIsolationService({
    git,
    sessions,
    projects: { get: async (id) => id === "p1" ? { id, path: root } : undefined },
    append: async (_sessionId, type, data: JsonObject) => {
      sessions.events.push({
        id: randomUUID(),
        sessionId: "x",
        seq: sessions.events.length + 1,
        time: Date.now(),
        type,
        data,
        v: 1,
      });
    },
  });
  return { sessions, isolation };
};

test("create isolated session persists immutable origin metadata", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", title: "Fix auth", sourceSessionId: "src-1" });
  const session = await sessions.snapshot(created.id);
  const meta = session.isolation;
  assert.ok(meta);
  assert.equal(meta.kind, "git-worktree");
  assert.equal(meta.state, "active");
  assert.equal(meta.targetPath, resolve(root));
  assert.equal(meta.targetBranch, "main");
  assert.equal(meta.sourceSessionId, "src-1");
  assert.equal(meta.baseCommit, runGit(root, "rev-parse", "HEAD"));
  assert.ok(isManagedBranch(meta.worktreeBranch));
  assert.ok(existsSync(meta.worktreePath));
  assert.equal(session.worktreePath, meta.worktreePath);
  assert.notEqual(session.status, "merging");
});

test("merge includes uncommitted task changes and skips gitignored files", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const wt = session.isolation!.worktreePath;
  writeFileSync(join(wt, "feature.ts"), "export const n = 1;\n");
  writeFileSync(join(wt, ".gitignore"), "secret.log\n");
  writeFileSync(join(wt, "secret.log"), "do-not-merge\n");
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.session.id, created.id);
  assert.equal(result.session.isolation, undefined);
  assert.equal(result.session.worktreePath, undefined);
  assert.equal(result.session.branch, "main");
  assert.equal(readFileSync(join(root, "feature.ts"), "utf8"), "export const n = 1;\n");
  assert.equal(existsSync(join(root, "secret.log")), false);
  assert.equal(existsSync(wt), false);
  const branches = await git.branches(root);
  assert.equal(branches.branches.some((item) => item.name.startsWith(MANAGED_BRANCH_PREFIX)), false);
  assert.ok(sessions.events.some((event) => event.type === "isolation/merged"));
});

test("merge uses current target HEAD, not the original base commit", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "task.txt"), "isolated\n");
  writeFileSync(join(root, "main-later.txt"), "advanced\n");
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "advance main");
  const advanced = runGit(root, "rev-parse", "HEAD");
  assert.notEqual(advanced, session.isolation!.baseCommit);
  await isolation.mergeBack(created.id);
  assert.equal(existsSync(join(root, "main-later.txt")), true);
  assert.equal(readFileSync(join(root, "task.txt"), "utf8"), "isolated\n");
  assert.equal(runGit(root, "merge-base", "--is-ancestor", advanced, "HEAD") || "ok", "ok");
});

test("simultaneous integrations into the same target serialize", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const a = await isolation.createIsolatedSession({ projectId: "p1", title: "A" });
  const b = await isolation.createIsolatedSession({ projectId: "p1", title: "B" });
  writeFileSync(join((await sessions.snapshot(a.id)).isolation!.worktreePath, "a.txt"), "a\n");
  writeFileSync(join((await sessions.snapshot(b.id)).isolation!.worktreePath, "b.txt"), "b\n");
  const [first, second] = await Promise.all([isolation.mergeBack(a.id), isolation.mergeBack(b.id)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b\n");
  assert.notEqual(first.commit, second.commit);
});

test("conflict leaves the target checkout untouched", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "README.md"), "isolated\n");
  writeFileSync(join(root, "README.md"), "main-changed\n");
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "change readme on main");
  const before = readFileSync(join(root, "README.md"), "utf8");
  const head = runGit(root, "rev-parse", "HEAD");
  await assert.rejects(() => isolation.mergeBack(created.id), /conflicting/);
  const after = await sessions.snapshot(created.id);
  assert.equal(after.id, created.id);
  assert.equal(after.isolation?.state, "conflict");
  assert.equal(after.worktreePath, session.isolation!.worktreePath);
  assert.equal(existsSync(session.isolation!.worktreePath), true);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), before);
  assert.equal(runGit(root, "rev-parse", "HEAD"), head);
  assert.equal((await git.status(root)).clean, true);
});

test("keep isolated suppresses suggestions until the worktree changes", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "x.txt"), "x\n");
  const events = [completedTurn(created.id)];
  await isolation.onTurnCompleted(created.id, events);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
  await isolation.keepIsolated(created.id);
  const kept = await sessions.snapshot(created.id);
  assert.equal(kept.isolation?.state, "active");
  assert.ok(kept.isolation?.dismissedRevision);
  await isolation.onTurnCompleted(created.id, events);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "active");
  const status = await isolation.getStatus(created.id);
  assert.equal(status.suggestion?.eligible, false);
  assert.equal(status.suggestion?.reason, "dismissed");
  writeFileSync(join(session.isolation!.worktreePath, "x.txt"), "x2\n");
  await isolation.onTurnCompleted(created.id, events);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
});

test("user-created worktrees and branches are never deleted", async () => {
  const root = repo();
  const managed = createManagedWorktrees(git);
  const userPath = join(tmpdir(), `polyth-user-wt-${randomUUID().slice(0, 8)}`);
  dirs.push(userPath);
  await git.worktrees.create(root, { branch: "user-feature", path: userPath });
  assert.equal(await managed.removeIfOwned(root, userPath), false);
  assert.equal(existsSync(userPath), true);
  const branches = await git.branches(root);
  assert.ok(branches.branches.some((item) => item.name === "user-feature"));
});

test("disappearing worktree becomes a recoverable missing state", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  rmSync(session.isolation!.worktreePath, { recursive: true, force: true });
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation?.state, "missing");
  assert.equal(recovered.id, created.id);
  await assert.rejects(() => isolation.mergeBack(created.id), /no longer available/);
});

test("cleanup-pending recovery finishes worktree removal", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "done.txt"), "ok\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.session.isolation, undefined);
  // Simulate a crash after publish: restore cleanup-pending with a leftover tree.
  const leftover = await isolation.createIsolatedSession({ projectId: "p1", title: "leftover" });
  const pending = await sessions.snapshot(leftover.id);
  await sessions.patchIsolation!(leftover.id, { ...pending.isolation!, state: "cleanup-pending" });
  await sessions.rebindWorkspace!(leftover.id, { worktreePath: null, branch: "main", isolation: {
    ...pending.isolation!,
    state: "cleanup-pending",
  } });
  const recovered = await isolation.recoverSession(await sessions.snapshot(leftover.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(pending.isolation!.worktreePath), false);
});

test("failed cleanup can be retried", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  await sessions.patchIsolation!(created.id, { ...session.isolation!, state: "cleanup-pending" });
  await sessions.rebindWorkspace!(created.id, {
    worktreePath: null,
    branch: "main",
    isolation: { ...session.isolation!, state: "cleanup-pending" },
  });
  const first = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(first.isolation, undefined);
  const again = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(again.isolation, undefined);
});
