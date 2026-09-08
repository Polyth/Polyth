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
import { transitionIsolation } from "@polyth/contracts";
import { createGitService, type GitService } from "../src/index.ts";
import {
  createManagedWorktrees,
  isolateBranchName,
  isManagedBranch,
  MANAGED_BRANCH_PREFIX,
  type ManagedWorktreeService,
} from "../src/managedWorktrees.ts";
import {
  branchLockSize,
  createIsolationService,
  withBranchLock,
  type IsolationSessionApi,
  type IsolationTestHooks,
} from "../src/sessionIntegration.ts";

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

const cloneIsolation = (isolation: SessionIsolation | undefined): SessionIsolation | undefined =>
  isolation ? JSON.parse(JSON.stringify(isolation)) as SessionIsolation : undefined;

interface SessionHarness extends IsolationSessionApi {
  events: SessionEvent[];
  projections: Map<string, SessionProjection>;
  failRebind: boolean;
  persistCalls: number;
  rebindCalls: number;
  sendImpl?: IsolationSessionApi["send"];
}

const makeSessions = (): SessionHarness => {
  const projections = new Map<string, SessionProjection>();
  const events: SessionEvent[] = [];
  const api: SessionHarness = {
    projections,
    events,
    failRebind: false,
    persistCalls: 0,
    rebindCalls: 0,
    async create(input: CreateSessionInput): Promise<SessionRef> {
      const id = input.id ?? randomUUID();
      if (projections.has(id)) throw Object.assign(new Error("session already exists"), { code: "conflict" });
      const now = Date.now();
      const projection: SessionProjection = {
        id,
        projectId: input.projectId,
        title: input.title || "New session",
        status: "idle",
        createdAt: now,
        updatedAt: now,
        ...(input.worktreePath ? { worktreePath: input.worktreePath, worktreeState: "ready" as const } : {}),
        ...(input.isolation ? { isolation: cloneIsolation(input.isolation) } : {}),
      };
      projections.set(id, projection);
      return { id };
    },
    async snapshot(sessionId: string): Promise<SessionProjection> {
      const projection = projections.get(sessionId);
      if (!projection) throw Object.assign(new Error("not found"), { code: "not-found" });
      return { ...projection, isolation: cloneIsolation(projection.isolation) };
    },
    async list(): Promise<SessionProjection[]> {
      return [...projections.values()].map((projection) => ({
        ...projection,
        isolation: cloneIsolation(projection.isolation),
      }));
    },
    async send(sessionId, input) {
      if (api.sendImpl) return api.sendImpl(sessionId, input);
      return {};
    },
    async patchIsolation(sessionId, isolation) {
      api.persistCalls += 1;
      const current = projections.get(sessionId);
      if (!current) throw Object.assign(new Error("not found"), { code: "not-found" });
      const next: SessionProjection = { ...current, updatedAt: Date.now() };
      if (isolation) next.isolation = cloneIsolation(isolation);
      else delete next.isolation;
      projections.set(sessionId, next);
      return { ...next, isolation: cloneIsolation(next.isolation) };
    },
    async rebindWorkspace(sessionId, input) {
      api.rebindCalls += 1;
      if (api.failRebind) throw Object.assign(new Error("epoch failed"), { code: "unavailable" });
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
      else if (input.isolation) next.isolation = cloneIsolation(input.isolation);
      projections.set(sessionId, next);
      return { ...next, isolation: cloneIsolation(next.isolation) };
    },
  };
  return api;
};

