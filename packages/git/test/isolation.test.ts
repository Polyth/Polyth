import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreateSessionInput,
  JsonObject,
  SessionEvent,
  SessionIsolation,
  SessionProjection,
  SessionRef,
} from "@polyth/contracts";
import { createGitService, parseConflictRegions, type GitService } from "../src/index.ts";
import {
  createManagedWorktrees,
  isolateBranchName,
  isManagedBranch,
  MANAGED_BRANCH_PREFIX,
  readManagedMarker,
  type ManagedWorktreeService,
} from "../src/managedWorktrees.ts";
import {
  branchLockSize,
  createIsolationService,
  withBranchLock,
  type IsolationIntegrationDeps,
  type IsolationSessionApi,
  type IsolationTestHooks,
} from "../src/sessionIntegration.ts";
import type { SpaceContext } from "@polyth/contracts";
import { createActingGit, latestEventOfType } from "../src/serverEntry.ts";
import { createPersonGitProfiles, type GitActor } from "../src/actingPerson.ts";
import { fakePeople } from "./fakePeople.ts";

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

const isolationState = (
  isolation: SessionIsolation,
  state: SessionIsolation["state"],
  fields: Record<string, unknown> = {},
): SessionIsolation => {
  const next = cloneIsolation(isolation) as SessionIsolation & Record<string, unknown>;
  delete next.conflict;
  delete next.publish;
  delete next.resultCommit;
  delete next.dismissedRevision;
  delete next.rebound;
  return Object.assign(next, fields, { state }) as SessionIsolation;
};

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
        ...(input.purpose ? { purpose: input.purpose } : {}),
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
      if (input.expectedWorkspaceRevision !== undefined && input.expectedWorkspaceRevision !== (current.workspace?.revision ?? 0)) {
        throw Object.assign(new Error("workspace revision is stale"), { code: "conflict" });
      }
      if (input.workspace) next.workspace = { ...input.workspace, revision: (current.workspace?.revision ?? 0) + 1 };
      if (input.worktreePath === null) {
        delete next.worktreePath;
        delete next.worktreeState;
      } else if (typeof input.worktreePath === "string") {
        next.worktreePath = input.worktreePath;
        next.worktreeState = "ready";
      }
      if (input.branch) next.branch = input.branch;
      if (current.runtimeBinding) {
        next.runtimeBinding = { ...current.runtimeBinding, location: { directory: next.worktreePath ?? current.isolation?.originPath ?? input.workspace?.repositories.find((row) => row.repositoryId === input.workspace?.executionRepositoryId)?.path ?? current.runtimeBinding.location.directory } };
      }
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
  generateCommitMessage?: (session: SessionProjection, root: string) => Promise<string>;
  commitMessageWaitMs?: number;
  closeWorkspaceProcesses?: (cwd: string) => Promise<void>;
  actingGit?: IsolationIntegrationDeps["actingGit"];
  preserveSessionMedia?: IsolationIntegrationDeps["preserveSessionMedia"];
  /** Wire the indexed newest-turn-stop read; the whole-log read then throws. */
  indexedTurnFacts?: boolean;
  /** Register p1 as a remote (SSH) project. */
  remote?: boolean;
}) => {
  const sessions = makeSessions();
  const closeCalls: string[] = [];
  const ctrl = { failClose: false, failAppend: false };
  const isolation = createIsolationService({
    git: opts?.git ?? git,
    generateCommitMessage: opts?.generateCommitMessage,
    ...(opts?.commitMessageWaitMs !== undefined ? { commitMessageWaitMs: opts.commitMessageWaitMs } : {}),
    ...(opts?.managed ? { managed: opts.managed } : {}),
    sessions,
    projects: {
      get: async (id) => id === "p1" ? { id, path: root, ...(opts?.remote ? { remote: { kind: "ssh" as const, connectionId: "dev-host" } } : {}) } : undefined,
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
    readEvents: async () => {
      if (opts?.indexedTurnFacts) throw new Error("a status read must not load the whole log");
      return [...sessions.events];
    },
    ...(opts?.indexedTurnFacts ? {
      latestTurnStop: async () => sessions.events.findLast((event) => event.type === "turn/stopped"),
      latestEvent: async (_sessionId: string, type: string) => sessions.events.findLast((event) => event.type === type),
    } : {}),
    closeWorkspaceProcesses: async (cwd) => {
      closeCalls.push(cwd);
      await opts?.closeWorkspaceProcesses?.(cwd);
      if (ctrl.failClose) throw new Error("close failed");
    },
    ...(opts?.testHooks ? { testHooks: opts.testHooks } : {}),
    ...(opts?.actingGit ? { actingGit: opts.actingGit } : {}),
    ...(opts?.preserveSessionMedia ? { preserveSessionMedia: opts.preserveSessionMedia } : {}),
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
    purpose: "playground",
    sourceSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  const session = await sessions.snapshot(created.id);
  const meta = session.isolation;
  assert.equal(session.purpose, "playground");
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

test("an isolated chat is created by the requester's scoped sessions", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const requested: string[] = [];
  const created = await isolation.createIsolatedSession({ projectId: "p1", title: "Mine" }, {
    sessions: {
      create: async (input) => { requested.push(input.title ?? ""); return sessions.create(input); },
      snapshot: (id) => sessions.snapshot(id),
    },
  });
  assert.deepEqual(requested, ["Mine"]);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "active");
});

test("a remote project is never isolated with a checkout on this server", async () => {
  // The remote path may also exist here (same layout on both machines): a
  // checkout made by this server's Git would isolate the wrong repository.
  const root = repo();
  const { isolation, sessions } = harness(root, { remote: true });
  await assert.rejects(() => isolation.createIsolatedSession({ projectId: "p1" }), { code: "unsupported" });
  const plain = await sessions.create({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", projectId: "p1" });
  await assert.rejects(() => isolation.isolateSession(plain.id), { code: "unsupported" });
  assert.equal((await git.worktrees.list(root)).length, 1);
  assert.equal(existsSync(`${root}-polyth-isolate`), false);
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

test("merge preserves session-referenced chat media that only lived in the worktree", async () => {
  const root = repo();
  const calls: Array<{ sessionIds: readonly string[]; projectId: string; sourceRoot: string; destinationRoot: string; sourceExisted: boolean }> = [];
  const { isolation, sessions } = harness(root, {
    // The seam owner (packages/files) does the extraction and copy; the git
    // lifecycle must invoke it with the released checkout and the destination
    // checkout while the worktree still exists.
    preserveSessionMedia: async ({ sessionIds, projectId, sourceRoot, destinationRoot }) => {
      const sourceExisted = existsSync(join(sourceRoot, ".scratch", "shot.png"));
      calls.push({ sessionIds, projectId, sourceRoot, destinationRoot, sourceExisted });
      if (sourceExisted) {
        mkdirSync(join(destinationRoot, ".scratch"), { recursive: true });
        writeFileSync(join(destinationRoot, ".scratch", "shot.png"), readFileSync(join(sourceRoot, ".scratch", "shot.png")));
      }
      return { copied: sourceExisted ? [".scratch/shot.png"] : [], skipped: [], missing: sourceExisted ? [] : [".scratch/shot.png"], notIgnored: [] };
    },
  });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  mkdirSync(join(wt, ".scratch"), { recursive: true });
  writeFileSync(join(wt, ".scratch", "shot.png"), "image-bytes");
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.finalized, true);
  // Called once, with the released worktree as source and the project root as
  // the destination the session now reads from, before deletion.
  assert.deepEqual(calls.map((call) => ({ projectId: call.projectId, sourceRoot: call.sourceRoot, destinationRoot: call.destinationRoot, sourceExisted: call.sourceExisted })), [
    { projectId: "p1", sourceRoot: wt, destinationRoot: root, sourceExisted: true },
  ]);
  assert.deepEqual(calls[0]!.sessionIds, [created.id]);
  assert.equal(existsSync(wt), false);
  assert.equal(readFileSync(join(root, ".scratch", "shot.png"), "utf8"), "image-bytes");
});

test("a failing media seam never blocks the merge or loses isolation cleanup", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root, {
    preserveSessionMedia: async () => { throw new Error("media store unavailable"); },
  });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "feature.ts"), "export const n = 1;\n");
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.finalized, true);
  assert.equal(result.session.isolation, undefined);
  assert.equal(existsSync(wt), false);
  assert.equal(readFileSync(join(root, "feature.ts"), "utf8"), "export const n = 1;\n");
});

test("a finished merge leaves no private refs, integration or isolate folders behind", async () => {
  const root = repo();
  const { isolation, sessions, closeCalls } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "feature.ts"), "export const n = 1;\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, true);
  assert.deepEqual(closeCalls, [wt]);
  assert.equal(runGit(root, "for-each-ref", "refs/polyth/"), "");
  assert.equal(runGit(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
  assert.equal(existsSync(resolve(wt, "..")), false);
  assert.equal(existsSync(`${resolve(root)}-polyth-integrate`), false);
});

test("releasing one isolate keeps the shared isolate folder while siblings still use it", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const a = await isolation.createIsolatedSession({ projectId: "p1", title: "A" });
  const b = await isolation.createIsolatedSession({ projectId: "p1", title: "B" });
  const wtA = (await sessions.snapshot(a.id)).isolation!.worktreePath;
  const wtB = (await sessions.snapshot(b.id)).isolation!.worktreePath;
  await isolation.discard(a.id);
  assert.equal(existsSync(wtA), false);
  assert.equal(existsSync(wtB), true);
  await isolation.discard(b.id);
  assert.equal(existsSync(resolve(wtB, "..")), false);
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
    // The resolver may deliberately checkpoint before merging. Isolation's
    // own snapshot must leave this dirty source untouched.
    runGit(path, "add", "-A");
    runGit(path, "commit", "-qm", "checkpoint isolated changes");
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

/** A durable completed turn, appended where the session's own events go. */
const stopTurn = async (sessions: SessionHarness): Promise<SessionEvent> => {
  // Event times are milliseconds: keep a stop strictly after anything before it.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  const event: SessionEvent = {
    id: randomUUID(),
    sessionId: "x",
    seq: sessions.events.length + 1,
    time: Date.now(),
    type: "turn/stopped",
    data: { reason: "completed" },
    v: 1,
  };
  sessions.events.push(event);
  return event;
};

/** An isolated README edit, a completed turn, then main edits the same line. */
const conflictedSession = async (indexedTurnFacts: boolean) => {
  const root = repo();
  const { isolation, sessions } = harness(root, { indexedTurnFacts });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const worktree = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(worktree, "README.md"), "isolated\n");
  await stopTurn(sessions);
  await isolation.onTurnCompleted(created.id, [...sessions.events]);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
  writeFileSync(join(root, "README.md"), "main-changed\n");
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "change readme on main");
  await assert.rejects(() => isolation.mergeBack(created.id), /conflicting/);
  return { root, worktree, isolation, sessions, sessionId: created.id };
};

