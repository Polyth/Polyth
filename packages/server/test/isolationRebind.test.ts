import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent, RuntimeLifecycleNotification } from "@polyth/contracts";
import { createGitService } from "@polyth/git";
import { createIsolationService } from "../../git/src/sessionIntegration.ts";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster, type RuntimePool } from "../src/sessions.ts";
import { createHarnessPool, createHarnessRegistry } from "@polyth/harness-runtime";
import { createEpochRuntime } from "./runtimeReliabilityHelpers.ts";
import { createSharedRuntimeOccupancy } from "../src/runtimeOccupancy.ts";
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

const endpoint = (cwd: string): RuntimeEndpoint => ({
  authorityId: "owned:iso-test",
  continuity: "verified",
  generation: 1,
  url: "http://127.0.0.1:9",
  location: { directory: cwd },
  control: { kind: "owned", instanceToken: "iso" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const lifecycle = new Set<(event: RuntimeLifecycleNotification) => void>();
  const rt: AgentRuntime & { resetSession?: AgentRuntime["resetSession"] } = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
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
    onLifecycle(cb) { lifecycle.add(cb); return { dispose: () => { lifecycle.delete(cb); } }; },
    dispose: async () => {},
  };
  return { rt, emitLifecycle: (event: RuntimeLifecycleNotification) => { for (const listener of lifecycle) listener(event); }, emit: (sessionId: string, event: RuntimeEvent) => { for (const listener of listeners) listener(sessionId, event); } };
}

const make = (root: string, pool?: RuntimePool) => {
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
  const ctrl = {
    failClose: false,
    failRelease: false,
    failCreate: false as string | boolean,
    failEpoch: false,
  };
  const fake = fakeRuntime();
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    worktrees: { list: (path) => git.worktrees.list(path) },
    runtimes: pool ?? {
      releaseSession: async (sessionId) => {
        released.push((await store.projection(sessionId))!.worktreePath!);
        if (ctrl.failRelease) throw new Error("release failed");
      },
      forProject: async (_projectId, cwd) => {
        if (cwd) cwds.push(cwd);
        if (ctrl.failCreate === true || (typeof ctrl.failCreate === "string" && cwd && resolve(cwd) === resolve(ctrl.failCreate))) {
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
  return { sessions, isolation, cwds, released, closed, ctrl, fake, project, store };
};

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
  assert.notEqual(pending.isolation?.rebound, true);
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
  assert.notEqual(pending.isolation?.rebound, true);
  assert.equal(existsSync(wt), true);
  ctrl.failCreate = false;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation, undefined);
  assert.equal(existsSync(wt), false);
});

test("unknown runtime epoch outcome preserves source and cannot be bypassed by losing capabilities", async () => {
  const root = repo();
  const { isolation, sessions, fake } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const wt = (await sessions.snapshot(created.id)).isolation!.worktreePath;
  writeFileSync(join(wt, "epoch.txt"), "e\n");
  fake.rt.endpoint = async () => endpoint(root);
  fake.rt.resetSession = async () => {
    throw new Error("epoch failed");
  };
  const result = await isolation.mergeBack(created.id);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
  const pending = await sessions.snapshot(created.id);
  assert.notEqual(pending.isolation?.rebound, true);
  assert.equal(existsSync(wt), true);
  fake.rt.endpoint = undefined;
  fake.rt.resetSession = undefined;
  const recovered = await isolation.recoverSession(await sessions.snapshot(created.id));
  assert.equal(recovered.isolation?.state, "rebind-pending");
  assert.equal(existsSync(wt), true);
  assert.equal(recovered.id, created.id);
});


function pooledRuntimes(shared: boolean) {
  const registry = createHarnessRegistry();
  const created: Array<ReturnType<typeof fakeRuntime> & { cwd: string; disposals: number }> = [];
  const occupancies = new Map<AgentRuntime, ReturnType<typeof createSharedRuntimeOccupancy>>();
  registry.register({
    descriptor: { id: "test-harness", name: "Test", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "test-harness", installed: true, healthy: true, authenticated: true }),
    createRuntime: async (context) => {
      const existing = shared && created.find(item => item.cwd === context.cwd && !item.disposals);
      if (existing) return existing.rt;
      const fake = { ...fakeRuntime(), cwd: context.cwd, disposals: 0 };
      fake.rt.dispose = async () => { fake.disposals++; };
      if (shared) occupancies.set(fake.rt, createSharedRuntimeOccupancy(context.cwd));
      created.push(fake);
      return fake.rt;
    },
  });
  const pool = createHarnessPool({
    registry, legacyHarnessId: "test-harness",
    context: async (projectId, cwd, sessionId) => ({ spaceId: "test", projectId, cwd: cwd!, sessionId }),
    releaseRuntime: async (runtime, dispose) => {
      const occupancy = occupancies.get(runtime)?.snapshot();
      if (occupancy && (occupancy.bindings || occupancy.executions)) return;
      await dispose();
    },
  });
  return { created, pool: {
    ...pool,
    bindSession: (sessionId: string, runtime: AgentRuntime) => occupancies.get(runtime)?.acquireBinding(sessionId),
    unbindSession: (sessionId: string, runtime: AgentRuntime) => occupancies.get(runtime)?.releaseBinding(sessionId),
  } };
}