const harness = (root: string, opts?: {
  git?: GitService;
  managed?: ManagedWorktreeService;
  testHooks?: IsolationTestHooks;
}) => {
  const sessions = makeSessions();
  const closeCalls: string[] = [];
  const ctrl = { failClose: false, failAppend: false };
  const isolation = createIsolationService({
    git: opts?.git ?? git,
    ...(opts?.managed ? { managed: opts.managed } : {}),
    sessions,
    projects: {
      get: async (id) => id === "p1" ? { id, path: root } : undefined,
      list: async () => [{ id: "p1", path: root }],
    },
    append: async (_sessionId, type, data: JsonObject) => {
      if (ctrl.failAppend) throw new Error("append failed");
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
    closeWorkspaceProcesses: async (cwd) => {
      closeCalls.push(cwd);
      if (ctrl.failClose) throw new Error("close failed");
    },
    ...(opts?.testHooks ? { testHooks: opts.testHooks } : {}),
  });
  return { sessions, isolation, closeCalls, ctrl };
};

const effectiveCwd = (session: SessionProjection, projectPath: string): string =>
  resolve(session.worktreePath ?? projectPath);

const assertBoundTo = async (session: SessionProjection, projectPath: string, expectedCwd: string, branch: string) => {
  assert.equal(session.id.length > 0, true);
  assert.equal(effectiveCwd(session, projectPath), resolve(expectedCwd));
  assert.equal(session.branch, branch);
  assert.equal(runGit(expectedCwd, "rev-parse", "--abbrev-ref", "HEAD"), branch);
};

test("create isolated session persists origin and matches managed ownership", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  await sessions.create({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", projectId: "p1" });
  const created = await isolation.createIsolatedSession({
    projectId: "p1",
    title: "Fix auth",
    sourceSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  const session = await sessions.snapshot(created.id);
  const meta = session.isolation;
  assert.ok(meta);
  assert.equal(created.id, session.id);
  assert.equal(meta.kind, "git-worktree");
  assert.equal(meta.state, "active");
  assert.equal(meta.targetPath, resolve(root));
  assert.equal(meta.targetBranch, "main");
  assert.equal(meta.originPath, resolve(root));
  assert.equal(meta.sourceSessionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(meta.baseCommit, runGit(root, "rev-parse", "HEAD"));
  assert.equal(meta.worktreeBranch, isolateBranchName(session.id));
  const owned = await isolation.managed.inspect(root, meta.worktreePath);
  assert.equal(owned?.meta.sessionId, session.id);
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
  assert.equal(result.finalized, true);
  assert.equal(result.session.id, created.id);
  assert.equal(result.session.isolation, undefined);
  assert.equal(result.session.worktreePath, undefined);
  assert.equal(result.session.branch, "main");
  await assertBoundTo(result.session, root, root, "main");
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

test("same session double-merge publishes exactly once", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "once.txt"), "1\n");
  const results = await Promise.allSettled([isolation.mergeBack(created.id), isolation.mergeBack(created.id)]);
  const ok = results.filter((item) => item.status === "fulfilled");
  const failed = results.filter((item) => item.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  const log = runGit(root, "log", "--oneline");
  assert.equal([...log.matchAll(/once\.txt|1/g)].length >= 0, true);
  assert.equal((await git.log(root, 5)).filter((item) => item.subject !== "init").length, 1);
  assert.equal((await sessions.snapshot(created.id)).isolation, undefined);
});

test("merge + discard race leaves one valid lifecycle", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "race.txt"), "x\n");
  const results = await Promise.allSettled([isolation.mergeBack(created.id), isolation.discard(created.id)]);
  const fulfilled = results.filter((item) => item.status === "fulfilled");
  assert.equal(fulfilled.length, 1);
  const session = await sessions.snapshot(created.id);
  if (session.isolation) {
    assert.ok(existsSync(session.isolation.worktreePath));
    assert.equal(existsSync(join(root, "race.txt")), false);
  } else {
    assert.equal(existsSync(wt), false);
  }
});

test("merge + keep race never resurrects deleted isolation", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "keep.txt"), "k\n");
  await Promise.allSettled([isolation.mergeBack(created.id), isolation.keepIsolated(created.id)]);
  const session = await sessions.snapshot(created.id);
  if (!session.isolation) assert.equal(existsSync(wt), false);
  else assert.ok(existsSync(session.isolation.worktreePath));
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
  assert.equal((await git.worktrees.list(root)).filter((item) => item.path.includes("polyth-integrate")).length, 0);
});

test("conflict then resolve with agent then merge succeeds", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const wt = session.isolation!.worktreePath;
  writeFileSync(join(wt, "README.md"), "isolated\n");
  writeFileSync(join(root, "README.md"), "main-changed\n");
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "change readme on main");
  await assert.rejects(() => isolation.mergeBack(created.id), /conflicting/);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "conflict");
  sessions.sendImpl = async (sessionId) => {
    const current = await sessions.snapshot(sessionId);
    const path = current.isolation!.worktreePath;
    // The merge attempt preserved dirty source state: the agent must explicitly
    // commit its work before merging the target and resolving conflicts.
    runGit(path, "add", "-A");
    runGit(path, "commit", "-qm", "save isolated work");
    try {
      runGit(path, "merge", "--no-edit", current.isolation!.targetBranch);
    } catch {
      writeFileSync(join(path, "README.md"), "resolved\n");
      runGit(path, "add", "README.md");
      runGit(path, "commit", "-qm", "resolve conflicts");
    }
    return {};
  };
  await isolation.resolveWithAgent(created.id);
  await isolation.onTurnCompleted(created.id, [completedTurn(created.id)]);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "resolved\n");
  assert.equal(merged.session.isolation, undefined);
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

test("manual merge with no unique changes is a clean no-op error", async () => {
  const root = repo();
  const { isolation } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  await assert.rejects(() => isolation.mergeBack(created.id), /No isolated changes/);
  const session = await isolation.getStatus(created.id);
  assert.equal(session.isolation?.state, "active");
});

test("stale merge-ready is derived on GET without writing", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "tmp.txt"), "t\n");
  await isolation.onTurnCompleted(created.id, [completedTurn(created.id)]);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
  rmSync(join(wt, "tmp.txt"));
  const persists = sessions.persistCalls;
  const status = await isolation.getStatus(created.id);
  assert.equal(status.isolation?.state, "merge-ready");
  assert.equal(status.effectiveState, "active");
  assert.equal(status.suggestion?.eligible, false);
  assert.equal(status.suggestion?.reason, "no-changes");
  assert.equal(sessions.persistCalls, persists);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
});