for (const indexedTurnFacts of [false, true]) {
  test(`a conflict stays open until a turn completes after it (${indexedTurnFacts ? "indexed" : "whole-log"} facts)`, async () => {
    const { isolation, sessions, sessionId } = await conflictedSession(indexedTurnFacts);
    const conflicted = (await sessions.snapshot(sessionId)).isolation!;
    assert.equal(conflicted.state, "conflict");
    assert.equal(typeof conflicted.conflict?.at, "number");
    // The turn that ended before the merge attempt is what conflicted: it
    // must not read as the agent having resolved it.
    const status = await isolation.getStatus(sessionId);
    assert.equal(status.effectiveState, "conflict");
    assert.equal(status.suggestion?.eligible, false);
    assert.equal(status.suggestion?.reason, "conflict");
    assert.equal(status.actions?.canMerge, false);
    assert.equal(status.actions?.canResolve, true);
    // A turn-completed hook that arrives after the conflict, and boot
    // recovery, keep it too.
    await isolation.onTurnCompleted(sessionId, [...sessions.events]);
    await isolation.recoverAll();
    assert.equal((await sessions.snapshot(sessionId)).isolation?.state, "conflict");
    // A turn that completes after the conflict may have resolved it.
    await stopTurn(sessions);
    const settled = await isolation.getStatus(sessionId);
    assert.equal(settled.suggestion?.eligible, true);
    assert.equal(settled.actions?.canMerge, true);
    await isolation.onTurnCompleted(sessionId, [...sessions.events]);
    assert.equal((await sessions.snapshot(sessionId)).isolation?.state, "merge-ready");
  });
}

test("a conflict recorded without a time is ordered by its notice", async () => {
  const { isolation, sessions, sessionId } = await conflictedSession(true);
  const projection = sessions.projections.get(sessionId)!;
  const legacy = cloneIsolation(projection.isolation)!;
  delete (legacy.conflict as { at?: number }).at;
  sessions.projections.set(sessionId, { ...projection, isolation: legacy });
  assert.equal(sessions.events.at(-1)?.type, "isolation/conflict");
  const status = await isolation.getStatus(sessionId);
  assert.equal(status.suggestion?.eligible, false);
  assert.equal(status.actions?.canResolve, true);
  await stopTurn(sessions);
  assert.equal((await isolation.getStatus(sessionId)).suggestion?.eligible, true);
});

test("conflict preview shows the overlapping lines without touching either checkout", async () => {
  const { root, worktree, isolation, sessionId } = await conflictedSession(false);
  // Uncommitted isolated edits count, exactly as Merge would snapshot them.
  writeFileSync(join(worktree, "notes.txt"), "only here\n");
  const targetHead = runGit(root, "rev-parse", "HEAD");
  const worktreeHead = runGit(worktree, "rev-parse", "HEAD");
  const refsBefore = runGit(root, "for-each-ref", "--format=%(refname) %(objectname)");
  const preview = await isolation.conflictPreview(sessionId);
  assert.equal(preview.targetBranch, "main");
  assert.equal(preview.target, targetHead);
  assert.deepEqual(preview.recorded, ["README.md"]);
  assert.deepEqual(preview.files.map((file) => [file.path, file.kind]), [["README.md", "content"]]);
  assert.deepEqual(preview.files[0]!.regions, [{ line: 1, before: [], target: ["main-changed"], source: ["isolated"], after: [] }]);
  assert.equal(runGit(root, "rev-parse", "HEAD"), targetHead);
  assert.equal(runGit(root, "status", "--porcelain"), "");
  assert.equal(runGit(worktree, "rev-parse", "HEAD"), worktreeHead);
  assert.equal(runGit(worktree, "diff", "--cached", "--name-only"), "");
  assert.match(runGit(worktree, "status", "--porcelain"), /README\.md[\s\S]*notes\.txt/);
  assert.equal(runGit(root, "for-each-ref", "--format=%(refname) %(objectname)"), refsBefore);
});

test("merge conflict preview reports only overlapping edits, with context", async () => {
  const root = repo();
  const lines = (edit: Record<number, string>) =>
    `${Array.from({ length: 12 }, (_, index) => edit[index + 1] ?? `line ${index + 1}`).join("\n")}\n`;
  writeFileSync(join(root, "app.txt"), lines({}));
  writeFileSync(join(root, "apart.txt"), lines({}));
  writeFileSync(join(root, "gone.txt"), "keep\n");
  writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2]));
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "base");
  runGit(root, "checkout", "-qb", "work");
  writeFileSync(join(root, "app.txt"), lines({ 6: "work six", 10: "work ten" }));
  writeFileSync(join(root, "apart.txt"), lines({ 2: "work two" }));
  writeFileSync(join(root, "gone.txt"), "work edit\n");
  writeFileSync(join(root, "image.bin"), Buffer.from([0, 9, 9]));
  runGit(root, "commit", "-qam", "work");
  runGit(root, "checkout", "-q", "main");
  writeFileSync(join(root, "app.txt"), lines({ 6: "main six", 12: "main twelve" }));
  writeFileSync(join(root, "apart.txt"), lines({ 11: "main eleven" }));
  runGit(root, "rm", "-q", "gone.txt");
  writeFileSync(join(root, "image.bin"), Buffer.from([0, 7, 7]));
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "main");
  const preview = await git.mergeConflicts(root, {
    target: runGit(root, "rev-parse", "main"),
    source: runGit(root, "rev-parse", "work"),
  });
  assert.deepEqual(preview.files.map((file) => [file.path, file.kind]), [
    ["app.txt", "content"],
    ["gone.txt", "deleted-in-target"],
    ["image.bin", "binary"],
  ]);
  assert.deepEqual(preview.files[0]!.regions, [{
    line: 6,
    before: ["line 3", "line 4", "line 5"],
    target: ["main six"],
    source: ["work six"],
    after: ["line 7", "line 8", "line 9"],
  }]);
  assert.equal(runGit(root, "status", "--porcelain"), "");
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("conflict regions parse diff3 sections and count source lines", () => {
  const marker = (char: string) => char.repeat(7);
  const merged = [
    "a",
    `${marker("<")} target`, "t1", `${marker("|")} base`, "b1", marker("="), "s1", "s2", `${marker(">")} source`,
    "c", "d",
    `${marker("<")} target`, `${marker("=")}`, "s3", `${marker(">")} source`,
    "e",
    "",
  ].join("\n");
  assert.deepEqual(parseConflictRegions(merged, 7), {
    regions: [
      { line: 2, before: ["a"], target: ["t1"], source: ["s1", "s2"], after: ["c", "d"] },
      { line: 6, before: ["c", "d"], target: [], source: ["s3"], after: ["e"] },
    ],
  });
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

test("status reads only the newest turn stop, not the whole log", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root, { indexedTurnFacts: true });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "x.txt"), "x\n");
  assert.equal((await isolation.getStatus(created.id)).suggestion?.reason, "no-turn", "no completed turn yet");
  sessions.events.push({ ...completedTurn(created.id), seq: sessions.events.length + 1 });
  const ready = await isolation.getStatus(created.id);
  assert.equal(ready.suggestion?.eligible, true);
  assert.equal(ready.actions?.canMerge, true);
});

test("latestEventOfType pages the indexed fact query to the newest match", async () => {
  const stops = Array.from({ length: 1_203 }, (_, index) => ({
    id: `e${index}`, sessionId: "s", seq: (index + 1) * 2, time: index, type: "turn/stopped", data: { n: index }, v: 1,
  }));
  const calls: Array<[number, number, number]> = [];
  const store = {
    events: async () => { throw new Error("the whole log is never read when facts are indexed"); },
    latestSeq: async () => 99_999,
    eventsOfTypes: async (_id: string, _types: readonly string[], after: number, through: number, limit = 500) => {
      calls.push([after, through, limit]);
      return stops.filter((event) => event.seq > after && event.seq <= through).slice(0, limit);
    },
  };
  const newest = await latestEventOfType(store as never, "s", "turn/stopped");
  assert.equal(newest?.id, "e1202");
  assert.deepEqual(calls.map(([after]) => after), [0, 1_000, 2_000]);
  assert.equal(await latestEventOfType({ ...store, eventsOfTypes: async () => [] } as never, "s", "turn/stopped"), undefined);
  const fallback = await latestEventOfType({
    events: async () => [stops[0], { ...stops[1]!, type: "user/message" }, stops[2]],
    latestSeq: async () => 0,
  } as never, "s", "turn/stopped");
  assert.equal(fallback?.id, "e2", "without the indexed query, the newest match of the full read");
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

test("dirty checkout of the target branch preserves compatible uncommitted work", async () => {
  const root = repo();
  writeFileSync(join(root, "local-staged.txt"), "base staged\n");
  writeFileSync(join(root, "local-unstaged.txt"), "base unstaged\n");
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "local work fixtures");
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-feature-dirty-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  writeFileSync(join(featureWt, "local-staged.txt"), "user staged\n");
  runGit(featureWt, "add", "local-staged.txt");
  writeFileSync(join(featureWt, "local-unstaged.txt"), "user unstaged\n");
  writeFileSync(join(featureWt, "local-untracked.txt"), "user untracked\n");
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "from-iso.txt"), "yes\n");
  const before = runGit(root, "rev-parse", "feature");
  const event = completedTurn(created.id);
  sessions.events.push(event);
  await isolation.onTurnCompleted(created.id, [event]);
  const ready = await isolation.getStatus(created.id);
  assert.equal(ready.suggestion?.eligible, true);
  assert.equal(ready.suggestion?.targetDirty, true);
  assert.equal(ready.actions?.canMerge, true);

  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.notEqual(runGit(root, "rev-parse", "feature"), before);
  assert.equal(readFileSync(join(featureWt, "from-iso.txt"), "utf8"), "yes\n");
  assert.equal(readFileSync(join(featureWt, "local-staged.txt"), "utf8"), "user staged\n");
  assert.equal(readFileSync(join(featureWt, "local-unstaged.txt"), "utf8"), "user unstaged\n");
  assert.equal(readFileSync(join(featureWt, "local-untracked.txt"), "utf8"), "user untracked\n");
  const status = await git.status(featureWt);
  assert.deepEqual(status.staged.map((file) => file.path), ["local-staged.txt"]);
  assert.deepEqual(status.unstaged.map((file) => file.path), ["local-unstaged.txt"]);
  assert.deepEqual(status.untracked.map((file) => file.path), ["local-untracked.txt"]);
});

test("overlapping target changes stop before publication and remain untouched", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "README.md"), "isolated\n");
  writeFileSync(join(root, "README.md"), "parent work\n");
  runGit(root, "add", "README.md");
  const before = runGit(root, "rev-parse", "HEAD");
  const indexBefore = readFileSync(join(root, ".git", "index"));

  await assert.rejects(() => isolation.mergeBack(created.id), /overlap this integration/);
  assert.equal(runGit(root, "rev-parse", "HEAD"), before);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "parent work\n");
  assert.deepEqual(readFileSync(join(root, ".git", "index")), indexBefore);
  assert.equal(existsSync(source), true);
  const conflict = (await sessions.snapshot(created.id)).isolation;
  assert.equal(conflict?.state, "conflict");
  assert.equal(conflict?.targetRepair?.kind, "target-overlap");
  assert.equal(conflict?.targetRepair?.targetHead, before);
  assert.equal(conflict?.targetRepair?.applied, false);
  assert.equal(await git.readRef(root, `refs/polyth/isolation-repair/${created.id}`), conflict?.targetRepair?.snapshotSha);
});

