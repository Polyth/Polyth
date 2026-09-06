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
  sendImpl?: IsolationSessionApi["send"];
}

const makeSessions = (): SessionHarness => {
  const projections = new Map<string, SessionProjection>();
  const events: SessionEvent[] = [];
  const api: SessionHarness = {
    projections,
    events,
    failRebind: false,
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
      const current = projections.get(sessionId);
      if (!current) throw Object.assign(new Error("not found"), { code: "not-found" });
      const next: SessionProjection = { ...current, updatedAt: Date.now() };
      if (isolation) next.isolation = cloneIsolation(isolation);
      else delete next.isolation;
      projections.set(sessionId, next);
      return { ...next, isolation: cloneIsolation(next.isolation) };
    },
    async rebindWorkspace(sessionId, input) {
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
  const isolation = createIsolationService({
    git: opts?.git ?? git,
    ...(opts?.managed ? { managed: opts.managed } : {}),
    sessions,
    projects: {
      get: async (id) => id === "p1" ? { id, path: root } : undefined,
      list: async () => [{ id: "p1", path: root }],
    },
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
    ...(opts?.testHooks ? { testHooks: opts.testHooks } : {}),
  });
  return { sessions, isolation };
};

test("create isolated session persists origin and matches managed ownership", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", title: "Fix auth", sourceSessionId: "src-1" });
  const session = await sessions.snapshot(created.id);
  const meta = session.isolation;
  assert.ok(meta);
  assert.equal(created.id, session.id);
  assert.equal(meta.kind, "git-worktree");
  assert.equal(meta.state, "active");
  assert.equal(meta.targetPath, resolve(root));
  assert.equal(meta.targetBranch, "main");
  assert.equal(meta.sourceSessionId, "src-1");
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

test("stale merge-ready is reconciled when changes disappear", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "tmp.txt"), "t\n");
  await isolation.onTurnCompleted(created.id, [completedTurn(created.id)]);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
  rmSync(join(wt, "tmp.txt"));
  const status = await isolation.getStatus(created.id);
  assert.equal(status.isolation?.state, "active");
  assert.equal(status.suggestion?.eligible, false);
  assert.equal(status.suggestion?.reason, "no-changes");
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
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "from-iso.txt"), "yes\n");
  await isolation.mergeBack(created.id);
  assert.equal(readFileSync(join(featureWt, "from-iso.txt"), "utf8"), "yes\n");
  assert.equal(existsSync(join(root, "from-iso.txt")), false);
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
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

test("CAS update-ref when the target branch is not checked out", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "side.txt"), "s\n");
  await isolation.mergeBack(created.id);
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal((await git.status(root)).clean, true);
  assert.equal(existsSync(join(root, "side.txt")), false);
  const featureSha = runGit(root, "rev-parse", "feature");
  assert.notEqual(featureSha, runGit(root, "rev-parse", "main"));
  assert.match(runGit(root, "show", `${featureSha}:side.txt`), /s/);
});

test("remote-only branch selection creates a local tracking target", async () => {
  const upstream = repo();
  runGit(upstream, "checkout", "-b", "feature");
  writeFileSync(join(upstream, "remote-only.txt"), "r\n");
  runGit(upstream, "add", ".");
  runGit(upstream, "commit", "-qm", "feature work");
  runGit(upstream, "checkout", "main");
  const clone = mkdtempSync(join(tmpdir(), "polyth-iso-clone-"));
  dirs.push(clone);
  rmSync(clone, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", upstream, clone], { stdio: "pipe" });
  runGit(clone, "config", "user.email", "t@example.com");
  runGit(clone, "config", "user.name", "Test");
  runGit(clone, "config", "commit.gpgsign", "false");
  const localNames = runGit(clone, "branch").split("\n").map((line) => line.replace("*", "").trim());
  assert.equal(localNames.includes("feature"), false);
  const { isolation, sessions } = harness(clone);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "origin/feature" });
  const session = await sessions.snapshot(created.id);
  assert.equal(session.isolation?.targetBranch, "feature");
  assert.ok(runGit(clone, "branch").includes("feature"));
  writeFileSync(join(session.isolation!.worktreePath, "more.txt"), "m\n");
  await isolation.mergeBack(created.id);
  assert.match(runGit(clone, "show", "feature:more.txt"), /m/);
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
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.session.isolation?.state, "cleanup-pending");
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
  await sessions.patchIsolation!(leftover.id, { ...pending.isolation!, state: "cleanup-pending", rebound: true });
  await sessions.rebindWorkspace!(leftover.id, { worktreePath: null, branch: "main", isolation: {
    ...pending.isolation!,
    state: "cleanup-pending",
    rebound: true,
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
  await sessions.patchIsolation!(created.id, { ...session.isolation!, state: "cleanup-pending", rebound: true });
  await sessions.rebindWorkspace!(created.id, {
    worktreePath: null,
    branch: "main",
    isolation: { ...session.isolation!, state: "cleanup-pending", rebound: true },
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
  await assert.rejects(() => isolation.mergeBack(created.id), /injected crash/);
  const crashed = await sessions.snapshot(created.id);
  assert.equal(crashed.isolation?.state, "merging");
  assert.ok(crashed.isolation?.publish?.resultCommit);
  const head = runGit(root, "rev-parse", "HEAD");
  assert.equal(head, crashed.isolation!.publish!.resultCommit);
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
  await assert.rejects(() => isolation.mergeBack(created.id), /epoch failed/);
  const failed = await sessions.snapshot(created.id);
  assert.equal(failed.isolation?.state, "cleanup-pending");
  assert.equal(failed.isolation?.rebound, false);
  assert.ok(failed.isolation?.resultCommit);
  assert.equal(existsSync(wt), true);
  assert.equal(readFileSync(join(root, "rebind.txt"), "utf8"), "r\n");
  sessions.failRebind = false;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
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
  await sessions.patchIsolation!(created.id, { ...session.isolation!, state: "merging" });
  await assert.rejects(() => isolation.keepIsolated(created.id), /cannot keep/);
  await assert.rejects(() => isolation.discard(created.id), /cannot discard/);
});

test("ambiguous publication is left merging, never treated as unpublished", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const head = runGit(root, "rev-parse", "HEAD");
  await sessions.patchIsolation!(created.id, {
    ...session.isolation!,
    state: "merging",
    targetBranch: "does-not-exist",
    publish: {
      expectedTargetSha: head,
      resultCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      snapshotSha: head,
      targetRef: "refs/heads/does-not-exist",
    },
  });
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation?.state, "merging");
  assert.ok(recovered.isolation?.publish);
  assert.equal(existsSync(session.isolation!.worktreePath), true);
});

test("status recovery finishes a crash after publication", async () => {
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
  await assert.rejects(() => isolation.mergeBack(created.id), /injected crash/);
  const status = await isolation.getStatus(created.id);
  assert.equal(status.isolation, null);
  assert.equal((await sessions.snapshot(created.id)).isolation, undefined);
  assert.equal(readFileSync(join(root, "via-status.txt"), "utf8"), "s\n");
  assert.equal(existsSync(wt), false);
});