test("target branch checked out in another clean worktree integrates there", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-feature-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  const isolated = await sessions.snapshot(created.id);
  assert.equal(isolated.isolation?.originPath, resolve(featureWt));
  const isoPath = isolated.isolation!.worktreePath;
  writeFileSync(join(isoPath, "from-iso.txt"), "yes\n");
  await isolation.mergeBack(created.id);
  assert.equal(readFileSync(join(featureWt, "from-iso.txt"), "utf8"), "yes\n");
  assert.equal(existsSync(join(root, "from-iso.txt")), false);
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  const after = await sessions.snapshot(created.id);
  assert.equal(after.id, created.id);
  assert.equal(after.isolation, undefined);
  assert.equal(after.worktreePath, resolve(featureWt));
  assert.equal(after.branch, "feature");
  await assertBoundTo(after, root, featureWt, "feature");
  assert.equal(existsSync(isoPath), false);
});

test("dirty checkout of the target branch refuses merge", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-feature-dirty-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  writeFileSync(join(featureWt, "local.txt"), "dirty\n");
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "from-iso.txt"), "yes\n");
  const before = runGit(root, "rev-parse", "feature");
  await assert.rejects(() => isolation.mergeBack(created.id), /local changes/);
  assert.equal(runGit(root, "rev-parse", "feature"), before);
  assert.equal(readFileSync(join(featureWt, "local.txt"), "utf8"), "dirty\n");
  assert.equal(existsSync(join(featureWt, "from-iso.txt")), false);
});

test("unchecked-out and remote-only targets are refused so the session never fakes a cwd", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const { isolation } = harness(root);
  await assert.rejects(
    () => isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" }),
    /needs a checkout of feature/,
  );
  await assert.rejects(
    () => isolation.createIsolatedSession({ projectId: "p1", targetBranch: "origin/feature" }),
    /needs a local checkout/,
  );
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal((await git.status(root)).clean, true);
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

test("corrupted managed marker is not deleted and metadata is kept", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const wt = session.isolation!.worktreePath;
  writeFileSync(join(wt, "keep-me.ts"), "x\n");
  const gitDir = await git.gitDir(wt);
  writeFileSync(join(gitDir, "polyth-managed.json"), "{not-json");
  const before = runGit(root, "rev-parse", "HEAD");
  await assert.rejects(() => isolation.mergeBack(created.id), /ownership must be restored/);
  assert.equal(runGit(root, "rev-parse", "HEAD"), before);
  assert.equal((await isolation.getStatus(created.id)).effectiveState, "corrupt");
  assert.equal(existsSync(wt), true);
  assert.equal(isManagedBranch(session.isolation!.worktreeBranch), true);
});

test("cleanup-pending recovery finishes worktree removal", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "done.txt"), "ok\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.session.isolation, undefined);
  const leftover = await isolation.createIsolatedSession({ projectId: "p1", title: "leftover" });
  const pending = await sessions.snapshot(leftover.id);
  await sessions.patchIsolation!(leftover.id, transitionIsolation(pending.isolation!, { state: "cleanup-pending", rebound: true }));
  await sessions.rebindWorkspace!(leftover.id, { worktreePath: null, branch: "main", isolation: transitionIsolation(pending.isolation!, { state: "cleanup-pending", rebound: true }) });
  const recovered = await isolation.recoverSession(await sessions.snapshot(leftover.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(pending.isolation!.worktreePath), false);
});

test("failed cleanup can be retried", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  await sessions.patchIsolation!(created.id, transitionIsolation(session.isolation!, { state: "cleanup-pending", rebound: true }));
  await sessions.rebindWorkspace!(created.id, {
    worktreePath: null,
    branch: "main",
    isolation: transitionIsolation(session.isolation!, { state: "cleanup-pending", rebound: true }),
  });
  const first = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(first.isolation, undefined);
  const again = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(again.isolation, undefined);
});