test("AI repair resolves overlapping target work and installs it with a backup", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "README.md"), "isolated\n");
  writeFileSync(join(root, "README.md"), "parent work\n");
  runGit(root, "add", "README.md");
  const targetHead = runGit(root, "rev-parse", "HEAD");

  await assert.rejects(() => isolation.mergeBack(created.id), /overlap this integration/);
  const conflicted = (await sessions.snapshot(created.id)).isolation!;
  assert.equal(conflicted.state, "conflict");
  assert.equal(conflicted.targetRepair?.applied, false);
  const backupSha = conflicted.targetRepair!.snapshotSha;
  assert.equal(await git.readRef(root, `refs/polyth/isolation-repair/${created.id}`), backupSha);

  sessions.sendImpl = async (sessionId, input) => {
    assert.match(input.text, /private snapshot of its local work/);
    const current = await sessions.snapshot(sessionId);
    assert.equal(current.isolation?.targetRepair?.applied, true);
    writeFileSync(join(current.isolation!.worktreePath, "README.md"), "resolved\n");
    runGit(current.isolation!.worktreePath, "add", "README.md");
    runGit(current.isolation!.worktreePath, "commit", "-qm", "resolve target-local overlap");
    return {};
  };
  await isolation.resolveWithAgent(created.id);
  assert.equal((await sessions.snapshot(created.id)).isolation?.targetRepair?.applied, true);
  await isolation.onTurnCompleted(created.id, [completedTurn(created.id)]);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");

  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "resolved\n");
  assert.equal((await git.status(root)).clean, true);
  assert.equal(runGit(root, "rev-parse", "HEAD") !== targetHead, true);
  assert.equal(runGit(root, "show", `${backupSha}:README.md`), "parent work");
  // The replaced local work stays recoverable; the receipt is released.
  assert.equal(await git.readRef(root, `refs/polyth/isolation-repair/${created.id}`), backupSha);
  assert.equal(await git.readRef(root, `refs/polyth/isolation/${created.id}`), null);
});

test("discarding after an AI repair backup keeps the backup and drops the receipt", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "README.md"), "isolated\n");
  writeFileSync(join(root, "README.md"), "parent work\n");
  runGit(root, "add", "README.md");
  await assert.rejects(() => isolation.mergeBack(created.id), /overlap this integration/);
  assert.ok(await git.readRef(root, `refs/polyth/isolation-repair/${created.id}`));
  await isolation.discard(created.id);
  assert.equal((await sessions.snapshot(created.id)).isolation, undefined);
  // The target checkout was never replaced, so its work is still in place.
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "parent work\n");
  // A repair backup holds target-checkout work and is never released automatically.
  assert.ok(await git.readRef(root, `refs/polyth/isolation-repair/${created.id}`));
  assert.equal(await git.readRef(root, `refs/polyth/isolation/${created.id}`), null);
});

test("AI repair returns to conflict instead of corrupt when the target moved after the backup", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "README.md"), "isolated\n");
  writeFileSync(join(root, "README.md"), "parent work\n");
  runGit(root, "add", "README.md");
  await assert.rejects(() => isolation.mergeBack(created.id), /overlap this integration/);
  sessions.sendImpl = async (sessionId) => {
    const current = await sessions.snapshot(sessionId);
    writeFileSync(join(current.isolation!.worktreePath, "README.md"), "resolved\n");
    runGit(current.isolation!.worktreePath, "add", "README.md");
    runGit(current.isolation!.worktreePath, "commit", "-qm", "resolve target-local overlap");
    return {};
  };
  await isolation.resolveWithAgent(created.id);
  await isolation.onTurnCompleted(created.id, [completedTurn(created.id)]);
  writeFileSync(join(root, "other.txt"), "landed meanwhile\n");
  runGit(root, "add", "other.txt");
  runGit(root, "commit", "-qm", "unrelated target commit", "--", "other.txt");

  await assert.rejects(() => isolation.mergeBack(created.id), /moved after its local changes were backed up/);
  const after = (await sessions.snapshot(created.id)).isolation!;
  assert.equal(after.state, "conflict");
  assert.ok(after.targetRepair);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "parent work\n");
});

test("AI repair recovery installs the backed-up result after a publication crash", async () => {
  const root = repo();
  let crashAfterPublication = false;
  const { isolation, sessions } = harness(root, {
    testHooks: { afterPublish: async () => { if (crashAfterPublication) throw new Error("injected repair publication crash"); } },
  });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "README.md"), "isolated\n");
  writeFileSync(join(root, "README.md"), "parent work\n");
  runGit(root, "add", "README.md");
  await assert.rejects(() => isolation.mergeBack(created.id), /overlap this integration/);
  sessions.sendImpl = async (sessionId) => {
    const current = await sessions.snapshot(sessionId);
    writeFileSync(join(current.isolation!.worktreePath, "README.md"), "resolved\n");
    runGit(current.isolation!.worktreePath, "add", "README.md");
    runGit(current.isolation!.worktreePath, "commit", "-qm", "resolve target-local overlap");
    return {};
  };
  await isolation.resolveWithAgent(created.id);
  await isolation.onTurnCompleted(created.id, [completedTurn(created.id)]);
  crashAfterPublication = true;
  const pending = await isolation.mergeBack(created.id);
  assert.equal(pending.finalized, false);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "publishing");
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "parent work\n");
  const recovered = await isolation.recover(created.id);
  assert.equal(recovered.isolation, undefined);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "resolved\n");
  assert.equal((await git.status(root)).clean, true);
});

test("AI repair refuses to overwrite target edits made after the receipt", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "README.md"), "isolated\n");
  writeFileSync(join(root, "README.md"), "parent work\n");
  runGit(root, "add", "README.md");
  await assert.rejects(() => isolation.mergeBack(created.id), /overlap this integration/);
  writeFileSync(join(root, "README.md"), "newer parent work\n");
  let sent = 0;
  sessions.sendImpl = async () => { sent += 1; return {}; };
  await assert.rejects(() => isolation.resolveWithAgent(created.id), /local changes changed|nothing was overwritten/);
  assert.equal(sent, 0);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "newer parent work\n");
});

test("non-overlapping target edits to the same file are carried through merge-back", async () => {
  const root = repo();
  writeFileSync(join(root, "shared.txt"), "l1\nl2\nl3\nl4\nl5\n");
  runGit(root, "add", "shared.txt");
  runGit(root, "commit", "-qm", "shared base");
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "shared.txt"), "isolated1\nl2\nl3\nl4\nl5\n");
  // Uncommitted target edit to a different hunk of the same file.
  writeFileSync(join(root, "shared.txt"), "l1\nl2\nl3\nl4\nlocal5\n");
  runGit(root, "add", "shared.txt");
  const event = completedTurn(created.id);
  sessions.events.push(event);
  await isolation.onTurnCompleted(created.id, [event]);
  assert.equal((await isolation.getStatus(created.id)).actions?.canMerge, true);

  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.equal(readFileSync(join(root, "shared.txt"), "utf8"), "isolated1\nl2\nl3\nl4\nlocal5\n");
  const status = await git.status(root);
  assert.deepEqual(status.staged.map((file) => file.path), ["shared.txt"]);
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

test("disappearing worktree derives missing health without overwriting lifecycle", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  rmSync(session.isolation!.worktreePath, { recursive: true, force: true });
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation?.state, "active");
  assert.equal((await isolation.getStatus(created.id)).effectiveState, "missing");
  assert.equal(recovered.id, created.id);
  await assert.rejects(() => isolation.mergeBack(created.id), /no longer available/);
  const discarded = await isolation.discard(created.id);
  assert.equal(discarded.isolation, undefined);
  assert.equal(discarded.worktreePath, undefined);
  // The branch never moved past its base, so it held nothing and leaves with
  // the vanished checkout; a branch with commits of its own would stay.
  assert.equal((await git.branches(root)).branches.some((item) => item.name === session.isolation!.worktreeBranch), false);
  assert.equal((await git.worktrees.list(root)).length, 1);
});

test("startup recovery normalizes legacy pre-publication state and quarantines unknown state", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  sessions.projections.set(created.id, {
    ...session,
    isolation: {
      ...session.isolation,
      state: "merging",
      rebound: true,
      conflict: { message: "stale", files: [] },
    } as unknown as SessionIsolation,
  });
  const normalized = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(normalized.isolation?.state, "active");
  assert.equal(normalized.isolation?.publish, undefined);
  assert.equal(normalized.isolation?.conflict, undefined);
  assert.equal("rebound" in normalized.isolation!, false);

  sessions.projections.set(created.id, {
    ...normalized,
    isolation: { ...normalized.isolation, state: "future-state" } as unknown as SessionIsolation,
  });
  const rawUnknown = (await sessions.snapshot(created.id)).isolation;
  const unknownStatus = await isolation.getStatus(created.id);
  assert.equal(unknownStatus.effectiveState, "corrupt");
  assert.deepEqual(unknownStatus.actions, {
    canReview: false, canMerge: false, canKeep: false, canResolve: false,
    canDiscard: false, canRecover: false, canAbandon: false,
  });
  assert.deepEqual((await isolation.recover(created.id)).isolation, rawUnknown);
  assert.deepEqual((await sessions.snapshot(created.id)).isolation, rawUnknown);
  assert.equal(existsSync(session.isolation!.worktreePath), true);
});

test("a present but malformed publication intent is quarantined instead of treated as unpublished", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const before = runGit(root, "rev-parse", "main");
  sessions.projections.set(created.id, {
    ...session,
    isolation: {
      ...session.isolation,
      state: "merging",
      publish: {
        expectedTargetSha: before,
        resultCommit: "not-a-commit",
        snapshotSha: before,
        targetRef: "refs/heads/main",
      },
    } as unknown as SessionIsolation,
  });

  const malformed = (await sessions.snapshot(created.id)).isolation;
  const status = await isolation.getStatus(created.id);
  assert.equal(status.effectiveState, "corrupt");
  assert.equal(status.actions?.canDiscard, false);
  assert.deepEqual((await isolation.recover(created.id)).isolation, malformed);
  await assert.rejects(() => isolation.discard(created.id), /cannot discard from corrupt/);
  assert.equal(runGit(root, "rev-parse", "main"), before);
  assert.equal(existsSync(session.isolation!.worktreePath), true);
});

test("corrupt labeled publication evidence is never erased by resource repair", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const malformed = {
    ...session.isolation!,
    state: "corrupt",
    publish: {
      expectedTargetSha: "old",
      resultCommit: "published",
      snapshotSha: "snapshot",
      targetRef: "refs/heads/main",
    },
  } as unknown as SessionIsolation;
  sessions.projections.set(created.id, { ...session, isolation: malformed });

  const recovered = await isolation.recover(created.id);
  assert.deepEqual(recovered.isolation, malformed);
  assert.deepEqual((await sessions.snapshot(created.id)).isolation, malformed);
  await assert.rejects(() => isolation.discard(created.id), /cannot discard from corrupt/);
  assert.equal(existsSync(session.isolation!.worktreePath), true);
});