for (const shared of [true, false]) test(`${shared ? "shared" : "per-session"} runtime release preserves canonical session and rejects old callbacks`, async () => {
  const root = repo();
  const { pool, created } = pooledRuntimes(shared);
  const { sessions, store } = make(root, pool);
  const first = await sessions.create({ projectId: "p1" });
  const second = shared ? await sessions.create({ projectId: "p1" }) : undefined;
  const source = created[0]!;
  const before = await store.events(first.id);
  const dest = mkdtempSync(join(tmpdir(), "polyth-runtime-dest-"));
  dirs.push(dest);
  await sessions.rebindWorkspace!(first.id, { worktreePath: dest, branch: "main" });
  const after = await sessions.snapshot(first.id);
  assert.equal(after.id, first.id);
  assert.equal(after.worktreePath, dest);
  assert.equal(after.runtimeBinding?.location.directory, dest);
  assert.equal(source.disposals, shared ? 0 : 1);
  assert.equal(created.at(-1)!.cwd, dest);
  source.emit(first.id, { type: "session/title-generated", title: "stale source title" } as RuntimeEvent);
  if (second) source.emit(second.id, { type: "session/title-generated", title: "remaining session works" } as RuntimeEvent);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.notEqual((await sessions.snapshot(first.id)).title, "stale source title");
  if (second) assert.equal((await sessions.snapshot(second.id)).title, "remaining session works");
  assert.deepEqual((await store.events(first.id)).slice(0, before.length), before);
  await pool.dispose();
  assert.equal(source.disposals, 1);
});

test("pending isolation blocks admission, shell execution, and canonical deletion", async () => {
  const root = repo();
  const { sessions, isolation, store } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const projection = await sessions.snapshot(created.id);
  await sessions.patchIsolation!(created.id, { ...projection.isolation!, state: "merging" });
  const before = await store.events(created.id);
  await assert.rejects(sessions.send(created.id, { text: "must not run" }), { code: "conflict" });
  await assert.rejects(sessions.runShell!(created.id, "touch forbidden"), { code: "conflict" });
  await assert.rejects(sessions.delete!(created.id), { code: "conflict" });
  assert.deepEqual(await store.events(created.id), before);
  assert.equal(existsSync(projection.isolation!.worktreePath), true);
});