test("crash after publication is recovered without duplicating the merge", async () => {
  const root = repo();
  const hooks: IsolationTestHooks = {
    afterPublish: async () => {
      throw Object.assign(new Error("injected crash after publish"), { code: "injected" });
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1", title: "Crash after" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "published.txt"), "p\n");
  const crashed = await isolation.mergeBack(created.id);
  assert.equal(crashed.ok, true);
  assert.equal(crashed.finalized, false);
  assert.equal(crashed.session.isolation?.state, "publishing");
  assert.ok(crashed.session.isolation?.publish?.resultCommit);
  const head = runGit(root, "rev-parse", "HEAD");
  assert.equal(head, crashed.session.isolation!.publish!.resultCommit);
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(recovered.id, created.id);
  assert.equal(readFileSync(join(root, "published.txt"), "utf8"), "p\n");
  assert.equal((await git.log(root, 8)).filter((item) => item.subject !== "init").length, 1);
  assert.equal(existsSync(wt), false);
});

test("crash before publication leaves the target unchanged", async () => {
  const root = repo();
  const hooks: IsolationTestHooks = {
    beforePublish: async () => {
      throw Object.assign(new Error("injected crash before publish"), { code: "injected" });
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const before = runGit(root, "rev-parse", "HEAD");
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "not-yet.txt"), "n\n");
  await assert.rejects(() => isolation.mergeBack(created.id), /injected crash/);
  assert.equal(runGit(root, "rev-parse", "HEAD"), before);
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.ok(recovered.isolation);
  assert.notEqual(recovered.isolation?.state, "merging");
  hooks.beforePublish = undefined;
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.equal(readFileSync(join(root, "not-yet.txt"), "utf8"), "n\n");
});

test("rebind failure keeps the source workspace for retry", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "rebind.txt"), "r\n");
  sessions.failRebind = true;
  const failedMerge = await isolation.mergeBack(created.id);
  assert.equal(failedMerge.ok, true);
  assert.equal(failedMerge.finalized, false);
  const failed = await sessions.snapshot(created.id);
  assert.equal(failed.isolation?.state, "rebind-pending");
  assert.notEqual(failed.isolation?.rebound, true);
  assert.ok(failed.isolation?.resultCommit);
  assert.equal(existsSync(wt), true);
  assert.equal(failed.worktreePath, wt);
  assert.equal(readFileSync(join(root, "rebind.txt"), "utf8"), "r\n");
  sessions.failRebind = false;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
  await assertBoundTo(recovered, root, root, "main");
});

test("retry exhaustion leaves a recoverable merge-ready state", async () => {
  const root = repo();
  let n = 0;
  const hooks: IsolationTestHooks = {
    beforePublish: async () => {
      n += 1;
      writeFileSync(join(root, `moved-${n}.txt`), "x\n");
      runGit(root, "add", ".");
      runGit(root, "commit", "-qm", `move ${n}`);
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "task.txt"), "t\n");
  await assert.rejects(() => isolation.mergeBack(created.id), /changed during integration/);
  const after = await sessions.snapshot(created.id);
  assert.equal(after.isolation?.state, "merge-ready");
  assert.equal(existsSync(after.isolation!.worktreePath), true);
});

test("orphan integration worktrees are pruned on recovery", async () => {
  const root = repo();
  const managed = createManagedWorktrees(git);
  const { isolation } = harness(root, { managed });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const path = await managed.createIntegrationWorkspace({
    root,
    sessionId: created.id,
    startPoint: runGit(root, "rev-parse", "HEAD"),
  });
  assert.equal(existsSync(path), true);
  await isolation.recoverAll();
  assert.equal(existsSync(path), false);
});

test("withBranchLock serializes and does not leak map entries", async () => {
  const order: number[] = [];
  await Promise.all([
    withBranchLock("k", async () => { order.push(1); await new Promise((r) => setTimeout(r, 20)); order.push(2); }),
    withBranchLock("k", async () => { order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(branchLockSize(), 0);
  await assert.rejects(() => withBranchLock("k", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(branchLockSize(), 0);
});

test("mutating isolation from merging is rejected", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  await sessions.patchIsolation!(created.id, transitionIsolation(session.isolation!, { state: "merging" }));
  await assert.rejects(() => isolation.keepIsolated(created.id), /cannot keep/);
  await assert.rejects(() => isolation.discard(created.id), /cannot discard/);
});

test("ambiguous publication is left merging, never treated as unpublished", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const head = runGit(root, "rev-parse", "HEAD");
  await sessions.patchIsolation!(created.id, transitionIsolation({ ...session.isolation!, targetBranch: "does-not-exist" }, {
    state: "publishing",
    publish: {
      expectedTargetSha: head,
      resultCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      snapshotSha: head,
      targetRef: "refs/heads/does-not-exist",
    },
  }));
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation?.state, "publishing");
  assert.ok(recovered.isolation?.publish);
  assert.equal(existsSync(session.isolation!.worktreePath), true);
});

test("GET status after publication crash observes without recovering", async () => {
  const root = repo();
  const hooks: IsolationTestHooks = {
    afterPublish: async () => {
      throw Object.assign(new Error("injected crash after publish"), { code: "injected" });
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "via-status.txt"), "s\n");
  const published = await isolation.mergeBack(created.id);
  assert.equal(published.finalized, false);
  const persists = sessions.persistCalls;
  const rebinds = sessions.rebindCalls;
  const status = await isolation.getStatus(created.id);
  assert.equal(status.isolation?.state, "publishing");
  assert.equal(status.effectiveState, "publishing");
  assert.equal(sessions.persistCalls, persists);
  assert.equal(sessions.rebindCalls, rebinds);
  assert.equal(existsSync(wt), true);
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(readFileSync(join(root, "via-status.txt"), "utf8"), "s\n");
  assert.equal(existsSync(wt), false);
});

test("unknown sourceSessionId is rejected", async () => {
  const root = repo();
  const { isolation } = harness(root);
  await assert.rejects(
    () => isolation.createIsolatedSession({ projectId: "p1", sourceSessionId: "missing" }),
    /source session was not found/,
  );
});

test("discard returns the session to the origin checkout", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-feature-discard-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  const isoPath = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(isoPath, "gone.txt"), "nope\n");
  const discarded = await isolation.discard(created.id);
  assert.equal(discarded.id, created.id);
  assert.equal(discarded.isolation, undefined);
  await assertBoundTo(discarded, root, featureWt, "feature");
  assert.equal(existsSync(isoPath), false);
  assert.equal(existsSync(join(featureWt, "gone.txt")), false);
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("notice append failure after publish does not report merge failure", async () => {
  const root = repo();
  const ctx = harness(root);
  ctx.ctrl.failAppend = true;
  const created = await ctx.isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await ctx.sessions.snapshot(created.id)).isolation!.worktreePath, "ok.txt"), "ok\n");
  const merged = await ctx.isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.equal(merged.finalized, true);
  assert.equal(readFileSync(join(root, "ok.txt"), "utf8"), "ok\n");
  assert.equal(merged.session.isolation, undefined);
});