test("publication recovery rejects a receipt owned by another canonical session", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const source = session.isolation!;
  writeFileSync(join(source.worktreePath, "never-published.txt"), "private\n");
  const snapshot = await isolation.managed.snapshot(source.worktreePath, "test snapshot");
  const head = runGit(root, "rev-parse", "main");
  const foreignReceipt = `refs/polyth/isolation/${randomUUID()}`;
  runGit(root, "update-ref", foreignReceipt, head);
  const publishing = isolationState(source, "publishing", {
    publish: {
      expectedTargetSha: head,
      resultCommit: head,
      snapshotSha: snapshot.sha,
      targetRef: "refs/heads/main",
      receiptRef: foreignReceipt,
      checkoutPath: root,
      sourceRevision: await git.fingerprint(source.worktreePath),
    },
  });
  sessions.projections.set(created.id, { ...session, isolation: publishing });

  const status = await isolation.getStatus(created.id);
  assert.equal(status.effectiveState, "corrupt");
  assert.deepEqual(status.actions, {
    canReview: false, canMerge: false, canKeep: false, canResolve: false,
    canDiscard: false, canRecover: false, canAbandon: false,
  });
  await assert.rejects(() => isolation.recover(created.id), /receipt does not belong/);
  assert.equal(sessions.rebindCalls, 0);
  assert.deepEqual((await sessions.snapshot(created.id)).isolation, publishing);
  assert.equal(existsSync(source.worktreePath), true);
  assert.equal(existsSync(join(root, "never-published.txt")), false);
});

test("publication recovery rejects an origin path replaced by another repository", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featurePath = mkdtempSync(join(tmpdir(), "polyth-replaced-origin-"));
  dirs.push(featurePath);
  rmSync(featurePath, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featurePath });
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  const session = await sessions.snapshot(created.id);
  const source = session.isolation!;
  writeFileSync(join(source.worktreePath, "private-source.txt"), "private\n");
  const snapshot = await isolation.managed.snapshot(source.worktreePath, "test snapshot");
  const head = runGit(root, "rev-parse", "feature");
  const receiptRef = `refs/polyth/isolation/${created.id}`;
  runGit(root, "update-ref", receiptRef, head);
  const publishing = isolationState(source, "publishing", {
    publish: {
      expectedTargetSha: head,
      resultCommit: head,
      snapshotSha: snapshot.sha,
      targetRef: "refs/heads/feature",
      receiptRef,
      checkoutPath: featurePath,
      sourceRevision: await git.fingerprint(source.worktreePath),
    },
  });
  sessions.projections.set(created.id, { ...session, isolation: publishing });

  rmSync(featurePath, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", "--", root, featurePath], { stdio: "pipe" });
  runGit(featurePath, "switch", "-q", "-c", "feature", "origin/feature");
  assert.notEqual(resolve(await git.commonDir(featurePath)), resolve(await git.commonDir(root)));

  await assert.rejects(() => isolation.recover(created.id), /recorded repository checkout|not checked out/);
  assert.equal(sessions.rebindCalls, 0);
  assert.deepEqual((await sessions.snapshot(created.id)).isolation, publishing);
  assert.equal(existsSync(source.worktreePath), true);
  assert.equal(existsSync(join(featurePath, "private-source.txt")), false);
});

test("status fails closed without persisting when Git ownership cannot be read", async () => {
  const root = repo();
  let unreadable = false;
  const guarded: GitService = {
    ...git,
    worktrees: {
      ...git.worktrees,
      list: async (path) => {
        if (unreadable) throw new Error("inventory unavailable");
        return git.worktrees.list(path);
      },
    },
  };
  const { isolation, sessions } = harness(root, { git: guarded });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const writes = sessions.persistCalls;
  unreadable = true;

  const status = await isolation.getStatus(created.id);
  assert.equal(status.effectiveState, "unowned");
  assert.equal(status.suggestion?.eligible, false);
  assert.deepEqual(status.actions, {
    canReview: false, canMerge: false, canKeep: false, canResolve: false,
    canDiscard: false, canRecover: false, canAbandon: false,
  });
  assert.equal(sessions.persistCalls, writes);
  await assert.rejects(() => isolation.mergeBack(created.id), /inventory unavailable/);
  unreadable = false;
  assert.equal((await isolation.getStatus(created.id)).effectiveState, "active");
});

test("corrupted managed marker cannot be published or deleted", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const wt = session.isolation!.worktreePath;
  writeFileSync(join(wt, "keep-me.ts"), "x\n");
  const gitDir = await git.gitDir(wt);
  writeFileSync(join(gitDir, "polyth-managed.json"), "{not-json");
  const before = runGit(root, "rev-parse", "HEAD");
  await assert.rejects(() => isolation.mergeBack(created.id), /ownership is not proven/);
  assert.equal(runGit(root, "rev-parse", "HEAD"), before);
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
  const cleanup = isolationState(pending.isolation!, "cleanup-pending");
  await sessions.patchIsolation!(leftover.id, cleanup);
  await sessions.rebindWorkspace!(leftover.id, { worktreePath: null, branch: "main", isolation: cleanup });
  const recovered = await isolation.recoverSession(await sessions.snapshot(leftover.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(pending.isolation!.worktreePath), false);
});

test("failed cleanup can be retried", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const cleanup = isolationState(session.isolation!, "cleanup-pending");
  await sessions.patchIsolation!(created.id, cleanup);
  await sessions.rebindWorkspace!(created.id, {
    worktreePath: null,
    branch: "main",
    isolation: cleanup,
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

test("a merge failure that left the target untouched is reported as rejected, not outcome-unknown", async () => {
  for (const stage of ["afterIntegrationCreated", "beforePublish"] as const) {
    const root = repo();
    const hooks: IsolationTestHooks = {
      [stage]: async () => { throw Object.assign(new Error(`injected ${stage} failure`), { code: "unavailable" }); },
    };
    const { isolation, sessions } = harness(root, { testHooks: hooks });
    const created = await isolation.createIsolatedSession({ projectId: "p1" });
    const before = runGit(root, "rev-parse", "HEAD");
    writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "x.txt"), "x\n");
    await assert.rejects(() => isolation.mergeBack(created.id), (error: unknown) => {
      const tagged = error as { message: string; code: string; mutationOutcome?: string; retryability?: string };
      assert.match(tagged.message, new RegExp(`injected ${stage} failure`), stage);
      assert.equal(tagged.code, "unavailable", stage);
      assert.equal(tagged.mutationOutcome, "rejected", stage);
      assert.equal(tagged.retryability, "safe", stage);
      return true;
    });
    assert.equal(runGit(root, "rev-parse", "HEAD"), before, stage);
  }
});

test("source edits after snapshot block publication and are never deleted", async () => {
  const root = repo();
  let source = "";
  const hooks: IsolationTestHooks = {
    beforePublish: async () => {
      writeFileSync(join(source, "late.txt"), "late\n");
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "snapshotted.txt"), "snapshot\n");
  const before = runGit(root, "rev-parse", "HEAD");
  await assert.rejects(() => isolation.mergeBack(created.id), /changed after its merge snapshot/);
  assert.equal(runGit(root, "rev-parse", "HEAD"), before);
  assert.equal(existsSync(join(source, "late.txt")), true);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
  hooks.beforePublish = undefined;
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, true);
  assert.equal(readFileSync(join(root, "late.txt"), "utf8"), "late\n");
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

test("startup never prunes an integration owned by an unknown canonical session", async () => {
  const root = repo();
  const managed = createManagedWorktrees(git);
  const { isolation } = harness(root, { managed });
  const foreignId = randomUUID();
  const path = await managed.createIntegrationWorkspace({
    root,
    sessionId: foreignId,
    startPoint: runGit(root, "rev-parse", "HEAD"),
  });
  await isolation.recoverAll();
  assert.equal(existsSync(path), true);
  await managed.discardIntegration(root, path, foreignId);
});

test("startup never deletes an isolated workspace owned by an unknown canonical session", async () => {
  const root = repo();
  const managed = createManagedWorktrees(git);
  const { isolation, sessions } = harness(root, { managed });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!;
  sessions.projections.delete(created.id);
  await isolation.recoverAll();
  assert.equal(existsSync(source.worktreePath), true);
  await managed.removeOwned(root, {
    sessionId: created.id,
    worktreePath: source.worktreePath,
    worktreeBranch: source.worktreeBranch,
  });
});

test("cleanup preserves another project's canonical session using the source as its root", async () => {
  const root = repo();
  const sessions = makeSessions();
  let sourcePath = "";
  const isolation = createIsolationService({
    git,
    sessions,
    projects: {
      get: async (id) => id === "p1"
        ? { id, path: root }
        : id === "p2" && sourcePath ? { id, path: sourcePath } : undefined,
    },
    append: async () => undefined,
  });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  sourcePath = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(sourcePath, "shared.txt"), "shared\n");
  const dependent = await sessions.create({ projectId: "p2" });

  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, false);
  assert.equal(merged.session.isolation?.state, "cleanup-pending");
  assert.equal(existsSync(sourcePath), true);
  assert.equal((await sessions.snapshot(dependent.id)).projectId, "p2");

  sessions.projections.delete(dependent.id);
  const cleaned = await isolation.recover(created.id);
  assert.equal(cleaned.isolation, undefined);
  assert.equal(existsSync(sourcePath), false);
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
  await sessions.patchIsolation!(created.id, isolationState(session.isolation!, "merging", {
    publish: {
      expectedTargetSha: session.isolation!.baseCommit,
      resultCommit: session.isolation!.baseCommit,
      snapshotSha: session.isolation!.baseCommit,
      targetRef: "refs/heads/main",
    },
  }));
  await assert.rejects(() => isolation.keepIsolated(created.id), /cannot keep/);
  await assert.rejects(() => isolation.discard(created.id), /cannot discard/);
});

test("ambiguous publication is left publishing, never treated as unpublished", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  const head = runGit(root, "rev-parse", "HEAD");
  await sessions.patchIsolation!(created.id, isolationState(session.isolation!, "merging", {
    targetBranch: "does-not-exist",
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

test("nested isolation is rejected through both source session and managed branch inputs", async () => {
  const root = repo();
  const { isolation } = harness(root);
  const first = await isolation.createIsolatedSession({ projectId: "p1" });
  await assert.rejects(
    () => isolation.createIsolatedSession({ projectId: "p1", sourceSessionId: first.id }),
    /nested session isolation is not supported/,
  );
  const firstStatus = await isolation.getStatus(first.id);
  await assert.rejects(
    () => isolation.createIsolatedSession({ projectId: "p1", targetBranch: firstStatus.isolation!.worktreeBranch }),
    /managed isolation branches cannot be used as an origin/,
  );
});

test("another session's managed workspace can never be used as merge input", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const a = await isolation.createIsolatedSession({ projectId: "p1", title: "A" });
  const b = await isolation.createIsolatedSession({ projectId: "p1", title: "B" });
  const sessionA = await sessions.snapshot(a.id);
  const sessionB = await sessions.snapshot(b.id);
  writeFileSync(join(sessionB.isolation!.worktreePath, "from-b.txt"), "b\n");
  await sessions.patchIsolation!(a.id, isolationState(sessionA.isolation!, "active", {
    worktreePath: sessionB.isolation!.worktreePath,
    worktreeBranch: sessionB.isolation!.worktreeBranch,
  }));
  const before = runGit(root, "rev-parse", "main");
  await assert.rejects(() => isolation.mergeBack(a.id), /ownership is not proven/);
  assert.equal(runGit(root, "rev-parse", "main"), before);
  assert.equal(existsSync(join(root, "from-b.txt")), false);
});

test("marker identity mismatch blocks publication", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "blocked.txt"), "x\n");
  const markerPath = join(await git.gitDir(session.isolation!.worktreePath), "polyth-managed.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  writeFileSync(markerPath, JSON.stringify({ ...marker, sessionId: randomUUID() }));
  const before = runGit(root, "rev-parse", "main");
  await assert.rejects(() => isolation.mergeBack(created.id), /ownership is not proven/);
  assert.equal(runGit(root, "rev-parse", "main"), before);
});

test("origin branch change refuses publication before the target ref moves", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "not-published.txt"), "x\n");
  runGit(root, "switch", "-c", "other");
  const before = runGit(root, "rev-parse", "main");
  await assert.rejects(() => isolation.mergeBack(created.id), /origin workspace/);
  assert.equal(runGit(root, "rev-parse", "main"), before);
  assert.equal(existsSync(join(root, "not-published.txt")), false);
});

