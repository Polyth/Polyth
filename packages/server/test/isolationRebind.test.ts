import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent, SessionIsolation } from "@polyth/contracts";
import { createGitService } from "@polyth/git";
import { createIsolationService } from "../../git/src/sessionIntegration.ts";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

const git = createGitService();
const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const repo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-iso-srv-"));
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

const endpoint = (cwd: string, authorityId = "owned:iso-test", generation = 1): RuntimeEndpoint => ({
  authorityId,
  continuity: "verified",
  generation,
  url: "http://127.0.0.1:9",
  location: { directory: cwd },
  control: { kind: "owned", instanceToken: "iso" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

interface FakeControl {
  failRelease: boolean;
  failEpoch: boolean;
  endpointAuthority?: string;
  endpointGeneration?: number;
  acceptReleasedAuthority?: boolean;
}

function fakeRuntime(
  control: FakeControl,
  released: string[],
  cwd: () => string,
) {
  const listeners = new Set<Emit>();
  const resets: string[] = [];
  const ensureCalls: string[] = [];
  const attached = new Set<string>();
  let lastCreateOperationId: string | undefined;
  let lastResetOperationId: string | undefined;
  const rt: AgentRuntime & { resetSession?: AgentRuntime["resetSession"] } = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => {
      const backendSessionId = c.backendSessionId ?? `be_${c.sessionId}`;
      ensureCalls.push(backendSessionId);
      attached.add(backendSessionId);
      return backendSessionId;
    },
    createSessionOperation: async (c, operationId) => {
      const backendSessionId = c.backendSessionId ?? `be_${c.sessionId}`;
      ensureCalls.push(backendSessionId);
      attached.add(backendSessionId);
      lastCreateOperationId = operationId;
      return { kind: "confirmed", value: { backendSessionId }, receipt: backendSessionId };
    },
    releaseExecution: async (binding, operationId) => {
      released.push(binding.location.directory);
      if (!attached.has(binding.backendSessionId)) {
        return { kind: "rejected", code: "not-attached", message: "exact backend session is not attached" };
      }
      if (binding.authorityId !== (control.endpointAuthority ?? "owned:iso-test")
        && !control.acceptReleasedAuthority) {
        return { kind: "rejected", code: "authority-mismatch", message: "prior authority receipt is unavailable" };
      }
      if (control.failRelease) return { kind: "unknown", operationId, message: "release failed" };
      return {
        kind: "confirmed",
        value: {
          authorityId: binding.authorityId,
          generation: binding.generation,
          backendSessionId: binding.backendSessionId,
        },
      };
    },
    endpoint: async () => endpoint(
      cwd(),
      control.endpointAuthority ?? "owned:iso-test",
      control.endpointGeneration ?? 1,
    ),
    resetSessionOperation: async (_request, operationId) => {
      resets.push(operationId);
      if (control.failEpoch) return { kind: "rejected", code: "injected", message: "epoch failed" };
      lastResetOperationId = operationId;
      return {
          kind: "confirmed",
          value: { backendSessionId: `be_${operationId}` },
          receipt: `be_${operationId}`,
        };
    },
    protocol: async () => "legacy",
    reconcile: async (binding) => ({
      ...endpoint(
        cwd(),
        control.endpointAuthority ?? "owned:iso-test",
        control.endpointGeneration ?? 1,
      ),
      backendSessionId: binding.backendSessionId,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: {
        value: "idle",
        comparison: { domain: "fake-runtime", order: 1 },
        ...((lastResetOperationId ?? lastCreateOperationId)
          ? { causalOperationId: lastResetOperationId ?? lastCreateOperationId }
          : {}),
      },
      completeness: { events: "complete", permissions: "complete", questions: "complete" },
      permissions: [],
      questions: [],
      events: [],
      ...(lastResetOperationId ? {
        acceptedOperations: [{
          operationId: lastResetOperationId,
          mutationKind: "session-reset",
          receipt: `be_${lastResetOperationId}`,
        }],
      } : {}),
    }),
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, resets, ensureCalls };
}

const make = (root: string) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-iso-db-"));
  dirs.push(dir);
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: root, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const cwds: string[] = [];
  const released: string[] = [];
  const closed: string[] = [];
  const ctrl: FakeControl & { failClose: boolean; failCreate: string | false } = {
    failClose: false,
    failRelease: false,
    failCreate: false as string | false,
    failEpoch: false,
  };
  const fake = fakeRuntime(ctrl, released, () => cwds.at(-1) ?? root);
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: {
      forProject: async (_projectId, cwd) => {
        if (cwd) cwds.push(cwd);
        if (ctrl.failCreate && cwd && resolve(cwd) === resolve(ctrl.failCreate)) {
          throw new Error("runtime create failed");
        }
        return fake.rt;
      },
    },
  });
  const isolation = createIsolationService({
    git,
    sessions,
    projects,
    append: async () => undefined,
    closeWorkspaceProcesses: async (cwd) => {
      closed.push(cwd);
      if (ctrl.failClose) throw new Error("close failed");
    },
  });
  return { sessions, isolation, cwds, released, closed, ctrl, fake, project, store, projects, permissions, broadcast };
};