test("cleanup failure after rebind keeps rebound true and retries cleanup only", async () => {
  const root = repo();
  const hooks: IsolationTestHooks = {
    beforeCleanup: async () => {
      throw Object.assign(new Error("injected cleanup crash"), { code: "injected" });
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "keep-src.txt"), "k\n");
  const published = await isolation.mergeBack(created.id);
  assert.equal(published.ok, true);
  assert.equal(published.finalized, false);
  const pending = await sessions.snapshot(created.id);
  assert.equal(pending.isolation?.state, "cleanup-pending");
  assert.equal(pending.isolation?.rebound, true);
  await assertBoundTo(pending, root, root, "main");
  assert.equal(existsSync(wt), true);
  const rebinds = sessions.rebindCalls;
  hooks.beforeCleanup = undefined;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(sessions.rebindCalls, rebinds);
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
});

test("source process close failure does not delete the isolated workspace", async () => {
  const root = repo();
  const ctx = harness(root);
  const created = await ctx.isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await ctx.sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "close.txt"), "c\n");
  ctx.ctrl.failClose = true;
  const published = await ctx.isolation.mergeBack(created.id);
  assert.equal(published.ok, true);
  assert.equal(published.finalized, false);
  const pending = await ctx.sessions.snapshot(created.id);
  assert.equal(pending.isolation?.state, "cleanup-pending");
  assert.equal(pending.isolation?.rebound, true);
  assert.equal(existsSync(wt), true);
  ctx.ctrl.failClose = false;
  const recovered = await ctx.isolation.recoverSession(await ctx.sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
});

test("busy runtime states block merge resolve and discard", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "busy.txt"), "b\n");
  for (const status of ["working", "waiting", "reconciling", "epoch-pending"] as const) {
    const current = await sessions.snapshot(created.id);
    sessions.projections.set(created.id, { ...current, status });
    await assert.rejects(() => isolation.mergeBack(created.id), /still running/);
    await assert.rejects(() => isolation.keepIsolated(created.id), /still running/);
    await assert.rejects(() => isolation.discard(created.id), /still running/);
  }
  const conflicted = await sessions.snapshot(created.id);
  sessions.projections.set(created.id, {
    ...conflicted,
    status: "working",
    isolation: transitionIsolation(conflicted.isolation!, { state: "conflict", conflict: { message: "x", files: ["README.md"] } }),
  });
  await assert.rejects(() => isolation.resolveWithAgent(created.id), /still running/);
});

test("resolve with agent cannot start twice while a turn is running", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const current = await sessions.snapshot(created.id);
  await sessions.patchIsolation!(created.id, transitionIsolation(current.isolation!, {
    state: "conflict", conflict: { message: "conflict", files: ["README.md"] },
  }));
  let sends = 0;
  sessions.sendImpl = async () => {
    sends += 1;
    const live = await sessions.snapshot(created.id);
    sessions.projections.set(created.id, { ...live, status: "working" });
    return {};
  };
  await isolation.resolveWithAgent(created.id);
  assert.equal(sends, 1);
  await assert.rejects(() => isolation.resolveWithAgent(created.id), /still running/);
  await assert.rejects(() => isolation.discard(created.id), /still running/);
  assert.equal(sends, 1);
});

test("corrupted isolation pointing at another session does not delete it", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const a = await isolation.createIsolatedSession({ projectId: "p1", title: "A" });
  const b = await isolation.createIsolatedSession({ projectId: "p1", title: "B" });
  const sessionA = await sessions.snapshot(a.id);
  const sessionB = await sessions.snapshot(b.id);
  const bPath = sessionB.isolation!.worktreePath;
  const bBranch = sessionB.isolation!.worktreeBranch;
  await sessions.rebindWorkspace!(a.id, {
    worktreePath: null,
    branch: "main",
    isolation: transitionIsolation({ ...sessionA.isolation!, worktreePath: bPath, worktreeBranch: bBranch }, { state: "cleanup-pending", rebound: true }),
  });
  const recovered = await isolation.recoverSession(await sessions.snapshot(a.id));
  assert.equal(recovered.isolation?.state, "cleanup-pending");
  assert.equal(existsSync(bPath), true);
  assert.equal(existsSync(sessionA.isolation!.worktreePath), true);
  assert.ok((await git.branches(root)).branches.some((item) => item.name === bBranch));
  assert.ok((await git.branches(root)).branches.some((item) => item.name === sessionA.isolation!.worktreeBranch));
});