test("a switched origin checkout is offered as a target and merging there retargets the session", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-retarget-feature-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const worktreePath = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(worktreePath, "retargeted.txt"), "x\n");
  sessions.events.push(completedTurn(created.id));
  runGit(root, "switch", "-q", "-c", "other");
  const mainBefore = runGit(root, "rev-parse", "main");

  const status = await isolation.getStatus(created.id);
  assert.equal(status.suggestion?.reason, "destination-unavailable");
  assert.equal(status.actions?.canMerge, false);
  assert.equal(status.actions?.canChooseTarget, true);
  assert.deepEqual(status.targets?.map(({ branch, origin, current }) => ({ branch, origin, current })), [
    { branch: "other", origin: true, current: false },
    { branch: "feature", origin: false, current: false },
  ]);
  assert.equal(status.targets?.some((target) => target.path === resolve(worktreePath)), false);

  const merged = await isolation.mergeBack(created.id, { target: { branch: "other", path: root } });
  assert.equal(merged.targetBranch, "other");
  assert.equal(merged.finalized, true);
  assert.equal(readFileSync(join(root, "retargeted.txt"), "utf8"), "x\n");
  assert.equal(runGit(root, "rev-parse", "main"), mainBefore);
  assert.equal(runGit(root, "rev-parse", "other"), merged.commit);
  await assertBoundTo(await sessions.snapshot(created.id), root, root, "other");
});

test("a retarget interrupted after its marker write keeps the checkout owned", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const recorded = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(recorded.worktreePath, "kept.txt"), "x\n");
  // The marker names the new target while the session record still names
  // the old one: the state a crash between the two writes leaves.
  await createManagedWorktrees(git).retarget(root, {
    sessionId: created.id,
    worktreePath: recorded.worktreePath,
    worktreeBranch: recorded.worktreeBranch,
    targetPath: recorded.targetPath,
    targetBranch: recorded.targetBranch,
    baseCommit: recorded.baseCommit,
  }, "feature");
  const marker = await readManagedMarker(git, recorded.worktreePath);
  assert.ok(marker && marker !== "corrupt" && marker.kind !== "integration");
  assert.equal(marker.targetBranch, "feature");
  assert.equal(marker.retargetedFrom, "main");
  const status = await isolation.getStatus(created.id);
  assert.notEqual(status.effectiveState, "unowned");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.targetBranch, "main");
  assert.equal(readFileSync(join(root, "kept.txt"), "utf8"), "x\n");
});

test("a chosen target must be an ordinary branch checked out at the given path", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const recorded = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(recorded.worktreePath, "kept.txt"), "x\n");
  const before = runGit(root, "rev-parse", "main");
  await assert.rejects(
    () => isolation.mergeBack(created.id, { target: { branch: "feature", path: root } }),
    /feature is not checked out at/,
  );
  await assert.rejects(
    () => isolation.mergeBack(created.id, { target: { branch: recorded.worktreeBranch, path: recorded.worktreePath } }),
    /managed isolation branches/,
  );
  const after = (await sessions.snapshot(created.id)).isolation!;
  assert.equal(after.targetBranch, "main");
  assert.equal(after.originPath, recorded.originPath);
  assert.equal(runGit(root, "rev-parse", "main"), before);
  assert.equal(runGit(root, "rev-parse", "feature"), before);
});

test("retarget records another checked-out branch as the target without merging", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-retarget-only-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const recorded = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(recorded.worktreePath, "chosen.txt"), "x\n");
  sessions.events.push(completedTurn(created.id));
  const before = runGit(root, "rev-parse", "main");

  const projection = await isolation.retarget(created.id, { branch: "feature", path: featureWt });
  assert.equal(projection.isolation?.targetBranch, "feature");
  assert.equal(resolve(projection.isolation!.originPath!), resolve(featureWt));
  assert.equal(projection.isolation?.state, "active");
  // Nothing was integrated: both branches and the work are where they were.
  assert.equal(runGit(root, "rev-parse", "main"), before);
  assert.equal(runGit(root, "rev-parse", "feature"), before);
  assert.equal(existsSync(join(featureWt, "chosen.txt")), false);
  assert.ok(existsSync(join(recorded.worktreePath, "chosen.txt")));
  const notice = sessions.events.findLast((event) => event.type === "isolation/retargeted");
  assert.deepEqual(notice?.data, { fromBranch: "main", targetBranch: "feature" });

  const status = await isolation.getStatus(created.id);
  assert.equal(status.targets?.find((target) => target.current)?.branch, "feature");
  assert.equal(status.actions?.canMerge, true);

  // Choosing the recorded target again changes nothing and records nothing.
  const noticesBefore = sessions.events.filter((event) => event.type === "isolation/retargeted").length;
  await isolation.retarget(created.id, { branch: "feature", path: featureWt });
  assert.equal(sessions.events.filter((event) => event.type === "isolation/retargeted").length, noticesBefore);

  // The ordinary merge now goes to the chosen branch.
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.targetBranch, "feature");
  assert.equal(readFileSync(join(featureWt, "chosen.txt"), "utf8"), "x\n");
  assert.equal(runGit(root, "rev-parse", "main"), before);
  await assertBoundTo(await sessions.snapshot(created.id), root, featureWt, "feature");
});

test("retarget is refused while the session runs and for a branch that is not checked out", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const recorded = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(recorded.worktreePath, "kept.txt"), "x\n");
  await assert.rejects(
    () => isolation.retarget(created.id, { branch: "feature", path: root }),
    /feature is not checked out at/,
  );
  sessions.projections.set(created.id, { ...sessions.projections.get(created.id)!, status: "working" });
  await assert.rejects(
    () => isolation.retarget(created.id, { branch: "main", path: root }),
    /session is still running/,
  );
  const after = (await sessions.snapshot(created.id)).isolation!;
  assert.equal(after.targetBranch, "main");
  assert.equal(after.originPath, recorded.originPath);
  assert.equal(sessions.events.some((event) => event.type === "isolation/retargeted"), false);
});

test("origin checkout disappearing at the publication boundary cannot fall back to another ref update", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-feature-publish-race-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  const before = runGit(root, "rev-parse", "feature");
  const hooks: IsolationTestHooks = {
    beforePublish: async () => {
      await git.worktrees.remove(root, { path: featureWt, force: true });
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "race.txt"), "x\n");
  await assert.rejects(() => isolation.mergeBack(created.id), /origin workspace/);
  assert.equal(runGit(root, "rev-parse", "feature"), before);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
});

test("post-publication destination loss is explicit and recovery never republishes", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-feature-return-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  let removed = false;
  const hooks: IsolationTestHooks = {
    afterPublish: async () => {
      if (removed) return;
      removed = true;
      await git.worktrees.remove(root, { path: featureWt, deleteBranch: false, force: true });
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published-once.txt"), "once\n");
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.finalized, false);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "publishing");
  assert.equal(existsSync(source), true);
  const published = runGit(root, "rev-parse", "feature");
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(runGit(root, "rev-parse", "feature"), published);
  assert.equal(readFileSync(join(featureWt, "published-once.txt"), "utf8"), "once\n");
  assert.equal(existsSync(source), false);
});

test("publication receipt survives a target reset without duplicate publication", async () => {
  const root = repo();
  const before = runGit(root, "rev-parse", "HEAD");
  const hooks: IsolationTestHooks = {
    afterPublish: async () => { throw new Error("crash after atomic publication"); },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(source.worktreePath, "published.txt"), "published\n");
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.finalized, false);
  assert.equal(result.session.isolation?.state, "publishing");
  const commit = result.commit;
  assert.equal(runGit(root, "rev-parse", `refs/polyth/isolation/${created.id}`), commit);

  runGit(root, "reset", "--hard", before);
  await assert.rejects(() => isolation.recover(created.id), /checkout|branch|changed/i);
  assert.equal(runGit(root, "rev-parse", "HEAD"), before);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "publishing");

  runGit(root, "reset", "--hard", commit);
  const recovered = await isolation.recover(created.id);
  assert.equal(recovered.isolation, undefined);
  assert.equal(recovered.id, created.id);
  assert.equal(runGit(root, "rev-parse", "HEAD"), commit);
});

test("startup recovery repairs merge-ready from durable turn events", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "ready-after-restart.txt"), "ready\n");
  sessions.events.push(completedTurn(created.id));
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "active");
  await isolation.recoverAll();
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "merge-ready");
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

test("return leaves an unchanged isolation and refuses one holding work", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const isoPath = (await sessions.snapshot(created.id)).isolation!.worktreePath;

  // An uncommitted file and a commit both count as work to integrate.
  writeFileSync(join(isoPath, "draft.txt"), "keep me\n");
  await assert.rejects(() => isolation.returnUnchanged(created.id), /has changes/);
  runGit(isoPath, "add", "draft.txt");
  runGit(isoPath, "commit", "-m", "draft");
  await assert.rejects(() => isolation.returnUnchanged(created.id), /has changes/);
  assert.equal(existsSync(join(isoPath, "draft.txt")), true);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "active");

  const clean = await isolation.createIsolatedSession({ projectId: "p1" });
  const cleanPath = (await sessions.snapshot(clean.id)).isolation!.worktreePath;
  const returned = await isolation.returnUnchanged(clean.id);
  assert.equal(returned.isolation, undefined);
  await assertBoundTo(returned, root, root, "main");
  assert.equal(existsSync(cleanPath), false);
  const notice = sessions.events.filter((event) => event.type === "isolation/discarded").at(-1);
  assert.equal(notice?.data.returned, true);
});

test("explicit session deletion removes the complete owned isolation workspace", async () => {
  const root = repo();
  const { isolation, sessions, closeCalls } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const current = await sessions.snapshot(created.id);
  const worktreePath = current.isolation!.worktreePath;
  const worktreeBranch = current.isolation!.worktreeBranch;
  mkdirSync(join(worktreePath, "nested"), { recursive: true });
  writeFileSync(join(worktreePath, "nested", "delete-me.txt"), "gone\n");
  let releases = 0;

  await isolation.cleanupForSessionDelete(current, async (cwd) => {
    releases += 1;
    assert.equal(resolve(cwd), resolve(worktreePath));
  });

  assert.equal(releases, 1, "owned runtime execution is released before workspace removal");
  assert.deepEqual(closeCalls.map((path) => resolve(path)), [resolve(worktreePath)]);
  assert.equal(existsSync(worktreePath), false);
  assert.equal((await git.branches(root)).branches.some((branch) => branch.name === worktreeBranch), false);
  assert.equal(existsSync(resolve(worktreePath, "..")), false, "the emptied isolate folder is removed");
  assert.ok(await sessions.snapshot(created.id), "canonical deletion remains owned by the session service");
});

