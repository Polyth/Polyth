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
      if (!binding.backendSessionId || !attached.has(binding.backendSessionId)) {
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
      backendSessionId: binding.backendSessionId!,
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
      return { dispose: () => { listeners.delete(cb); } };
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
  // The navigator's merged marker outlives the released isolation record.
  assert.equal(after.isolationMerge?.targetBranch, "main");
  assert.equal(after.isolationMerge?.commit, merged.commit);
  assert.equal(runGit(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(readFileSync(join(root, "root.txt"), "utf8"), "r\n");
  assert.equal(resolve(cwds.at(-1)!), resolve(root));
});

test("discard leaves no merge receipt", async () => {
  const root = repo();
  const { isolation, sessions } = make(root);
  const discarded = await isolation.createIsolatedSession({ projectId: "p1" });
  writeFileSync(join((await sessions.snapshot(discarded.id)).isolation!.worktreePath, "x.txt"), "x\n");
  await isolation.discard(discarded.id);
  assert.equal((await sessions.snapshot(discarded.id)).isolationMerge, undefined);
});

test("a fresh isolation clears an earlier merge receipt", async () => {
  const root = repo();
  const { isolation, sessions } = make(root);
  const merged = await isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await sessions.snapshot(merged.id)).isolation!;
  writeFileSync(join(source.worktreePath, "m.txt"), "m\n");
  assert.equal((await isolation.mergeBack(merged.id)).finalized, true);
  assert.ok((await sessions.snapshot(merged.id)).isolationMerge);
  const again = await sessions.patchIsolation!(merged.id, { ...source, state: "active", createdAt: new Date().toISOString() } as SessionIsolation);
  assert.equal(again.isolationMerge, undefined);
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

test("a delegated child nests in its isolated parent's checkout and reaches main through the parent", async () => {
  const root = repo();
  const { isolation, sessions } = make(root);
  const parentRef = await isolation.createIsolatedSession({ projectId: "p1", title: "Orchestrator" });
  const parent = await sessions.snapshot(parentRef.id);
  const parentWorktree = parent.isolation!.worktreePath;

  const created = await isolation.createDelegatedSession({ parentSessionId: parent.id, title: "Worker" });
  const child = await sessions.snapshot(created.id);
  assert.equal(child.parentId, parent.id);
  assert.equal(resolve(child.worktreePath!), resolve(created.isolation.worktreePath));
  assert.equal(child.isolation?.targetBranch, parent.isolation!.worktreeBranch);
  assert.equal(child.isolation?.originPath, resolve(parentWorktree));

  writeFileSync(join(created.isolation.worktreePath, "worker.txt"), "w\n");
  await assert.rejects(() => isolation.mergeBack(parent.id), /Delegated agents still have isolated work/);

  const merged = await isolation.mergeDelegated(created.id);
  assert.equal(merged.finalized, true);
  const rebound = await sessions.snapshot(created.id);
  assert.equal(rebound.isolation, undefined);
  assert.equal(resolve(rebound.worktreePath!), resolve(parentWorktree), "the merged child returns to its parent's checkout");
  assert.equal(rebound.branch, parent.isolation!.worktreeBranch);
  assert.equal(readFileSync(join(parentWorktree, "worker.txt"), "utf8"), "w\n");
  assert.equal(existsSync(created.isolation.worktreePath), false);

  const published = await isolation.mergeBack(parent.id);
  assert.equal(published.finalized, true);
  assert.equal(runGit(root, "show", "main:worker.txt"), "w");
  assert.equal(existsSync(parentWorktree), false);
  const relocated = await sessions.snapshot(created.id);
  assert.equal(resolve(relocated.worktreePath ?? root), resolve(root), "the finished child follows its parent home");
  assert.equal(relocated.branch, "main");
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
    isolation: { ...pending, state: "cleanup-pending" } as SessionIsolation,
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
  // The branch never moved past its base: it held nothing and leaves too.
  assert.equal((await git.branches(root)).branches.some((item) => item.name === beforeRestart.isolation!.worktreeBranch), false);
});

test("workspace release publishes the destination before acquiring its session runtime", async () => {
  const root = repo();
  const initial = make(root);
  const created = await initial.isolation.createIsolatedSession({ projectId: "p1" });
  const source = (await initial.sessions.snapshot(created.id)).isolation!.worktreePath;
  const target = fakeRuntime(initial.ctrl, [], () => root);
  const acquired: string[] = [];
  const restarted = createSessionService({
    store: initial.store, projects: initial.projects, permissions: initial.permissions,
    broadcast: initial.broadcast, queue: initial.store,
    worktrees: { list: path => git.worktrees.list(path) },
    runtimes: {
      forProject: async () => target.rt,
      forSession: async (projection, cwd) => {
        const canonical = await initial.store.projection(projection.id);
        assert.equal(canonical?.worktreePath ?? root, cwd,
          "runtime setup must observe the same durable workspace as its acquisition context");
        assert.ok((await initial.store.events(projection.id)).some(event =>
          event.type === "session/workspace-execution-released"));
        assert.equal(canonical?.isolation?.state, "rebind-pending",
          "publishing the destination must not claim that epoch reset or cleanup finished");
        acquired.push(cwd);
        return target.rt;
      },
      releaseSessionExecution: async (_projection, binding) => ({
        kind: "confirmed", value: {
          authorityId: binding.authorityId, generation: binding.generation,
          backendSessionId: binding.backendSessionId!,
        },
      }),
    },
  });
  const isolation = createIsolationService({
    git, sessions: restarted, projects: initial.projects,
    append: async () => undefined, closeWorkspaceProcesses: async () => undefined,
  });
  const rebound = await isolation.discard(created.id);
  assert.equal(rebound.isolation, undefined);
  assert.ok(acquired.length > 0);
  assert.deepEqual([...new Set(acquired)], [root]);
  assert.equal(existsSync(source), false);
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

for (const boundary of ["exclusive", "sibling", "unregistered", "unrelated", "foreign-project"] as const) {
  test(`inherited isolation release respects the ${boundary} source boundary`, async () => {
    const root = repo();
    const initial = make(root);
    const owner = await initial.isolation.createIsolatedSession({ projectId: "p1" });
    const child = await initial.sessions.create({ projectId: "p1", parentId: owner.id });
    const before = await initial.sessions.snapshot(child.id);
    const owned = await initial.sessions.snapshot(owner.id);
    const source = owned.isolation!.worktreePath;
    const movedOwner = {
      ...owned,
      projectId: boundary === "foreign-project" ? "foreign" : owned.projectId,
      worktreePath: undefined,
      worktreeId: undefined,
      worktreeState: undefined,
      isolation: { ...owned.isolation!, state: "cleanup-pending" } as SessionIsolation,
      runtimeBinding: { ...owned.runtimeBinding!, location: { directory: root } },
      workspace: {
        ...owned.workspace!,
        repositories: owned.workspace!.repositories.map(row => ({ ...row, path: root })),
      },
    };
    await initial.store.upsertProjection(movedOwner);
    if (boundary === "unrelated") {
      await initial.store.upsertProjection({ ...before, parentId: undefined });
    }
    if (boundary === "sibling") {
      await initial.store.upsertProjection({ ...before, id: "remaining-sibling" });
    }

    const cwds: string[] = [];
    const target = fakeRuntime(initial.ctrl, [], () => root);
    let authorityReleaseCalls = 0;
    const restarted = createSessionService({
      store: initial.store,
      projects: initial.projects,
      permissions: initial.permissions,
      broadcast: initial.broadcast,
      queue: initial.store,
      worktrees: {
        list: async path => (await git.worktrees.list(path))
          .filter(row => boundary !== "unregistered" || resolve(row.path) !== resolve(source)),
      },
      runtimes: {
        forProject: async (_projectId, cwd) => {
          if (cwd) cwds.push(cwd);
          if (cwd && resolve(cwd) === resolve(source)) {
            throw new Error("source native plan is unavailable; do not materialize it for release");
          }
          return target.rt;
        },
        releaseSessionExecution: async (_projection, binding) => {
          authorityReleaseCalls += 1;
          assert.equal(binding.canonicalSessionId, child.id);
          assert.equal(resolve(binding.location.directory), resolve(source));
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
    if (boundary === "exclusive") {
      const rebound = await restarted.rebindWorkspace!(child.id, { worktreePath: null, branch: "main" });
      assert.equal(authorityReleaseCalls, 1);
      assert.equal(resolve(rebound.runtimeBinding!.location.directory), resolve(root));
      assert.equal(cwds.some(path => resolve(path) === resolve(source)), false);
      assert.ok((await restarted.events(child.id, 0)).some(event => event.type === "session/workspace-execution-released"));
    } else {
      await assert.rejects(() => restarted.rebindWorkspace!(child.id, { worktreePath: null, branch: "main" }));
      assert.equal(authorityReleaseCalls, 0);
      assert.equal((await restarted.snapshot(child.id)).runtimeBinding!.location.directory, source);
    }
    assert.equal(existsSync(source), true);
  });
}

test("ordinary rebind never authority-fences another session on a shared runtime", async () => {
  const root = repo();
  const initial = make(root);
  const a = await initial.sessions.create({ projectId: "p1", title: "A" });
  const b = await initial.sessions.create({ projectId: "p1", title: "B" });
  const destination = mkdtempSync(join(tmpdir(), "polyth-shared-dest-"));
  dirs.push(destination);
  rmSync(destination, { recursive: true });
  await git.worktrees.create(root, { path: destination, branch: "other", base: "HEAD", newBranchOnly: true });

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

test("child sessions with parentId inherit isolation worktree and workspace cleanly", async () => {
  const root = repo();
  const { isolation, sessions } = make(root);
  const owner = await isolation.createIsolatedSession({ projectId: "p1", title: "Isolation Owner" });
  const isolated = await sessions.snapshot(owner.id);
  assert.ok(isolated.isolation);
  assert.ok(isolated.worktreePath);

  // 1. Spawning child session with parentId inherits worktree and workspace
  const child = await sessions.create({ projectId: "p1", parentId: owner.id, title: "Worker 1" });
  const childSnapshot = await sessions.snapshot(child.id);

  assert.equal(childSnapshot.parentId, owner.id);
  assert.equal(childSnapshot.worktreePath, isolated.worktreePath);
  assert.equal(childSnapshot.branch, isolated.isolation!.worktreeBranch);
  assert.equal(childSnapshot.workspace?.executionRepositoryId, isolated.workspace?.executionRepositoryId);
  assert.equal(childSnapshot.workspace?.repositories[0]?.path, isolated.worktreePath);
  // Child does not own the isolation lifecycle
  assert.equal(childSnapshot.isolation, undefined);
  assert.equal(childSnapshot.workspace?.repositories[0]?.isolation, undefined);

  // 2. Nested child (grandchild) also inherits the isolated workspace
  const grandchild = await sessions.create({ projectId: "p1", parentId: child.id, title: "Worker 2 (nested)" });
  const grandchildSnapshot = await sessions.snapshot(grandchild.id);
  assert.equal(grandchildSnapshot.parentId, child.id);
  assert.equal(grandchildSnapshot.worktreePath, isolated.worktreePath);
  assert.equal(grandchildSnapshot.branch, isolated.isolation!.worktreeBranch);
  assert.equal(grandchildSnapshot.isolation, undefined);

  // 3. Child can be deleted cleanly without deleting the parent's isolation worktree
  await sessions.delete!(grandchild.id);
  assert.equal(existsSync(isolated.isolation!.worktreePath), true);
  await sessions.delete!(child.id);
  assert.equal(existsSync(isolated.isolation!.worktreePath), true);
});

test("children that never reached a native session move out without a runtime; executed archived ones still pin cleanup", async () => {
  const root = repo();
  const initial = make(root);
  const owner = await initial.isolation.createIsolatedSession({ projectId: "p1", title: "Owner" });
  const source = (await initial.sessions.snapshot(owner.id)).isolation!.worktreePath;
  writeFileSync(join(source, "owner.txt"), "o\n");
  const neverRan = async (title: string, status: "archived" | "unknown") => {
    const ref = await initial.sessions.create({ projectId: "p1", parentId: owner.id, title });
    const created = await initial.sessions.snapshot(ref.id);
    const failedStartup = { ...created, status };
    delete failedStartup.runtimeBinding;
    delete failedStartup.backendSessionId;
    await initial.store.upsertProjection(failedStartup);
    return ref.id;
  };
  const archivedId = await neverRan("failed startup, archived", "archived");
  const unknownId = await neverRan("failed startup, unknown create", "unknown");
  const executedRef = await initial.sessions.create({ projectId: "p1", parentId: owner.id, title: "ran, then archived" });
  await initial.sessions.send(executedRef.id, { text: "work" });
  const executed = await initial.sessions.snapshot(executedRef.id);
  assert.ok(executed.runtimeBinding, "the executed child has a native session");
  await initial.store.upsertProjection({ ...executed, status: "archived" });

  // A restarted service holds no runtime for any of them.
  const cwds: string[] = [];
  const restartedRuntime = fakeRuntime(initial.ctrl, [], () => cwds.at(-1) ?? root);
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
        return restartedRuntime.rt;
      },
      releaseSessionExecution: async () => { throw new Error("no execution may be released here"); },
    },
  });
  const restartedIsolation = createIsolationService({
    git,
    sessions: restarted,
    projects: initial.projects,
    append: async () => undefined,
    closeWorkspaceProcesses: async () => undefined,
  });

  // Plain callers still cannot rebind an archived session.
  await assert.rejects(
    () => restarted.rebindWorkspace!(archivedId, { worktreePath: null, branch: "main" }),
    /archived/,
  );
  // The trusted flag never moves a session that has an execution.
  await assert.rejects(
    () => restarted.rebindWorkspace!(executedRef.id, { worktreePath: null, branch: "main", relocateManagedCheckout: true }),
    /archived/,
  );

  const merged = await restartedIsolation.mergeBack(owner.id);
  assert.equal(merged.finalized, false, "the executed archived child still depends on the source");
  for (const id of [archivedId, unknownId]) {
    const moved = await restarted.snapshot(id);
    assert.equal(resolve(moved.worktreePath ?? root), resolve(root), `${moved.title} follows its owner home`);
    assert.equal(moved.workspace?.repositories[0]?.path && resolve(moved.workspace.repositories[0].path), resolve(root));
    assert.equal(moved.runtimeBinding, undefined);
    assert.equal(moved.status, id === archivedId ? "archived" : "unknown", "relocation does not change lifecycle");
  }
  assert.deepEqual(
    restartedRuntime.ensureCalls.filter((id) => id === `be_${archivedId}` || id === `be_${unknownId}`),
    [],
    "no runtime session was created for children that never ran",
  );
  assert.equal(resolve((await restarted.snapshot(executedRef.id)).worktreePath!), resolve(source));
  assert.equal(existsSync(source), true);
  assert.equal(runGit(root, "show", "main:owner.txt"), "o");
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
  assert.equal(pending.worktreePath, undefined, "the released session has a durable destination even if its runtime is unavailable");
  assert.equal(pending.workspace?.repositories.find(row => row.repositoryId === pending.workspace?.executionRepositoryId)?.path, root);
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


function multiRepositoryFixture() {
  const root = repo();
  const secondary = repo();
  const fixture = make(root);
  fixture.project.primaryRepositoryId = "app";
  fixture.project.repositories = [{ id: "app", alias: "App", path: root }, { id: "api", alias: "API", path: secondary }];
  return { ...fixture, root, secondary };
}

test("canonical multi-repository secondary merge preserves anchor and publishes durable workspace", async () => {
  const fixture = multiRepositoryFixture();
  const created = await fixture.isolation.createIsolatedSession({ projectId: "p1" });
  const before = await fixture.sessions.snapshot(created.id);
  const secondary = before.workspace!.repositories.find((row) => row.repositoryId === "api")!;
  writeFileSync(join(secondary.path, "secondary.txt"), "secondary change\n");
  const merged = await fixture.isolation.mergeRepository(created.id, "api");
  assert.equal(merged.finalized, true);
  const after = await fixture.sessions.snapshot(created.id);
  assert.equal(after.workspace?.executionRepositoryId, "app");
  assert.equal(after.worktreePath, before.worktreePath);
  assert.equal(after.workspace?.repositories.find((row) => row.repositoryId === "api")?.path, fixture.secondary);
  assert.equal(after.workspace?.repositories.find((row) => row.repositoryId === "api")?.isolation, undefined);
  assert.equal(readFileSync(join(fixture.secondary, "secondary.txt"), "utf8"), "secondary change\n");
  assert.equal(existsSync(secondary.path), false);
  assert.ok(fixture.released.includes(before.worktreePath!));
  assert.ok((await fixture.store.events(created.id)).some((event) => event.type === "session/workspace-updated"));
});

test("canonical multi-repository anchor merge retains secondary ownership without stale scalar isolation", async () => {
  const fixture = multiRepositoryFixture();
  const created = await fixture.isolation.createIsolatedSession({ projectId: "p1" });
  const before = await fixture.sessions.snapshot(created.id);
  writeFileSync(join(before.worktreePath!, "anchor.txt"), "anchor change\n");
  const merged = await fixture.isolation.mergeRepository(created.id, "app");
  assert.equal(merged.ok, true);
  const after = await fixture.sessions.snapshot(created.id);
  assert.equal(after.isolation, undefined);
  assert.equal(after.workspace?.repositories.find((row) => row.repositoryId === "app")?.isolation, undefined);
  assert.ok(after.workspace?.repositories.find((row) => row.repositoryId === "api")?.isolation);
  assert.equal(after.workspace?.executionRepositoryId, "app");
  assert.equal(existsSync(before.worktreePath!), false);
});

test("canonical multi-repository discard moves anchor before cleanup and rejects unproven release", async () => {
  const fixture = multiRepositoryFixture();
  const created = await fixture.isolation.createIsolatedSession({ projectId: "p1" });
  const before = await fixture.sessions.snapshot(created.id);
  fixture.ctrl.failRelease = true;
  await assert.rejects(() => fixture.isolation.discardRepository(created.id, "app"), { code: "outcome-unknown" });
  assert.equal(existsSync(before.worktreePath!), true);
  assert.deepEqual((await fixture.sessions.snapshot(created.id)).workspace, before.workspace);
  fixture.ctrl.failRelease = false;
  const after = await fixture.isolation.discardRepository(created.id, "app");
  assert.equal(after.workspace?.executionRepositoryId, "api");
  assert.equal(after.workspace?.repositories.length, 1);
  assert.equal(after.worktreePath, after.workspace?.repositories[0]?.path);
  assert.equal(existsSync(before.worktreePath!), false);
});

test("canonical isolated secondary-only subset is anchored to its owned checkout", async () => {
  const fixture = multiRepositoryFixture();
  const created = await fixture.isolation.createIsolatedSession({ projectId: "p1", repositoryIds: ["api"] });
  const session = await fixture.sessions.snapshot(created.id);
  assert.equal(session.workspace?.executionRepositoryId, "api");
  assert.deepEqual(session.workspace?.repositories.map((row) => row.repositoryId), ["api"]);
  assert.equal(session.worktreePath, session.workspace?.repositories[0]?.path);
  assert.notEqual(session.worktreePath, fixture.secondary);
});

test("an archived session drops only the record of a checkout that is gone", async () => {
  const root = repo();
  const { isolation, sessions } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const record = (await sessions.snapshot(created.id)).isolation!;
  await sessions.archive(created.id);
  // Archived sessions stay read-only for every other isolation change.
  await assert.rejects(
    () => sessions.patchIsolation!(created.id, { ...record, state: "merge-ready" } as SessionIsolation),
    /cannot change repository membership|archived/,
  );
  await isolation.recoverAll();
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "active", "a live checkout is kept");

  runGit(root, "worktree", "remove", "--force", record.worktreePath);
  runGit(root, "branch", "-D", record.worktreeBranch);
  await isolation.recoverAll();
  const after = await sessions.snapshot(created.id);
  assert.equal(after.isolation, undefined);
  assert.equal(after.workspace?.repositories.some((row) => row.isolation) ?? false, false);
  assert.equal(after.status, "archived");
  // A later restore must not execute in the deleted checkout.
  assert.equal(after.worktreePath, undefined);
  assert.deepEqual(after.workspace?.repositories.map((row) => resolve(row.path)), [resolve(root)]);
});

test("a restored session whose isolated checkout was removed by hand recovers into the target", async () => {
  // A hand merge (`git merge --ff-only` + `git worktree remove` + `git branch -d`)
  // followed by archive and restore left the record naming a deleted path:
  // every epoch start there went unknown and wedged the session.
  const root = repo();
  const initial = make(root);
  const created = await initial.isolation.createIsolatedSession({ projectId: "p1" });
  const record = (await initial.sessions.snapshot(created.id)).isolation!;
  runGit(root, "worktree", "remove", "--force", record.worktreePath);
  runGit(root, "branch", "-D", record.worktreeBranch);
  await initial.store.upsertProjection({
    ...(await initial.store.projection(created.id))!,
    status: "epoch-pending",
  });

  const targetCwds: string[] = [];
  const restartedRuntime = fakeRuntime({
    failRelease: false,
    failEpoch: false,
    endpointAuthority: "owned:after-restart",
    endpointGeneration: 2,
  }, [], () => targetCwds.at(-1) ?? root);
  const restartedSessions = createSessionService({
    store: initial.store,
    projects: initial.projects,
    permissions: initial.permissions,
    broadcast: initial.broadcast,
    queue: initial.store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: {
      forProject: async (_projectId, cwd) => {
        if (cwd) targetCwds.push(cwd);
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

  await restartedIsolation.recoverAll();
  const released = await restartedSessions.snapshot(created.id);
  assert.equal(released.isolation, undefined);
  assert.equal(released.worktreePath, undefined);
  assert.equal(released.status, "epoch-pending");
  assert.deepEqual(released.workspace?.repositories.map((row) => resolve(row.path)), [resolve(root)]);
  assert.equal(released.workspace?.repositories.some((row) => row.isolation) ?? false, false);

  await restartedSessions.activate!(created.id);
  const recovered = await restartedSessions.snapshot(created.id);
  assert.equal(recovered.status, "idle");
  assert.equal(resolve(recovered.runtimeBinding!.location.directory), resolve(root));
  assert.equal(targetCwds.some((path) => resolve(path) === resolve(record.worktreePath)), false);
});

test("a live checkout keeps an epoch-pending session's isolation record", async () => {
  const root = repo();
  const { isolation, sessions, store } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  await store.upsertProjection({ ...(await store.projection(created.id))!, status: "epoch-pending" });
  await isolation.recoverAll();
  assert.equal((await sessions.snapshot(created.id)).isolation?.state, "active");
  // Only the checkout is gone; its branch still holds the work.
  const record = (await sessions.snapshot(created.id)).isolation!;
  runGit(root, "worktree", "remove", "--force", record.worktreePath);
  await isolation.recoverAll();
  assert.equal((await sessions.snapshot(created.id)).isolation?.worktreePath, record.worktreePath);
});

/** A fresh service over the same store: what a server restart sees. */
const restarted = (initial: ReturnType<typeof make>, root: string) => {
  const runtime = fakeRuntime({
    failRelease: false,
    failEpoch: false,
    endpointAuthority: "owned:after-restart",
    endpointGeneration: 2,
  }, [], () => root);
  const sessions = createSessionService({
    store: initial.store,
    projects: initial.projects,
    permissions: initial.permissions,
    broadcast: initial.broadcast,
    queue: initial.store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: { forProject: async () => runtime.rt },
  });
  const isolation = createIsolationService({
    git,
    sessions,
    projects: initial.projects,
    append: async () => undefined,
    closeWorkspaceProcesses: async () => undefined,
  });
  return { sessions, isolation };
};

test("a hand-merged isolation deleted with rm -rf is released and its merged branch kept", async () => {
  // 2026-10-16: a hand fast-forward of the isolate branch, then the checkout
  // directory deleted without `git worktree remove`. Git still listed the
  // stale worktree entry (and the branch was kept), so startup recovery never
  // released the record; the chat stayed epoch-pending with its messages queued.
  const root = repo();
  const initial = make(root);
  const created = await initial.isolation.createIsolatedSession({ projectId: "p1" });
  const record = (await initial.sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(record.worktreePath, "work.txt"), "done\n");
  runGit(record.worktreePath, "add", ".");
  runGit(record.worktreePath, "commit", "-qm", "work");
  runGit(root, "merge", "--ff-only", "-q", record.worktreeBranch);
  rmSync(record.worktreePath, { recursive: true, force: true });
  assert.ok(runGit(root, "worktree", "list").includes(record.worktreePath), "the stale entry is still listed");
  await initial.store.upsertProjection({ ...(await initial.store.projection(created.id))!, status: "epoch-pending" });

  const after = restarted(initial, root);
  await after.isolation.recoverAll();
  const released = await after.sessions.snapshot(created.id);
  assert.equal(released.isolation, undefined);
  assert.deepEqual(released.workspace?.repositories.map((row) => resolve(row.path)), [resolve(root)]);
  assert.notEqual(runGit(root, "branch", "--list", record.worktreeBranch), "", "the merged branch is left in place");
});

test("an rm -rf checkout whose branch still holds unmerged work keeps its record", async () => {
  const root = repo();
  const initial = make(root);
  const created = await initial.isolation.createIsolatedSession({ projectId: "p1" });
  const record = (await initial.sessions.snapshot(created.id)).isolation!;
  writeFileSync(join(record.worktreePath, "work.txt"), "unmerged\n");
  runGit(record.worktreePath, "add", ".");
  runGit(record.worktreePath, "commit", "-qm", "unmerged work");
  rmSync(record.worktreePath, { recursive: true, force: true });
  await initial.store.upsertProjection({ ...(await initial.store.projection(created.id))!, status: "epoch-pending" });

  const after = restarted(initial, root);
  await after.isolation.recoverAll();
  assert.equal((await after.sessions.snapshot(created.id)).isolation?.worktreePath, record.worktreePath);
});