test("cleanup of one session does not prune another session's live integration", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-feature-conc-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  let resumeB!: () => void;
  const holdB = new Promise<void>((resolveHold) => { resumeB = resolveHold; });
  let bIntegration = "";
  let bId = "";
  const hooks: IsolationTestHooks = {
    afterIntegrationCreated: async (sessionId) => {
      if (sessionId !== bId) return;
      const listed = await git.worktrees.list(root);
      bIntegration = listed.find((item) => item.path.includes("polyth-integrate"))?.path ?? "";
      await holdB;
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const a = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "main" });
  const b = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  bId = b.id;
  writeFileSync(join((await sessions.snapshot(a.id)).isolation!.worktreePath, "a.txt"), "a\n");
  writeFileSync(join((await sessions.snapshot(b.id)).isolation!.worktreePath, "b.txt"), "b\n");
  const mergeB = isolation.mergeBack(b.id);
  for (let i = 0; i < 40 && !bIntegration; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(bIntegration);
  assert.equal(existsSync(bIntegration), true);
  const mergedA = await isolation.mergeBack(a.id);
  assert.equal(mergedA.ok, true);
  assert.equal(mergedA.finalized, true);
  assert.equal(existsSync(bIntegration), true);
  resumeB();
  const mergedB = await mergeB;
  assert.equal(mergedB.ok, true);
  assert.equal(mergedB.finalized, true);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
  assert.equal(readFileSync(join(featureWt, "b.txt"), "utf8"), "b\n");
  assert.equal(existsSync(bIntegration), false);
});

test("startup recovery waits on a live merge instead of pruning its integration", async () => {
  const root = repo();
  let resume!: () => void;
  const hold = new Promise<void>((resolveHold) => { resume = resolveHold; });
  let integration = "";
  const hooks: IsolationTestHooks = {
    afterIntegrationCreated: async () => {
      const listed = await git.worktrees.list(root);
      integration = listed.find((item) => item.path.includes("polyth-integrate"))?.path ?? "";
      await hold;
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "live.txt"), "l\n");
  const merge = isolation.mergeBack(created.id);
  for (let i = 0; i < 40 && !integration; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(existsSync(integration), true);
  const recovering = isolation.recoverAll();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(existsSync(integration), true);
  resume();
  const merged = await merge;
  await recovering;
  assert.equal(merged.ok, true);
  assert.equal(merged.finalized, true);
  assert.equal(existsSync(integration), false);
});

test("GET status during merge does not mutate refs or worktrees", async () => {
  const root = repo();
  let resume!: () => void;
  const hold = new Promise<void>((resolveHold) => { resume = resolveHold; });
  let reached!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const hooks: IsolationTestHooks = {
    afterIntegrationCreated: async () => { reached(); await hold; },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "g.txt"), "g\n");
  const merge = isolation.mergeBack(created.id);
  await started;
  const persists = sessions.persistCalls;
  const rebinds = sessions.rebindCalls;
  const beforeHead = runGit(root, "rev-parse", "HEAD");
  const status = await isolation.getStatus(created.id);
  assert.equal(status.isolation?.state, "merging");
  assert.equal(sessions.persistCalls, persists);
  assert.equal(sessions.rebindCalls, rebinds);
  assert.equal(runGit(root, "rev-parse", "HEAD"), beforeHead);
  resume();
  const merged = await merge;
  assert.equal(merged.ok, true);
});

for (const change of ["other-session", "session-marker", "branch-marker", "missing-marker", "listed-branch"] as const) {
  test(`source ownership ${change} cannot publish or close another workspace`, async () => {
    const root = repo();
    const { isolation, sessions, closeCalls } = harness(root);
    const a = await isolation.createIsolatedSession({ projectId: "p1" });
    const original = await sessions.snapshot(a.id);
    const source = original.isolation!;
    writeFileSync(join(source.worktreePath, "owned.txt"), "owned\n");
    if (change === "other-session") {
      const b = await isolation.createIsolatedSession({ projectId: "p1" });
      const other = (await sessions.snapshot(b.id)).isolation!;
      await sessions.patchIsolation!(a.id, { ...source, worktreePath: other.worktreePath, worktreeBranch: other.worktreeBranch });
    } else if (change === "listed-branch") {
      runGit(source.worktreePath, "checkout", "--detach");
    } else {
      const markerPath = join(await git.gitDir(source.worktreePath), "polyth-managed.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (change === "missing-marker") rmSync(markerPath);
      else {
        if (change === "session-marker") marker.sessionId = randomUUID();
        else marker.worktreeBranch = "user-branch";
        writeFileSync(markerPath, JSON.stringify(marker));
      }
    }
    const head = runGit(root, "rev-parse", "HEAD");
    await assert.rejects(() => isolation.mergeBack(a.id), /ownership/);
    await assert.rejects(() => isolation.discard(a.id), /ownership/);
    assert.equal(runGit(root, "rev-parse", "HEAD"), head);
    assert.equal(existsSync(source.worktreePath), true);
    assert.deepEqual(closeCalls, []);
  });
}

test("nested isolation rejects both direct managed branch and source session", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const source = await isolation.createIsolatedSession({ projectId: "p1" });
  const branch = (await sessions.snapshot(source.id)).isolation!.worktreeBranch;
  for (const targetBranch of [branch, `refs/heads/${branch}`]) {
    await assert.rejects(() => isolation.createIsolatedSession({ projectId: "p1", targetBranch }), /Managed isolation branches/);
  }
  await assert.rejects(() => isolation.createIsolatedSession({ projectId: "p1", targetBranch: "main", sourceSessionId: source.id }), /Nested isolation/);
  assert.equal((await sessions.list()).length, 1);
});