test("session deletion drops the session's receipt but keeps its repair backup", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const current = await sessions.snapshot(created.id);
  const head = runGit(root, "rev-parse", "HEAD");
  runGit(root, "update-ref", `refs/polyth/isolation/${created.id}`, head);
  runGit(root, "update-ref", `refs/polyth/isolation-repair/${created.id}`, head);
  runGit(root, "update-ref", `refs/polyth/isolation/${randomUUID()}`, head);
  await isolation.cleanupForSessionDelete(current, async () => {});
  assert.equal(await git.readRef(root, `refs/polyth/isolation/${created.id}`), null);
  assert.equal(await git.readRef(root, `refs/polyth/isolation-repair/${created.id}`), head, "repair backups hold user work");
  assert.equal(runGit(root, "for-each-ref", "refs/polyth/isolation/").split("\n").length, 1, "another session's receipt is untouched");
});

test("session deletion releases owned execution even when its workspace is absent", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const current = await sessions.snapshot(created.id);
  await git.worktrees.remove(root, {
    path: current.isolation!.worktreePath,
    deleteBranch: false,
    force: true,
  });
  let releases = 0;

  await isolation.cleanupForSessionDelete(current, async (cwd) => {
    releases += 1;
    assert.equal(resolve(cwd), resolve(current.isolation!.worktreePath));
  });

  assert.equal(releases, 1, "an absent checkout does not prove execution release");
});

test("startup releases merged receipts only for known sessions without isolation", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const released = await sessions.create({ projectId: "p1" });
  const live = await isolation.createIsolatedSession({ projectId: "p1" });
  const unknownId = randomUUID();
  const head = runGit(root, "rev-parse", "HEAD");
  const dangling = runGit(root, "commit-tree", "-p", head, "-m", "unreachable", `${head}^{tree}`);
  const unreachableId = (await sessions.create({ projectId: "p1" })).id;
  for (const id of [released.id, live.id, unknownId]) runGit(root, "update-ref", `refs/polyth/isolation/${id}`, head);
  runGit(root, "update-ref", `refs/polyth/isolation/${unreachableId}`, dangling);
  mkdirSync(`${resolve(root)}-polyth-integrate`);

  await isolation.recoverAll();

  assert.equal(await git.readRef(root, `refs/polyth/isolation/${released.id}`), null);
  assert.equal(await git.readRef(root, `refs/polyth/isolation/${live.id}`), head, "a live isolation keeps its receipt");
  assert.equal(await git.readRef(root, `refs/polyth/isolation/${unknownId}`), head, "an unknown session may be another server's");
  assert.equal(await git.readRef(root, `refs/polyth/isolation/${unreachableId}`), dangling, "deletion never makes a commit unreachable");
  assert.equal(existsSync(`${resolve(root)}-polyth-integrate`), false);
  assert.equal(existsSync(`${resolve(root)}-polyth-isolate`), true, "a folder that still holds an isolate stays");
});

test("session deletion refuses an isolation path whose ownership changed", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const current = await sessions.snapshot(created.id);
  const worktreePath = current.isolation!.worktreePath;
  runGit(worktreePath, "branch", "-m", "user-preserved");
  let releases = 0;

  await assert.rejects(
    isolation.cleanupForSessionDelete(current, async () => { releases += 1; }),
    /ownership is not proven/,
  );

  assert.equal(releases, 0);
  assert.equal(existsSync(worktreePath), true, "an unowned path is never removed");
});

test("session deletion cleanup completes from the caller's locked projection without a governed re-read", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const locked = await sessions.snapshot(created.id);
  const worktreePath = locked.isolation!.worktreePath;
  // Canonical deletion has already moved the session resource to `deleting`,
  // so a governed facade read of the session now fails closed as not-found.
  // Cleanup must use the projection the deleting caller already authorized.
  sessions.snapshot = async () => {
    throw Object.assign(new Error("Resource not found"), { code: "not-found" });
  };
  let releases = 0;

  await isolation.cleanupForSessionDelete(locked, async () => { releases += 1; });

  assert.equal(releases, 1);
  assert.equal(existsSync(worktreePath), false);
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

test("cleanup failure after rebind retries cleanup without rebinding", async () => {
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
  await assertBoundTo(pending, root, root, "main");
  assert.equal(existsSync(wt), true);
  const rebinds = sessions.rebindCalls;
  hooks.beforeCleanup = undefined;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(sessions.rebindCalls, rebinds);
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
});

test("published cleanup relocates completed delegated descendants and preserves their history", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const parent = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(parent.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published.txt"), "published\n");
  const child = await sessions.create({ projectId: "p1", parentId: parent.id, worktreePath: source });
  const grandchild = await sessions.create({ projectId: "p1", parentId: child.id, worktreePath: source });
  const failed = await sessions.create({ projectId: "p1", parentId: parent.id, worktreePath: source });
  const descendantIds = [child.id, grandchild.id, failed.id];
  for (const id of descendantIds) {
    const projection = sessions.projections.get(id)!;
    projection.parentId = id === grandchild.id ? child.id : parent.id;
    projection.status = id === grandchild.id ? "finished" : id === failed.id ? "failed" : "idle";
    projection.workspace = { mode: "subset", revision: 3, executionRepositoryId: "primary", repositories: [{ repositoryId: "primary", alias: "repo", path: source, state: "ready" }] };
    projection.runtimeBinding = { authorityId: randomUUID(), generation: 1, epoch: 1, backendSessionId: id, continuity: "verified", protocol: "legacy", location: { directory: source } };
    sessions.events.push(id === failed.id
      ? { ...completedTurn(id), type: "turn/failed", data: { error: "provider plan unavailable" } }
      : completedTurn(id));
  }
  const history = [...sessions.events];
  const merged = await isolation.mergeBack(parent.id);
  assert.equal(merged.finalized, true);
  assert.equal(existsSync(source), false);
  for (const id of descendantIds) {
    const moved = await sessions.snapshot(id);
    assert.equal(moved.worktreePath, root);
    assert.equal(moved.workspace?.repositories[0]?.path, root);
    assert.equal(moved.workspace?.revision, 4);
    assert.equal(moved.runtimeBinding?.location.directory, root);
    assert.equal(moved.parentId, id === grandchild.id ? child.id : parent.id);
  }
  assert.deepEqual(sessions.events.slice(0, history.length), history);
});

test("cleanup preserves active, unrelated, foreign-Space and independently isolated dependents", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const parent = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(parent.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published.txt"), "published\n");
  // Unknown and archived children that ran hold an execution in the source;
  // only ones that never reached a native session may move (isolationRebind).
  const executed = (id: string) => ({
    backendSessionId: `be-${id}`,
    runtimeBinding: {
      canonicalSessionId: id, backendSessionId: `be-${id}`, authorityId: `authority-${id}`,
      generation: 1, continuity: "verified" as const, location: { directory: source },
    },
  });
  const cases = [
    { status: "working" as const, parentId: parent.id },
    { status: "unknown" as const, parentId: parent.id, ...executed("unknown") },
    { status: "archived" as const, parentId: parent.id, ...executed("archived") },
    { status: "idle" as const },
    { status: "idle" as const, parentId: parent.id, spaceId: "foreign-space" },
    { status: "idle" as const, parentId: parent.id, isolation: (await sessions.snapshot(parent.id)).isolation },
  ];
  const ids: string[] = [];
  for (const fields of cases) {
    const child = await sessions.create({ projectId: "p1", worktreePath: source });
    Object.assign(sessions.projections.get(child.id)!, fields);
    ids.push(child.id);
  }
  const merged = await isolation.mergeBack(parent.id);
  assert.equal(merged.finalized, false);
  assert.equal(existsSync(source), true);
  for (const id of ids) assert.equal((await sessions.snapshot(id)).worktreePath, source);
});

test("uncertain child release retains the checkout and cleanup remains pending", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const parent = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(parent.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published.txt"), "published\n");
  const child = await sessions.create({ projectId: "p1", worktreePath: source });
  sessions.projections.get(child.id)!.parentId = parent.id;
  const rebind = sessions.rebindWorkspace!;
  sessions.rebindWorkspace = async (id, input) => {
    if (id === child.id) throw Object.assign(new Error("release outcome unknown"), { code: "outcome-unknown" });
    return rebind(id, input);
  };
  const merged = await isolation.mergeBack(parent.id);
  assert.equal(merged.finalized, false);
  assert.equal(merged.session.isolation?.state, "cleanup-pending");
  assert.equal(existsSync(source), true);
  assert.equal((await sessions.snapshot(child.id)).worktreePath, source);
});

test("idle child with a durable unknown operation is preserved without retrying release", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const parent = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(parent.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published.txt"), "published\n");
  const child = await sessions.create({ projectId: "p1", worktreePath: source });
  sessions.projections.get(child.id)!.parentId = parent.id;
  sessions.debug = async () => ({ status: "idle", eventCount: 20, latestSeq: 20,
    runtime: { attached: false, activeTurn: false, admissionPending: false }, queue: [],
    pending: { questions: [], permissions: [], secrets: [] }, recentErrors: [],
    counts: { unknownOperations: 1, fencedOperations: 0, heldForReview: 0 } });
  const rebind = sessions.rebindWorkspace!;
  let childReleaseCalls = 0;
  sessions.rebindWorkspace = async (id, input) => {
    if (id === child.id) childReleaseCalls += 1;
    return rebind(id, input);
  };
  const merged = await isolation.mergeBack(parent.id);
  assert.equal(merged.finalized, false);
  assert.equal(childReleaseCalls, 0);
  assert.equal(existsSync(source), true);
  assert.equal((await sessions.snapshot(child.id)).worktreePath, source);
});

test("inspection failure does not authorize completing published cleanup", async () => {
  const root = repo();
  const managed = createManagedWorktrees(git);
  let failInspection = false;
  const { isolation, sessions } = harness(root, { managed: {
    ...managed,
    async inspectOwned(...args) {
      if (failInspection) throw new Error("Git inventory unavailable");
      return managed.inspectOwned(...args);
    },
  }, testHooks: { beforeCleanup: async () => { failInspection = true; } } });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published.txt"), "published\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, false);
  assert.equal(merged.session.isolation?.state, "cleanup-pending");
  await assert.rejects(() => isolation.recover(created.id), /Git inventory unavailable/);
  assert.equal(existsSync(source), true);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "cleanup-pending");
});