test("native per-session rebind creates a fresh durable epoch and next execution uses destination", async () => {
  const root = repo();
  const registry = createHarnessRegistry();
  const instances: Array<{ cwd: string; disposed: number; submitted: string[]; runtime: AgentRuntime }> = [];
  registry.register({
    descriptor: { id: "native", name: "Native", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "native", installed: true, healthy: true, authenticated: true }),
    createRuntime: async (context) => {
      const submitted: string[] = [];
      const runtime = createEpochRuntime({ ...endpoint(context.cwd), authorityId: `owned:${context.cwd}` }, submitted, `native-${instances.length}`);
      const item = { cwd: context.cwd, disposed: 0, submitted, runtime };
      runtime.dispose = async () => { item.disposed++; };
      instances.push(item);
      return runtime;
    },
  });
  const pool = createHarnessPool({ registry, legacyHarnessId: "native", context: async (projectId, cwd, sessionId) => ({ spaceId: "test", projectId, cwd: cwd!, sessionId }) });
  const { sessions, store } = make(root, pool);
  const created = await sessions.create({ projectId: "p1" });
  const before = await sessions.snapshot(created.id);
  assert.equal(before.status, "idle");
  const dest = mkdtempSync(join(tmpdir(), "polyth-native-dest-"));
  dirs.push(dest);
  const rebound = await sessions.rebindWorkspace!(created.id, { worktreePath: dest, branch: "main" });
  assert.equal(rebound.status, "idle");
  assert.equal(rebound.runtimeBinding?.location.directory, dest);
  assert.equal(rebound.runtimeBinding?.epoch, (before.runtimeBinding?.epoch ?? 0) + 1);
  assert.notEqual(rebound.backendSessionId, before.backendSessionId);
  const repeated = await sessions.rebindWorkspace!(created.id, { worktreePath: dest, branch: "main" });
  assert.equal(repeated.backendSessionId, rebound.backendSessionId);
  assert.equal(repeated.runtimeBinding?.epoch, rebound.runtimeBinding?.epoch);
  assert.equal(instances[0]!.disposed, 1);
  assert.ok((await store.events(created.id)).some(event => event.type === "runtime/epoch-replaced"));
  await sessions.send(created.id, { text: "execute at destination" });
  assert.equal(instances[0]!.submitted.length, 0);
  assert.ok(instances[1]!.submitted.some(text => text.includes("execute at destination")));
  await pool.dispose();
  assert.equal(instances[0]!.disposed, 1);
});

test("ordinary create and fork cannot acquire another session's isolation workspace", async () => {
  const root = repo();
  const { sessions, isolation } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const isolated = await sessions.snapshot(created.id);
  await assert.rejects(sessions.create({ projectId: "p1", worktreePath: isolated.worktreePath }), { code: "conflict" });
  await assert.rejects(sessions.fork(created.id), { code: "conflict" });
  assert.equal((await sessions.list("p1")).length, 1);
});


test("callbacks queued before rebind cannot mutate even a reused facade after its wiring changes", async () => {
  const root = repo();
  const { sessions, store, fake } = make(root);
  const created = await sessions.create({ projectId: "p1" });
  const dest = mkdtempSync(join(tmpdir(), "polyth-stale-dest-"));
  dirs.push(dest);
  const read = store.projection.bind(store);
  let entered!: () => void;
  let proceed!: () => void;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  let fence = true;
  store.projection = async (sessionId) => {
    const projection = await read(sessionId);
    if (fence) { fence = false; entered(); await gate; }
    return projection;
  };
  const rebinding = sessions.rebindWorkspace!(created.id, { worktreePath: dest });
  await enteredGate;
  fake.emit(created.id, { type: "session/title-generated", title: "old queued title" });
  fake.emitLifecycle({ type: "stream-disconnected" } as RuntimeLifecycleNotification);
  proceed();
  await rebinding;
  await new Promise(resolve => setTimeout(resolve, 20));
  const projection = await sessions.snapshot(created.id);
  assert.notEqual(projection.title, "old queued title");
  assert.equal(projection.status, "idle");
  assert.equal(projection.runtimeBinding?.location.directory, dest);
});


for (const phase of ["runtime startup", "native creation outcome"]) test(`failed ${phase} preserves a durably created isolation source`, async () => {
  const root = repo();
  const { sessions, isolation, ctrl, fake } = make(root);
  if (phase === "runtime startup") ctrl.failCreate = true;
  else fake.rt.ensureSession = async () => { throw new Error("native receipt lost"); };
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const retained = await sessions.snapshot(created.id);
  assert.ok(retained);
  assert.ok(retained.isolation);
  assert.equal(retained.status, phase === "runtime startup" ? "failed" : "unknown");
  assert.equal(existsSync(retained.isolation.worktreePath), true);
  assert.ok((await git.worktrees.list(root)).some(worktree => worktree.path === retained.isolation!.worktreePath));
});