for (const situation of ["origin-changed", "origin-removed", "target-elsewhere", "not-checked-out"] as const) {
  test(`destination ${situation} prevents publication and preserves source`, async () => {
    const root = repo();
    const origin = join(root, "..", `polyth-origin-${randomUUID()}`);
    dirs.push(origin);
    await git.worktrees.create(root, { branch: "feature", path: origin });
    const { isolation, sessions } = harness(root);
    const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
    const source = (await sessions.snapshot(created.id)).isolation!;
    writeFileSync(join(source.worktreePath, "work.txt"), "preserved\n");
    const before = runGit(root, "rev-parse", "feature");
    if (situation === "origin-removed") await git.worktrees.remove(root, { path: origin });
    else runGit(origin, "checkout", "--detach");
    if (situation === "target-elsewhere") runGit(root, "checkout", "feature");
    const head = runGit(source.worktreePath, "rev-parse", "HEAD");
    await assert.rejects(() => isolation.mergeBack(created.id), /origin workspace/);
    assert.equal(runGit(root, "rev-parse", "feature"), before);
    assert.equal(runGit(source.worktreePath, "rev-parse", "HEAD"), head);
    assert.equal((await isolation.getStatus(created.id)).suggestion?.reason, "destination-unavailable");
    assert.equal(readFileSync(join(source.worktreePath, "work.txt"), "utf8"), "preserved\n");
  });
}

test("publication receipt survives reset to old target without duplicate publication", async () => {
  const root = repo();
  const before = runGit(root, "rev-parse", "HEAD");
  const hooks: IsolationTestHooks = { afterPublish: async () => { throw new Error("crash after atomic publication"); } };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(source.worktreePath, "published.txt"), "published\n");
  const result = await isolation.mergeBack(created.id);
  const commit = result.commit;
  assert.equal(runGit(root, "rev-parse", `refs/polyth/isolation/${created.id}`), commit);
  runGit(root, "reset", "--hard", before);
  await assert.rejects(() => isolation.recover(created.id), /checkout|branch|changed/i);
  assert.equal(runGit(root, "rev-parse", "HEAD"), before);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "publishing");
  // The user restores the published result. Recovery synchronizes and returns
  // the canonical session; it never repeats the target mutation.
  runGit(root, "reset", "--hard", commit);
  const recovered = await isolation.recover(created.id);
  assert.equal(recovered.isolation, undefined);
  assert.equal(recovered.id, created.id);
  assert.equal(runGit(root, "rev-parse", "HEAD"), commit);
});

test("post-publication origin loss stays explicit until the origin is restored", async () => {
  const root = repo();
  const hooks: IsolationTestHooks = { afterPublish: async () => { runGit(root, "checkout", "--detach"); } };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(source.worktreePath, "survives.txt"), "s\n");
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.finalized, false);
  assert.equal(result.session.isolation?.state, "publishing");
  assert.equal(existsSync(source.worktreePath), true);
  await assert.rejects(() => isolation.recover(created.id), /checkout|branch/i);
  runGit(root, "checkout", "main");
  // The simulated crash left the old index; safe recovery applies the result.
  const recovered = await isolation.recover(created.id);
  assert.equal(recovered.isolation, undefined);
  assert.equal(readFileSync(join(root, "survives.txt"), "utf8"), "s\n");
});

test("external source edit during publication cannot be lost to cleanup", async () => {
  const root = repo();
  let sourcePath = "";
  const hooks: IsolationTestHooks = { afterPublish: async () => { writeFileSync(join(sourcePath, "later.txt"), "late\n"); } };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  sourcePath = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(sourcePath, "included.txt"), "included\n");
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.finalized, false);
  assert.equal(result.session.isolation?.state, "cleanup-pending");
  assert.equal(result.session.worktreePath, undefined);
  assert.equal(readFileSync(join(sourcePath, "later.txt"), "utf8"), "late\n");
  assert.equal(existsSync(join(root, "later.txt")), false);
  assert.equal(readFileSync(join(root, "included.txt"), "utf8"), "included\n");
});