test("recovery finishes deletion interrupted before canonical cleanup persistence without republishing", async () => {
  const root = repo();
  const managed = createManagedWorktrees(git);
  let interrupted = false;
  const { isolation, sessions } = harness(root, { managed: {
    ...managed,
    async removeOwned(...args) {
      const result = await managed.removeOwned(...args);
      if (!interrupted) { interrupted = true; throw new Error("crash after deletion"); }
      return result;
    },
  } });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published.txt"), "published\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, false);
  assert.equal(merged.session.isolation?.state, "cleanup-pending");
  assert.equal(existsSync(source), false);
  const publishedHead = runGit(root, "rev-parse", "HEAD");
  const rebinds = sessions.rebindCalls;
  const recovered = await isolation.recover(created.id);
  assert.equal(recovered.isolation, undefined);
  assert.equal(sessions.rebindCalls, rebinds);
  assert.equal(runGit(root, "rev-parse", "HEAD"), publishedHead);
  assert.equal((await isolation.recover(created.id)).isolation, undefined);
});

test("discard recovery returns to the recorded origin's current branch without switching it", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!;
  sessions.failRebind = true;
  await assert.rejects(() => isolation.discard(created.id), /epoch failed/);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "rebind-pending");
  await isolation.managed.removeOwned(root, { sessionId: created.id, worktreePath: source.worktreePath, worktreeBranch: source.worktreeBranch });
  runGit(root, "checkout", "-b", "other");
  sessions.failRebind = false;
  const recovered = await isolation.recover(created.id);
  await assertBoundTo(recovered, root, root, "other");
  assert.equal(recovered.isolation, undefined);
});

test("published recovery keeps its immutable target when the origin branch changes", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published.txt"), "published\n");
  sessions.failRebind = true;
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, false);
  runGit(root, "checkout", "-b", "other");
  sessions.failRebind = false;
  const recovered = await isolation.recover(created.id);
  assert.equal(recovered.isolation?.state, "rebind-pending");
  assert.equal(recovered.worktreePath, source);
  assert.equal(existsSync(source), true);
  assert.equal(runGit(root, "branch", "--show-current"), "other");
});

test("a source write after publication is preserved and can be explicitly abandoned", async () => {
  const root = repo();
  let source = "";
  const hooks: IsolationTestHooks = {
    beforeCleanup: async () => {
      writeFileSync(join(source, "arrived-after-publish.txt"), "preserve me\n");
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published-before-late-write.txt"), "published\n");

  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.equal(merged.finalized, false);
  assert.equal(merged.session.isolation?.state, "cleanup-pending");
  assert.equal(readFileSync(join(root, "published-before-late-write.txt"), "utf8"), "published\n");
  assert.equal(existsSync(join(root, "arrived-after-publish.txt")), false);
  assert.equal(readFileSync(join(source, "arrived-after-publish.txt"), "utf8"), "preserve me\n");

  const status = await isolation.getStatus(created.id);
  assert.equal(status.actions?.canAbandon, true);
  const abandoned = await isolation.abandonCleanup(created.id);
  assert.equal(abandoned.isolation, undefined);
  assert.equal(abandoned.worktreePath, undefined);
  assert.equal(existsSync(source), true);
  assert.equal(readFileSync(join(source, "arrived-after-publish.txt"), "utf8"), "preserve me\n");
  assert.equal(await readManagedMarker(git, source), null);
  const preservedBranch = (await git.worktrees.list(root)).find((item) => resolve(item.path) === resolve(source))?.branch;
  assert.match(preservedBranch ?? "", /^polyth-preserved\//);

  sessions.projections.delete(created.id);
  await isolation.recoverAll();
  assert.equal(existsSync(source), true);
  assert.equal(readFileSync(join(source, "arrived-after-publish.txt"), "utf8"), "preserve me\n");
  assert.ok((await git.branches(root)).branches.some((item) => item.name === preservedBranch));
});

test("a file flushed while source processes close is preserved", async () => {
  const root = repo();
  let source = "";
  const { isolation, sessions } = harness(root, {
    closeWorkspaceProcesses: async (cwd) => {
      if (resolve(cwd) === resolve(source)) {
        writeFileSync(join(cwd, "flushed-during-close.txt"), "late flush\n");
      }
    },
  });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  source = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(source, "published.txt"), "published\n");

  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, false);
  assert.equal(merged.session.isolation?.state, "cleanup-pending");
  assert.equal(readFileSync(join(source, "flushed-during-close.txt"), "utf8"), "late flush\n");
  assert.equal((await isolation.getStatus(created.id)).actions?.canAbandon, true);
  assert.equal(existsSync(join(root, "flushed-during-close.txt")), false);
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
    isolation: isolationState(conflicted.isolation!, "conflict", { conflict: { message: "x", files: ["README.md"] } }),
  });
  await assert.rejects(() => isolation.resolveWithAgent(created.id), /still running/);
});

test("a recovering runtime still reports its changes but never offers merge", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "waiting.txt"), "w\n");
  for (const status of ["epoch-pending", "unknown", "reconciling"] as const) {
    sessions.projections.set(created.id, { ...await sessions.snapshot(created.id), status });
    const read = await isolation.getStatus(created.id);
    assert.equal(read.suggestion?.reason, "runtime-recovering", status);
    assert.equal(read.suggestion?.hasChanges, true, status);
    assert.equal(read.actions?.canMerge, false, status);
    assert.equal(read.actions?.canDiscard, false, status);
    assert.equal(read.actions?.canReview, true, status);
  }
  // A live turn still answers "working" without reading the workspace.
  sessions.projections.set(created.id, { ...await sessions.snapshot(created.id), status: "working" });
  const working = await isolation.getStatus(created.id);
  assert.equal(working.suggestion?.reason, "working");
  assert.equal(working.suggestion?.hasChanges, false);
});

test("resolve with agent cannot start twice while a turn is running", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const current = await sessions.snapshot(created.id);
  await sessions.patchIsolation!(created.id, isolationState(current.isolation!, "conflict", {
    conflict: { message: "conflict", files: ["README.md"] },
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

test("published cleanup can be explicitly abandoned without deleting unproven resources", async () => {
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
    isolation: isolationState(sessionA.isolation!, "cleanup-pending", {
      worktreePath: bPath,
      worktreeBranch: bBranch,
      resultCommit: runGit(root, "rev-parse", "HEAD"),
    }),
  });
  // The resource remains on disk but its owning canonical session is gone, so
  // no live session depends on it and explicit non-destructive abandonment is safe.
  sessions.projections.delete(b.id);
  const recovered = await isolation.recoverSession(await sessions.snapshot(a.id));
  assert.equal(recovered.isolation?.state, "cleanup-pending");
  const status = await isolation.getStatus(a.id);
  assert.equal(status.actions?.canAbandon, true);
  const abandoned = await isolation.abandonCleanup(a.id);
  assert.equal(abandoned.isolation, undefined);
  assert.equal(abandoned.worktreePath, undefined);
  assert.equal(abandoned.branch, "main");
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
  let integrationReady!: () => void;
  const ready = new Promise<void>((resolveReady) => { integrationReady = resolveReady; });
  let resume!: () => void;
  const hold = new Promise<void>((resolveHold) => { resume = resolveHold; });
  let integration = "";
  const hooks: IsolationTestHooks = {
    afterIntegrationCreated: async () => {
      const listed = await git.worktrees.list(root);
      integration = listed.find((item) => item.path.includes("polyth-integrate"))?.path ?? "";
      integrationReady();
      await hold;
    },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "live.txt"), "l\n");
  const merge = isolation.mergeBack(created.id);
  await ready;
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
  const hooks: IsolationTestHooks = {
    afterIntegrationCreated: async () => { await hold; },
  };
  const { isolation, sessions } = harness(root, { testHooks: hooks });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "g.txt"), "g\n");
  const merge = isolation.mergeBack(created.id);
  await new Promise((r) => setTimeout(r, 40));
  const persists = sessions.persistCalls;
  const rebinds = sessions.rebindCalls;
  const beforeHead = runGit(root, "rev-parse", "HEAD");
  const status = await isolation.getStatus(created.id);
  assert.equal(status.isolation?.state, "active");
  assert.equal(sessions.persistCalls, persists);
  assert.equal(sessions.rebindCalls, rebinds);
  assert.equal(runGit(root, "rev-parse", "HEAD"), beforeHead);
  resume();
  const merged = await merge;
  assert.equal(merged.ok, true);
});

test("push commits the isolated workspace and publishes its branch to the remote", async () => {
  const root = repo();
  const remoteDir = mkdtempSync(join(tmpdir(), "polyth-remote-"));
  dirs.push(remoteDir);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remoteDir], { stdio: "pipe" });
  runGit(root, "remote", "add", "origin", remoteDir);

  const { isolation, sessions } = harness(root);
  await sessions.create({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", projectId: "p1" });
  const created = await isolation.createIsolatedSession({
    projectId: "p1",
    title: "Push me",
    sourceSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  const session = await sessions.snapshot(created.id);
  const worktree = session.isolation!.worktreePath;
  writeFileSync(join(worktree, "feature.txt"), "work\n");

  const result = await isolation.push(created.id, { branch: "feature/push-test", message: "Add feature" });
  assert.equal(result.ok, true);
  assert.equal(result.branch, "feature/push-test");
  assert.equal(result.remote, "origin");
  assert.equal(runGit(remoteDir, "rev-parse", "refs/heads/feature/push-test"), result.commit);
  assert.ok(runGit(remoteDir, "ls-tree", "--name-only", "-r", result.commit).split("\n").includes("feature.txt"));
  assert.equal(runGit(worktree, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/push-test");
  // Pushing is non-destructive: the isolation and its workspace stay intact.
  const after = await sessions.snapshot(created.id);
  assert.ok(after.isolation);
  assert.equal(after.isolation!.state, "active");
  assert.equal(resolve(after.worktreePath!), resolve(worktree));
});

test("push refuses the target branch and unchanged workspaces", async () => {
  const root = repo();
  const remoteDir = mkdtempSync(join(tmpdir(), "polyth-remote-"));
  dirs.push(remoteDir);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remoteDir], { stdio: "pipe" });
  runGit(root, "remote", "add", "origin", remoteDir);

  const { isolation, sessions } = harness(root);
  await sessions.create({ id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", projectId: "p1" });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  await assert.rejects(
    () => isolation.push(created.id, { branch: "main" }),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
  await assert.rejects(
    () => isolation.push(created.id, { branch: "feature/empty" }),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
  assert.equal(runGit(remoteDir, "for-each-ref", "--format=%(refname)"), "");
});


test("integration commits the generated message from the staged squash diff", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root, {
    generateCommitMessage: async (session, path) => {
      assert.equal(session.title, "Unrelated session title");
      assert.match((await git.diff(path, { staged: true })).diff, /export const feature = true/);
      return "Add feature flag";
    },
  });
  const created = await isolation.createIsolatedSession({ projectId: "p1", title: "Unrelated session title" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "feature.ts"), "export const feature = true;\n");
  await isolation.mergeBack(created.id);
  assert.equal(runGit(root, "log", "-1", "--format=%s"), "Add feature flag");
});

test("an unavailable commit-message model falls back to the session title instead of failing integration", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root, {
    generateCommitMessage: async () => { throw Object.assign(new Error("Generator unavailable"), { code: "unavailable" }); },
  });
  const created = await isolation.createIsolatedSession({ projectId: "p1", title: "Add feature flag" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "feature.ts"), "export const feature = true;\n");
  assert.equal((await isolation.mergeBack(created.id)).ok, true);
  assert.equal(runGit(root, "log", "-1", "--format=%s"), "Add feature flag");
  assert.equal(readFileSync(join(root, "feature.ts"), "utf8"), "export const feature = true;\n");
});

test("a slow commit-message model does not hold integration past its wait budget", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root, {
    commitMessageWaitMs: 20,
    generateCommitMessage: () => new Promise<string>((resolveLate) => setTimeout(() => resolveLate("Too late"), 2_000)),
  });
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "feature.ts"), "export const feature = true;\n");
  const started = Date.now();
  assert.equal((await isolation.mergeBack(created.id)).ok, true);
  assert.ok(Date.now() - started < 1_500, "integration waited for the slow generator");
  assert.equal(runGit(root, "log", "-1", "--format=%s"), "Merge isolated session into main");
});