test("canonical isolation creation does not duplicate Git managed-branch naming", async () => {
  const root = repo();
  const { sessions } = make(root);
  const worktreePath = mkdtempSync(join(tmpdir(), "polyth-iso-contract-"));
  dirs.push(worktreePath);
  rmSync(worktreePath, { recursive: true, force: true });
  const branch = "polyth/isolate/git-owned-contract";
  await git.worktrees.create(root, { branch, path: worktreePath, base: "HEAD", newBranchOnly: true });

  await assert.rejects(
    () => sessions.create({ projectId: "p1", worktreePath }),
    /Managed isolation workspaces belong to their canonical session/,
  );

  const id = "11111111-1111-4111-8111-111111111111";
  const isolation: SessionIsolation = {
    kind: "git-worktree",
    state: "active",
    createdAt: new Date().toISOString(),
    worktreePath,
    worktreeBranch: branch,
    targetPath: resolve(root),
    targetBranch: "main",
    originPath: resolve(root),
    baseCommit: runGit(root, "rev-parse", "HEAD"),
  };
  const created = await sessions.create({
    id,
    projectId: "p1",
    worktreePath,
    isolation,
  });
  assert.equal(created.id, id);
  assert.equal((await sessions.snapshot(id)).isolation?.worktreeBranch, branch);
});