test("startup repairs lost merge-ready projection from durable stopped event", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "ready.txt"), "ready\n");
  sessions.events.push(completedTurn(created.id));
  const restarted = createIsolationService({ git, sessions, projects: { get: async () => ({ id: "p1", path: root }) },
    append: async () => {}, readEvents: async (id) => sessions.events.filter((event) => event.sessionId === id) });
  const persists = sessions.persistCalls;
  assert.equal((await restarted.getStatus(created.id)).suggestion?.eligible, true);
  assert.equal(sessions.persistCalls, persists);
  await restarted.recoverAll();
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
});

test("runtime rebind does not hold the target branch publication lock", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const a = await isolation.createIsolatedSession({ projectId: "p1" });
  const b = await isolation.createIsolatedSession({ projectId: "p1" });
  for (const item of [a, b]) writeFileSync(join((await sessions.snapshot(item.id)).isolation!.worktreePath, `${item.id}.txt`), "x\n");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const rebind = sessions.rebindWorkspace!;
  sessions.rebindWorkspace = async (id, input) => { if (id === a.id) { entered(); await hold; } return rebind(id, input); };
  const merging = isolation.mergeBack(a.id);
  await started;
  try {
    const second = await isolation.mergeBack(b.id);
    assert.equal(second.finalized, true);
  } finally { release(); }
  assert.equal((await merging).finalized, true);
});

test("corrupt labeled publication evidence is never erased by resource repair", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const malformed = { ...session.isolation!, state: "corrupt", publish: { expectedTargetSha: "old", resultCommit: "published", snapshotSha: "snap", targetRef: "refs/heads/main" } } as unknown as SessionIsolation;
  sessions.projections.set(created.id, { ...session, isolation: malformed });
  const recovered = await isolation.recover(created.id);
  assert.deepEqual(recovered.isolation, malformed);
  assert.deepEqual((await sessions.snapshot(created.id)).isolation, malformed);
  await assert.rejects(() => isolation.discard(created.id), /cannot discard/);
});

test("terminal close flushing new files preserves source after publication", async () => {
  const root = repo();
  const sessions = makeSessions();
  const isolation = createIsolationService({ git, sessions, projects: { get: async () => ({ id: "p1", path: root }) },
    append: async () => {}, closeWorkspaceProcesses: async (cwd) => { writeFileSync(join(cwd, "flushed.txt"), "late write\n"); } });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(source.worktreePath, "done.txt"), "done\n");
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.finalized, false);
  assert.equal(result.session.isolation?.state, "cleanup-pending");
  assert.equal(readFileSync(join(source.worktreePath, "flushed.txt"), "utf8"), "late write\n");
});

test("startup never prunes integration owned by an unknown canonical session", async () => {
  const root = repo();
  const managed = createManagedWorktrees(git);
  const { isolation } = harness(root, { managed });
  const foreignId = randomUUID();
  const foreignPath = await managed.createIntegrationWorkspace({ root, sessionId: foreignId, startPoint: "main" });
  await isolation.recoverAll();
  assert.equal(existsSync(foreignPath), true);
  await managed.discardIntegration(root, foreignPath, foreignId);
});

test("discard rebind failure uses the same recoverable finalization as merge", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(source.worktreePath, "discard.txt"), "discard only after return\n");
  sessions.failRebind = true;
  const pending = await isolation.discard(created.id);
  assert.equal(pending.isolation?.state, "rebind-pending");
  assert.equal(pending.worktreePath, source.worktreePath);
  assert.equal(existsSync(source.worktreePath), true);
  sessions.failRebind = false;
  const done = await isolation.recover(created.id);
  assert.equal(done.id, created.id);
  assert.equal(done.isolation, undefined);
  assert.equal(existsSync(source.worktreePath), false);
});

test("unreadable repository status is observational and cannot enable source mutations", async () => {
  const root = repo();
  let unreadable = false;
  const guarded: GitService = { ...git, worktrees: { ...git.worktrees, list: async (cwd) => {
    if (unreadable) throw new Error("repository temporarily unavailable");
    return git.worktrees.list(cwd);
  } } };
  const { isolation, sessions } = harness(root, { git: guarded });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const before = sessions.persistCalls;
  unreadable = true;
  const status = await isolation.getStatus(created.id);
  assert.equal(status.effectiveState, "unowned");
  assert.equal(status.suggestion?.eligible, false);
  assert.equal(sessions.persistCalls, before);
  await assert.rejects(() => isolation.mergeBack(created.id), /repository temporarily unavailable/);
  unreadable = false;
  assert.equal((await isolation.getStatus(created.id)).effectiveState, "active");
});

test("cleanup preserves another project's canonical session using the source as its root", async () => {
  const root = repo();
  const sessions = makeSessions();
  let sourcePath = "";
  const isolation = createIsolationService({ git, sessions,
    projects: { get: async (id) => ({ id, path: id === "p1" ? root : sourcePath }) }, append: async () => {} });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  sourcePath = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(sourcePath, "shared.txt"), "s\n");
  const other = await sessions.create({ projectId: "p2" });
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, false);
  assert.equal(merged.session.isolation?.state, "cleanup-pending");
  assert.equal(existsSync(sourcePath), true);
  assert.equal((await sessions.snapshot(other.id)).projectId, "p2");
});