// ---- the acting person (Spaces §14.4) -------------------------------------------

const personCtx = (userId: string, instanceOwner = false): SpaceContext =>
  ({ spaceId: "s1", spaceSlug: "s1", userId, role: "member", deployment: "local-trusted", storageDir: "/unused", instanceOwner }) as SpaceContext;

const actingFixture = (root: string, options: { serviceIdentity?: { name: string; email: string } } = {}) => {
  const data = mkdtempSync(join(tmpdir(), "polyth-iso-people-"));
  dirs.push(data);
  const people = fakePeople(data, { s1: ["alice", "bob", "carol", "owner"] });
  const profiles = createPersonGitProfiles(people);
  profiles.save("alice", { name: "Alice Actor", email: "alice@example.com" });
  profiles.save("bob", { name: "Bob Requester", email: "bob@example.com" });
  const transports: Array<{ actor: GitActor; remoteUrl: string | null }> = [];
  const actingGit = createActingGit({
    personContext: (userId) => ["alice", "bob", "carol", "owner"].includes(userId) ? personCtx(userId, userId === "owner") : null,
    systemContext: () => ({ ...personCtx("system:polyth-runtime"), instanceOwner: undefined }) as SpaceContext,
    projectSpace: async () => "s1",
    profiles,
    serviceIdentity: () => options.serviceIdentity ?? null,
    accounts: { actorTransportAuth: async ({ actor, remoteUrl }) => { transports.push({ actor, remoteUrl }); return null; } },
  });
  const h = harness(root, { actingGit });
  const actAs = (sessionId: string, userId: string | null) => {
    const current = h.sessions.projections.get(sessionId)!;
    const next = { ...current, spaceId: "s1" } as SessionProjection;
    if (userId) next.actor = { userId }; else delete next.actor;
    h.sessions.projections.set(sessionId, next);
  };
  return { ...h, actAs, transports };
};

const requester = (userId: string, ambient = false): GitActor => ({ spaceId: "s1", userId, space: personCtx(userId, ambient), origin: "person-ui", ambient });
const author = (cwd: string, rev = "HEAD") => runGit(cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>", rev);

test("merge-back is committed as the session's actor, not the checkout's identity or whoever clicked", async () => {
  const root = repo();
  const h = actingFixture(root);
  const created = await h.isolation.createIsolatedSession({ projectId: "p1" });
  h.actAs(created.id, "alice");
  writeFileSync(join(h.sessions.projections.get(created.id)!.isolation!.worktreePath, "feature.ts"), "export const n = 1;\n");
  const merged = await h.isolation.mergeBack(created.id, { requester: requester("bob") });
  assert.equal(merged.ok, true);
  assert.equal(author(root, "main"), "Alice Actor <alice@example.com>|Alice Actor <alice@example.com>");
});

test("merge-back for an actor without a Git profile is refused before anything is committed", async () => {
  const root = repo();
  const h = actingFixture(root);
  const created = await h.isolation.createIsolatedSession({ projectId: "p1" });
  h.actAs(created.id, "carol");
  const wt = h.sessions.projections.get(created.id)!.isolation!.worktreePath;
  writeFileSync(join(wt, "feature.ts"), "export const n = 1;\n");
  const head = runGit(root, "rev-parse", "main");
  const refs = runGit(root, "for-each-ref");
  await assert.rejects(h.isolation.mergeBack(created.id, { requester: requester("bob") }), {
    code: "git-identity-required", mutationOutcome: "not-started",
  });
  assert.equal(runGit(root, "rev-parse", "main"), head);
  assert.equal(runGit(root, "for-each-ref"), refs, "no snapshot, receipt or integration ref was written");
  assert.equal(h.sessions.projections.get(created.id)!.isolation!.state, "active");
  assert.ok(existsSync(join(wt, "feature.ts")));
});

test("system merges use the Space's service identity, else the checkout's own", async () => {
  const root = repo();
  const service = actingFixture(root, { serviceIdentity: { name: "Space Bot", email: "bot@example.com" } });
  const a = await service.isolation.createIsolatedSession({ projectId: "p1" });
  service.actAs(a.id, null);
  writeFileSync(join(service.sessions.projections.get(a.id)!.isolation!.worktreePath, "a.ts"), "a\n");
  await service.isolation.mergeBack(a.id);
  assert.equal(author(root, "main"), "Space Bot <bot@example.com>|Space Bot <bot@example.com>");

  const plainRoot = repo();
  const plain = actingFixture(plainRoot);
  const b = await plain.isolation.createIsolatedSession({ projectId: "p1" });
  plain.actAs(b.id, null);
  writeFileSync(join(plain.sessions.projections.get(b.id)!.isolation!.worktreePath, "b.ts"), "b\n");
  await plain.isolation.mergeBack(b.id);
  assert.equal(author(plainRoot, "main"), "Test <t@example.com>|Test <t@example.com>");
});

test("isolation push commits as the actor and authenticates as the person who asked", async () => {
  const root = repo();
  const bare = mkdtempSync(join(tmpdir(), "polyth-iso-remote-"));
  dirs.push(bare);
  runGit(bare, "init", "-q", "--bare");
  runGit(root, "remote", "add", "origin", bare);
  const h = actingFixture(root);
  const created = await h.isolation.createIsolatedSession({ projectId: "p1" });
  h.actAs(created.id, "alice");
  const wt = h.sessions.projections.get(created.id)!.isolation!.worktreePath;
  writeFileSync(join(wt, "feature.ts"), "export const n = 1;\n");
  const pushed = await h.isolation.push(created.id, { requester: requester("bob"), branch: "feature/pushed" });
  assert.equal(pushed.ok, true);
  assert.equal(author(bare, "feature/pushed"), "Alice Actor <alice@example.com>|Alice Actor <alice@example.com>");
  assert.equal(h.transports.length, 1);
  assert.equal(h.transports[0]!.actor.userId, "bob", "the asking person's credentials, never the actor's");
  assert.equal(h.transports[0]!.remoteUrl, bare);

  // Without a requester the actor's own account is used, as agent work.
  writeFileSync(join(wt, "more.ts"), "more\n");
  await h.isolation.push(created.id, { branch: "feature/pushed" });
  assert.equal(h.transports[1]!.actor.userId, "alice");
  assert.equal(h.transports[1]!.actor.origin, "agent");
});

test("merge with push publishes the target branch to its upstream as the person who asked", async () => {
  const root = repo();
  const bare = mkdtempSync(join(tmpdir(), "polyth-iso-landing-"));
  dirs.push(bare);
  runGit(bare, "init", "-q", "--bare");
  runGit(root, "remote", "add", "origin", bare);
  runGit(root, "push", "-q", "-u", "origin", "main");
  const h = actingFixture(root);
  const created = await h.isolation.createIsolatedSession({ projectId: "p1" });
  h.actAs(created.id, "alice");
  writeFileSync(join(h.sessions.projections.get(created.id)!.isolation!.worktreePath, "landed.ts"), "export const n = 1;\n");

  const merged = await h.isolation.mergeBack(created.id, { requester: requester("bob"), push: true });
  assert.equal(merged.finalized, true);
  assert.deepEqual(merged.pushed, { ok: true, remote: "origin", branch: "main" });
  assert.equal(runGit(bare, "rev-parse", "main"), merged.commit);
  assert.equal(h.transports.at(-1)?.actor.userId, "bob", "the asking person's credentials push the target");
  assert.equal(h.transports.at(-1)?.remoteUrl, bare);
});

test("a refused push after a merge is reported and the merge stays", async () => {
  const root = repo();
  const missing = join(mkdtempSync(join(tmpdir(), "polyth-iso-gone-")), "no-such-remote");
  dirs.push(dirname(missing));
  runGit(root, "remote", "add", "origin", missing);
  const { isolation, sessions } = harness(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(created.id)).isolation!.worktreePath, "kept.ts"), "k\n");

  const merged = await isolation.mergeBack(created.id, { push: true });
  assert.equal(merged.finalized, true);
  assert.equal(runGit(root, "rev-parse", "main"), merged.commit);
  assert.ok(existsSync(join(root, "kept.ts")));
  assert.equal(merged.pushed?.ok, false);
  assert.equal(merged.pushed?.remote, "origin");
  assert.equal(merged.pushed?.branch, "main");
  assert.ok(merged.pushed && !merged.pushed.ok && merged.pushed.message.length > 0);
});

test("startup releases an archived session's record once its checkout and branch are gone", async () => {
  const root = repo();
  const { isolation, sessions } = harness(root);
  const archive = async () => {
    const created = await isolation.createIsolatedSession({ projectId: "p1" });
    const record = (await sessions.snapshot(created.id)).isolation!;
    sessions.projections.set(created.id, { ...sessions.projections.get(created.id)!, status: "archived" });
    return { id: created.id, record };
  };
  const gone = await archive();
  runGit(root, "worktree", "remove", "--force", gone.record.worktreePath);
  runGit(root, "branch", "-D", gone.record.worktreeBranch);
  const branchKept = await archive();
  writeFileSync(join(branchKept.record.worktreePath, "only-copy.txt"), "work\n");
  runGit(branchKept.record.worktreePath, "add", ".");
  runGit(branchKept.record.worktreePath, "commit", "-qm", "unmerged work");
  runGit(root, "worktree", "remove", "--force", branchKept.record.worktreePath);
  const checkoutKept = await archive();
  const publishing = await archive();
  runGit(root, "worktree", "remove", "--force", publishing.record.worktreePath);
  runGit(root, "branch", "-D", publishing.record.worktreeBranch);
  sessions.projections.set(publishing.id, {
    ...sessions.projections.get(publishing.id)!,
    isolation: isolationState(publishing.record, "publishing"),
  });

  await isolation.recoverAll();

  assert.equal((await sessions.snapshot(gone.id)).isolation, undefined);
  assert.equal((await sessions.snapshot(gone.id)).status, "archived");
  // A surviving branch with unmerged commits holds the only copy of the work.
  assert.equal((await sessions.snapshot(branchKept.id)).isolation?.state, "active");
  // A live checkout of an archived session is left untouched.
  assert.equal((await sessions.snapshot(checkoutKept.id)).isolation?.state, "active");
  assert.equal(existsSync(checkoutKept.record.worktreePath), true);
  // An in-flight publication keeps its evidence for explicit recovery.
  assert.equal((await sessions.snapshot(publishing.id)).isolation?.state, "publishing");
});