test("malformed isolation stays fenced and missing-workspace notification preserves its recovery evidence", async () => {
  const root = repo();
  const { sessions, isolation, store } = make(root);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const projection = await sessions.snapshot(created.id);
  const malformed = { ...projection.isolation!, state: "active", publish: { resultCommit: "must retain evidence" } };
  await store.upsertProjection({ ...projection, isolation: malformed as typeof projection.isolation });
  await assert.rejects(sessions.send(created.id, { text: "must not execute malformed state" }), { code: "conflict" });
  await sessions.markWorktreeMissing!("p1", projection.worktreePath!);
  const marked = await sessions.snapshot(created.id);
  assert.deepEqual(marked.isolation, malformed);
  await assert.rejects(sessions.patchIsolation!(created.id, null), { code: "conflict" });
  await assert.rejects(sessions.runShell!(created.id, "must-not-run"), { code: "conflict" });
});


for (const interruption of ["none", "before-native-call", "before-native-call-generation-change", "after-native-receipt"]) test(`discard retries rejected initial creation at destination (${interruption})`, async () => {
  const root = repo();
  const registry = createHarnessRegistry();
  let unavailable = true;
  const submissions: string[] = [];
  const native = createEpochRuntime({ ...endpoint(root), authorityId: "owned:restored" }, submissions, "restored-native");
  let nativeCreates = 0;
  native.createSessionOperation = async () => {
    nativeCreates++;
    return { kind: "confirmed", value: { backendSessionId: "restored-native" }, receipt: "restored-native" };
  };
  registry.register({
    descriptor: { id: "native", name: "Native", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "native", installed: true, healthy: true, authenticated: true }),
    createRuntime: async () => { if (unavailable) throw new Error("runtime not installed yet"); return native; },
  });
  const pool = createHarnessPool({ registry, legacyHarnessId: "native", context: async (projectId, cwd, sessionId) => ({ spaceId: "test", projectId, cwd: cwd!, sessionId }) });
  const { sessions, isolation, store } = make(root, pool);
  const created = await isolation.createIsolatedSession({ projectId: "p1" });
  const failed = await sessions.snapshot(created.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.backendSessionId, undefined);
  const source = failed.worktreePath!;
  const initialEvents = await store.events(created.id);
  unavailable = false;
  const claim = store.claimOperation.bind(store);
  const patch = store.patchProjection.bind(store);
  let interrupted = false;
  store.claimOperation = async (operationId) => {
    if (interruption.startsWith("before-native-call") && !interrupted) { interrupted = true; throw new Error("interrupted before native create"); }
    return claim(operationId);
  };
  store.patchProjection = (sessionId, apply) => patch(sessionId, current => {
    const projection = apply(current);
    if (interruption === "after-native-receipt" && projection.backendSessionId === "restored-native" && !interrupted) {
      interrupted = true; throw new Error("interrupted before binding publication");
    }
    return projection;
  });
  let discarded = await isolation.discard(created.id);
  if (interruption !== "none") {
    assert.equal(interrupted, true);
    assert.equal(discarded.isolation?.state, "rebind-pending");
    assert.equal(existsSync(source), true);
    if (interruption === "before-native-call-generation-change") {
      native.endpoint = async () => ({ ...endpoint(root), authorityId: "owned:restored", generation: 2 });
    }
    discarded = await isolation.recoverSession(discarded);
  }
  assert.equal(nativeCreates, 1);
  assert.equal(discarded.id, created.id);
  assert.equal(discarded.isolation, undefined);
  assert.equal(discarded.status, "idle");
  assert.equal(discarded.runtimeBinding?.location.directory, root);
  assert.equal(discarded.backendSessionId, "restored-native");
  assert.equal(existsSync(source), false);
  assert.deepEqual((await store.events(created.id)).slice(0, initialEvents.length), initialEvents);
  await sessions.send(created.id, { text: "work in restored destination" });
  assert.ok(submissions.some(text => text.includes("work in restored destination")));
  await pool.dispose();
});