test("merge into project root rebinds runtime cwd to the repository", async () => {
  const root = repo();
  const { isolation, sessions, cwds } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const session = await sessions.snapshot(created.id);
  writeFileSync(join(session.isolation!.worktreePath, "root.txt"), "r\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.ok, true);
  assert.equal(merged.finalized, true);
  const after = await sessions.snapshot(created.id);
  assert.equal(after.id, created.id);
  assert.equal(after.worktreePath, undefined);
  assert.equal(after.branch, "main");
  assert.equal(after.isolation, undefined);
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(readFileSync(join(root, "root.txt"), "utf8"), "r\n");
  assert.equal(resolve(cwds.at(-1)!), resolve(root));
});

test("merge into another worktree rebinds runtime cwd to that checkout", async () => {
  const root = repo();
  runGit(root, "branch", "feature");
  const featureWt = mkdtempSync(join(tmpdir(), "polyth-iso-feat-"));
  dirs.push(featureWt);
  rmSync(featureWt, { recursive: true, force: true });
  await git.worktrees.create(root, { branch: "feature", path: featureWt });
  const { isolation, sessions, cwds } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1", targetBranch: "feature" });
  const isolated = await sessions.snapshot(created.id);
  writeFileSync(join(isolated.isolation!.worktreePath, "feat.txt"), "f\n");
  const merged = await isolation.mergeBack(created.id);
  assert.equal(merged.finalized, true);
  const after = await sessions.snapshot(created.id);
  assert.equal(after.worktreePath, resolve(featureWt));
  assert.equal(after.branch, "feature");
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(runGit(featureWt, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
  assert.equal(readFileSync(join(featureWt, "feat.txt"), "utf8"), "f\n");
  assert.equal(existsSync(isolated.isolation!.worktreePath), false);
  assert.equal(resolve(cwds.at(-1)!), resolve(featureWt));
});

test("retry after a completed destination epoch does not reset that epoch twice", async () => {
  const root = repo();
  const { isolation, sessions, fake } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const initial = await sessions.snapshot(created.id);
  const identity = initial.isolation!;
  const pending = {
    ...identity,
    state: "rebind-pending",
    resultCommit: runGit(root, "rev-parse", "HEAD"),
  } as SessionIsolation;
  const atDestination = await sessions.rebindWorkspace!(created.id, {
    worktreePath: null,
    branch: "main",
    isolation: pending,
  });
  const resetCount = fake.resets.length;
  assert.equal(atDestination.isolation?.state, "rebind-pending");
  await sessions.rebindWorkspace!(created.id, {
    worktreePath: null,
    branch: "main",
    isolation: { ...pending, state: "cleanup-pending" },
  });
  assert.equal(fake.resets.length, resetCount);
});

test("restart reattaches the exact persisted backend session before releasing it", async () => {
  const root = repo();
  const initial = make(root);
  const created = await initial.isolation.createIsolatedSession({ projectId: "p1" });
  const beforeRestart = await initial.sessions.snapshot(created.id);
  const source = beforeRestart.isolation!.worktreePath;
  writeFileSync(join(source, "restart.txt"), "r\n");

  const restartedCwds: string[] = [];
  const restartedReleases: string[] = [];
  const restartedControl: FakeControl = {
    failRelease: false,
    failEpoch: false,
    endpointAuthority: "owned:after-restart",
    endpointGeneration: 2,
    acceptReleasedAuthority: true,
  };
  const restartedRuntime = fakeRuntime(restartedControl, restartedReleases, () => restartedCwds.at(-1) ?? root);
  const restartedSessions = createSessionService({
    store: initial.store,
    projects: initial.projects,
    permissions: initial.permissions,
    broadcast: initial.broadcast,
    queue: initial.store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: {
      forProject: async (_projectId, cwd) => {
        if (cwd) restartedCwds.push(cwd);
        return restartedRuntime.rt;
      },
    },
  });
  const restartedIsolation = createIsolationService({
    git,
    sessions: restartedSessions,
    projects: initial.projects,
    append: async () => undefined,
    closeWorkspaceProcesses: async () => undefined,
  });

  const merged = await restartedIsolation.mergeBack(created.id);
  assert.equal(merged.finalized, true);
  assert.equal(restartedRuntime.ensureCalls[0], beforeRestart.backendSessionId);
  assert.deepEqual(restartedReleases.map((path) => resolve(path)), [resolve(source)]);
  assert.equal(readFileSync(join(root, "restart.txt"), "utf8"), "r\n");
  assert.equal(existsSync(source), false);
});

test("restart can discard a vanished workspace through durable authority release", async () => {
  const root = repo();
  const initial = make(root);
  const created = await initial.isolation.createIsolatedSession({ projectId: "p1" });
  const beforeRestart = await initial.sessions.snapshot(created.id);
  const source = beforeRestart.isolation!.worktreePath;
  rmSync(source, { recursive: true, force: true });

  const targetCwds: string[] = [];
  const authorityReleases: string[] = [];
  const targetRuntime = fakeRuntime(initial.ctrl, [], () => targetCwds.at(-1) ?? root);
  const restartedSessions = createSessionService({
    store: initial.store,
    projects: initial.projects,
    permissions: initial.permissions,
    broadcast: initial.broadcast,
    queue: initial.store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: {
      forProject: async (_projectId, cwd) => {
        if (cwd && !existsSync(cwd)) throw new Error("runtime cwd is missing");
        if (cwd) targetCwds.push(cwd);
        return targetRuntime.rt;
      },
      releaseSessionExecution: async (_projection, binding) => {
        authorityReleases.push(binding.location.directory);
        return {
          kind: "confirmed",
          value: {
            authorityId: binding.authorityId,
            generation: binding.generation,
            backendSessionId: binding.backendSessionId!,
          },
        };
      },
    },
  });
  const restartedIsolation = createIsolationService({
    git,
    sessions: restartedSessions,
    projects: initial.projects,
    append: async () => undefined,
    closeWorkspaceProcesses: async () => undefined,
  });

  const discarded = await restartedIsolation.discard(created.id);
  assert.equal(discarded.isolation, undefined);
  assert.equal(discarded.worktreePath, undefined);
  assert.deepEqual(authorityReleases.map((path) => resolve(path)), [resolve(source)]);
  assert.equal(targetCwds.some((path) => resolve(path) === resolve(source)), false);
  assert.equal(existsSync(source), false);
  assert.ok((await git.branches(root)).branches.some((item) => item.name === beforeRestart.isolation!.worktreeBranch));
});

test("live isolated discard uses durable authority release instead of the reconnecting source transport", async () => {
  const root = repo();
  const initial = make(root);
  const created = await initial.isolation.createIsolatedSession({ projectId: "p1" });
  const before = await initial.sessions.snapshot(created.id);
  const source = before.isolation!.worktreePath;
  writeFileSync(join(source, "discard-me.txt"), "discard\n");

  const cwds: string[] = [];
  const liveTransportReleases: string[] = [];
  const live = fakeRuntime(initial.ctrl, liveTransportReleases, () => cwds.at(-1) ?? root);
  let authorityReleaseCalls = 0;
  const sessions = createSessionService({
    store: initial.store,
    projects: initial.projects,
    permissions: initial.permissions,
    broadcast: initial.broadcast,
    queue: initial.store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: {
      forProject: async (_projectId, cwd) => {
        if (cwd) cwds.push(cwd);
        return live.rt;
      },
      releaseSessionExecution: async (_projection, binding) => {
        authorityReleaseCalls += 1;
        return {
          kind: "confirmed",
          value: {
            authorityId: binding.authorityId,
            generation: binding.generation,
            backendSessionId: binding.backendSessionId!,
          },
        };
      },
    },
  });
  await sessions.events(created.id, 0);
  live.rt.releaseExecution = async () => {
    throw new Error("fetch failed: OpenCode is reconnecting");
  };
  const isolation = createIsolationService({
    git,
    sessions,
    projects: initial.projects,
    append: async () => undefined,
    closeWorkspaceProcesses: async () => undefined,
  });

  const discarded = await isolation.discard(created.id);
  assert.equal(authorityReleaseCalls, 1);
  assert.deepEqual(liveTransportReleases, []);
  assert.equal(discarded.isolation, undefined);
  assert.equal(discarded.worktreePath, undefined);
  assert.equal(existsSync(source), false);
});

test("ordinary rebind never authority-fences another session on a shared runtime", async () => {
  const root = repo();
  const initial = make(root);
  const a = await initial.sessions.create({ projectId: "p1", title: "A" });
  const b = await initial.sessions.create({ projectId: "p1", title: "B" });
  const destination = mkdtempSync(join(tmpdir(), "polyth-shared-dest-"));
  dirs.push(destination);

  const cwds: string[] = [];
  const shared = fakeRuntime(initial.ctrl, [], () => cwds.at(-1) ?? root);
  let authorityReleaseCalls = 0;
  const restarted = createSessionService({
    store: initial.store,
    projects: initial.projects,
    permissions: initial.permissions,
    broadcast: initial.broadcast,
    queue: initial.store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: {
      forProject: async (_projectId, cwd) => {
        if (cwd) cwds.push(cwd);
        return shared.rt;
      },
      releaseSessionExecution: async () => {
        authorityReleaseCalls += 1;
        throw new Error("shared authority must not be fenced");
      },
    },
  });
  await restarted.send(b.id, { text: "keep B wired" });
  const rebound = await restarted.rebindWorkspace!(a.id, {
    worktreePath: destination,
    branch: "other",
  });

  assert.equal(authorityReleaseCalls, 0);
  assert.equal(resolve(rebound.worktreePath!), resolve(destination));
  assert.equal((await restarted.snapshot(b.id)).backendSessionId, (await initial.sessions.snapshot(b.id)).backendSessionId);
  await restarted.send(b.id, { text: "B still uses the shared facade" });
});

test("legacy source dependents block authority fencing and worktree deletion", async () => {
  const root = repo();
  const initial = make(root);
  const a = await initial.isolation.createIsolatedSession({ projectId: "p1", title: "isolated A" });
  const isolatedA = await initial.sessions.snapshot(a.id);
  const source = isolatedA.isolation!.worktreePath;
  writeFileSync(join(source, "from-a.txt"), "a\n");
  const b = await initial.sessions.create({ projectId: "p1", title: "legacy B" });
  const ordinaryB = await initial.sessions.snapshot(b.id);
  await initial.store.upsertProjection({
    ...ordinaryB,
    worktreePath: source,
    worktreeId: source,
    worktreeState: "ready",
    branch: isolatedA.isolation!.worktreeBranch,
    runtimeBinding: ordinaryB.runtimeBinding
      ? { ...ordinaryB.runtimeBinding, location: { directory: source } }
      : undefined,
  });

  const cwds: string[] = [];
  const shared = fakeRuntime(initial.ctrl, [], () => cwds.at(-1) ?? root);
  let authorityReleaseCalls = 0;
  const restarted = createSessionService({
    store: initial.store,
    projects: initial.projects,
    permissions: initial.permissions,
    broadcast: initial.broadcast,
    queue: initial.store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: {
      forProject: async (_projectId, cwd) => {
        if (cwd) cwds.push(cwd);
        return shared.rt;
      },
      releaseSessionExecution: async () => {
        authorityReleaseCalls += 1;
        throw new Error("legacy dependent makes authority release unsafe");
      },
    },
  });
  const restartedIsolation = createIsolationService({
    git,
    sessions: restarted,
    projects: initial.projects,
    append: async () => undefined,
    closeWorkspaceProcesses: async () => undefined,
  });

  const merged = await restartedIsolation.mergeBack(a.id);
  assert.equal(merged.finalized, false);
  assert.equal(merged.session.isolation?.state, "cleanup-pending");
  assert.equal(authorityReleaseCalls, 0);
  assert.equal(existsSync(source), true);
  assert.equal(readFileSync(join(source, "from-a.txt"), "utf8"), "a\n");
  assert.equal((await restartedIsolation.getStatus(a.id)).actions?.canAbandon, false);
  const branchBeforeRejectedAbandon = runGit(source, "rev-parse", "--abbrev-ref", "HEAD");
  await assert.rejects(
    () => restartedIsolation.abandonCleanup(a.id),
    /another session still depends/,
  );
  assert.equal(runGit(source, "rev-parse", "--abbrev-ref", "HEAD"), branchBeforeRejectedAbandon);

  const liveB = await restarted.snapshot(b.id);
  const movedB: typeof liveB = {
    ...liveB,
    branch: "main",
    runtimeBinding: liveB.runtimeBinding
      ? { ...liveB.runtimeBinding, location: { directory: root } }
      : undefined,
  };
  delete movedB.worktreePath;
  delete movedB.worktreeId;
  delete movedB.worktreeState;
  await initial.store.upsertProjection(movedB);
  const recovered = await restartedIsolation.recoverSession(await restarted.snapshot(a.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(source), false);
});

test("ordinary create and fork cannot depend on an isolation-managed workspace", async () => {
  const root = repo();
  const { isolation, sessions } = make(root);
  const owner = await isolation.createIsolatedSession({ projectId: "p1" });
  const isolated = await sessions.snapshot(owner.id);
  await assert.rejects(
    () => sessions.create({ projectId: "p1", worktreePath: isolated.isolation!.worktreePath }),
    /canonical session|active isolation reserves this workspace/,
  );
  runGit(isolated.isolation!.worktreePath, "branch", "-m", "externally-renamed-isolation");
  await assert.rejects(
    () => sessions.create({ projectId: "p1", worktreePath: isolated.isolation!.worktreePath }),
    /canonical session|active isolation reserves this workspace/,
  );
  await assert.rejects(
    () => sessions.fork(owner.id),
    /isolated sessions cannot be forked/,
  );
  assert.equal(existsSync(isolated.isolation!.worktreePath), true);
});

test("another project's root cannot claim an active isolation workspace", async () => {
  const root = repo();
  const { isolation, sessions, projects, project } = make(root);
  const owner = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(owner.id)).isolation!.worktreePath;
  const other: Project = { ...project, id: "p2", name: "other", path: source };
  projects.get = async (id) => id === "p1" ? project : id === "p2" ? other : undefined;
  projects.list = async () => [project, other];

  await assert.rejects(
    () => sessions.create({ projectId: "p2", title: "must not share isolation" }),
    /active isolation reserves this workspace/,
  );
  assert.equal(existsSync(source), true);
});

test("real session persistence repairs legacy pre-publication merging state", async () => {
  const root = repo();
  const { isolation, sessions, store } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const current = await sessions.snapshot(created.id);
  await store.upsertProjection({
    ...current,
    isolation: {
      ...current.isolation!,
      state: "merging",
      conflict: { message: "legacy stale payload", files: [] },
    } as unknown as SessionIsolation,
  });

  const recovered = await isolation.recover(created.id);
  assert.equal(recovered.isolation?.state, "active");
  assert.equal(recovered.isolation?.publish, undefined);
  assert.equal(recovered.isolation?.conflict, undefined);
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "active");
});

test("runtime release failure keeps the isolated workspace", async () => {
  const root = repo();
  const { isolation, sessions, ctrl } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "stay.txt"), "s\n");
  ctrl.failRelease = true;
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
  const pending = await sessions.snapshot(created.id);
  assert.equal(pending.isolation?.state, "rebind-pending");
  assert.equal(pending.worktreePath, wt);
  assert.equal(existsSync(wt), true);
  ctrl.failRelease = false;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
  assert.equal(recovered.worktreePath, undefined);
  assert.equal(recovered.branch, "main");
});

test("target runtime creation failure does not mark rebound", async () => {
  const root = repo();
  const { isolation, sessions, ctrl } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "stay.txt"), "s\n");
  ctrl.failCreate = root;
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
  const pending = await sessions.snapshot(created.id);
  assert.equal(pending.isolation?.state, "rebind-pending");
  assert.equal(existsSync(wt), true);
  ctrl.failCreate = false;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
});

test("runtime epoch failure leaves source recoverable", async () => {
  const root = repo();
  const { isolation, sessions, ctrl } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "epoch.txt"), "e\n");
  ctrl.failEpoch = true;
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
  const pending = await sessions.snapshot(created.id);
  assert.equal(pending.isolation?.state, "rebind-pending");
  assert.equal(existsSync(wt), true);
  ctrl.failEpoch = false;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
  assert.equal(recovered.id, created.id);
  assert.equal(recovered.branch, "main");
});
