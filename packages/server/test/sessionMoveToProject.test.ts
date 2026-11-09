import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent, SessionProjection } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Listener = (id: string, event: RuntimeEvent) => void | Promise<void>;

const endpoint = (cwd: string, authorityId: string): RuntimeEndpoint => ({
  authorityId,
  continuity: "verified",
  generation: 1,
  url: "http://127.0.0.1:9",
  location: { directory: cwd },
  control: { kind: "owned", instanceToken: "move" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

interface FakeWorld {
  /** Every project's runtime shares one authority, as a daemon does. */
  sharedAuthority: boolean;
  failRelease: boolean;
  noRelease: boolean;
  acquired: string[];
  released: Array<{ directory: string; backendSessionId: string }>;
  resets: Array<{ cwd: string }>;
  starts: Array<{ sessionId: string; text: string }>;
}

function fakeRuntime(world: FakeWorld, cwd: string, listeners: Set<Listener>): AgentRuntime {
  const authority = world.sharedAuthority ? "owned:daemon" : `owned:${cwd}`;
  let lastOperation: string | undefined;
  const reset = (backendSessionId: string) => ({ kind: "confirmed" as const, value: { backendSessionId }, receipt: backendSessionId });
  return {
    harnessId: "fake",
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: false }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (input) => input.backendSessionId ?? `be_${input.sessionId}`,
    createSessionOperation: async (input, operationId) => {
      lastOperation = operationId;
      return reset(input.backendSessionId ?? `be_${input.sessionId}`);
    },
    ...(world.noRelease ? {} : {
      releaseExecution: async (binding, operationId) => {
        if (world.failRelease) return { kind: "unknown" as const, operationId, message: "no receipt" };
        world.released.push({ directory: binding.location.directory, backendSessionId: binding.backendSessionId! });
        return { kind: "confirmed" as const, value: { authorityId: binding.authorityId, generation: binding.generation, backendSessionId: binding.backendSessionId! } };
      },
    } satisfies Partial<AgentRuntime>),
    endpoint: async () => endpoint(cwd, authority),
    protocol: async () => "legacy",
    resetSessionOperation: async (input, operationId) => {
      lastOperation = operationId;
      world.resets.push({ cwd: input.cwd });
      return reset(`be_${operationId}`);
    },
    reconcile: async (binding) => ({
      ...endpoint(cwd, authority),
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "idle", comparison: { domain: "fake", order: 1 }, ...(lastOperation ? { causalOperationId: lastOperation } : {}) },
      completeness: { events: "complete", permissions: "complete", questions: "complete" },
      permissions: [], questions: [], events: [],
      ...(lastOperation ? { acceptedOperations: [{ operationId: lastOperation, mutationKind: "session-reset", receipt: `be_${lastOperation}` }] } : {}),
    }),
    sessions: async () => [],
    history: async () => [],
    startTurn: async (input) => {
      world.starts.push({ sessionId: input.sessionId, text: input.text });
      await Promise.all([...listeners].map((listener) => listener(input.sessionId, { type: "turn/started", turnId: `turn-${world.starts.length}` })));
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    dispose: async () => {},
  } as AgentRuntime;
}

function fixture(t: test.TestContext, options: { sharedAuthority?: boolean; media?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "polyth-move-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRow = (id: string, extra: Partial<Project> = {}): Project => {
    const path = join(root, id);
    mkdirSync(path, { recursive: true });
    return { id, path, name: `Project ${id}`, createdAt: 1, spaceId: "space-1", ...extra };
  };
  const rows = new Map<string, Project>([
    ["one", projectRow("one")],
    ["two", projectRow("two")],
    ["three", projectRow("three")],
    ["room", projectRow("room", { parentProjectId: "one" })],
    ["remote", projectRow("remote", { remote: { kind: "ssh", connectionId: "c1" } as Project["remote"] })],
    ["foreign", projectRow("foreign", { spaceId: "space-2" })],
  ]);
  const projects: ProjectService = {
    list: async () => [...rows.values()],
    get: async (id) => rows.get(id),
    add: async () => rows.get("one")!,
    create: async () => rows.get("one")!,
    remove: async () => {},
  };
  const world: FakeWorld = {
    sharedAuthority: options.sharedAuthority ?? true,
    failRelease: false,
    noRelease: false,
    acquired: [],
    released: [],
    resets: [],
    starts: [],
  };
  const store = createStore(join(root, "s.db"));
  const accessChanged: SessionProjection[][] = [];
  const preserved: Array<{ sourceRoot: string; destinationRoot: string; sessionIds: readonly string[]; allowed: readonly string[] }> = [];
  const open = () => {
    const runtimes = new Map<string, AgentRuntime>();
    const listeners = new Set<Listener>();
    const broadcast: Broadcaster = {
      event: () => {},
      projection: () => {},
      sessionAccessChanged: (projections) => { accessChanged.push(projections); },
    };
    return createSessionService({
      store,
      projects,
      permissions: { evaluate: () => "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
      broadcast,
      queue: store,
      ...(options.media ? {
        sessionMedia: {
          preserve: async (input: { sourceRoot: string; destinationRoot: string; sessionIds: readonly string[]; ignored?(paths: readonly string[]): Promise<readonly string[]> }) => {
            preserved.push({
              sourceRoot: input.sourceRoot,
              destinationRoot: input.destinationRoot,
              sessionIds: input.sessionIds,
              allowed: await input.ignored!(["_inbox/a.png", "docs/shot.png", "scratch/ignored.png"]),
            });
          },
          ignored: async (_root: string, paths: readonly string[]) => paths.filter((path) => path.startsWith("scratch/")),
        },
      } : {}),
      runtimes: {
        forProject: async (_projectId, cwd) => {
          const key = cwd ?? "";
          world.acquired.push(key);
          if (!runtimes.has(key)) runtimes.set(key, fakeRuntime(world, key, listeners));
          return runtimes.get(key)!;
        },
      },
    });
  };
  let sessions = open();
  t.after(async () => {
    sessions.dispose();
    await store.close();
  });
  return {
    world, store, rows, accessChanged, preserved,
    get sessions() { return sessions; },
    /** A new server process over the same database: nothing wired, no memory. */
    restart() {
      sessions.dispose();
      sessions = open();
    },
  };
}

const moved = async (f: ReturnType<typeof fixture>, id: string) => (await f.store.projection(id))!;
const markerOf = async (f: ReturnType<typeof fixture>, id: string) =>
  (await f.store.events(id)).filter((event) => event.type === "session/project-moved");

test("a chat and its subagents move together; history and identity stay", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one", title: "Root" });
  const child = await f.sessions.create({ projectId: "one", title: "Child", parentId: root.id });
  const grandchild = await f.sessions.create({ projectId: "one", title: "Grandchild", parentId: child.id });
  const unrelated = await f.sessions.create({ projectId: "one", title: "Unrelated" });
  const before = await f.store.latestSeq(root.id);

  const result = await f.sessions.moveToProject!(root.id, { projectId: "two" });

  assert.deepEqual(result.sessionIds, [root.id, child.id, grandchild.id]);
  assert.equal(result.session.id, root.id, "the same canonical session");
  assert.equal(await f.store.latestSeq(root.id) > before, true, "the log only grew");
  for (const id of result.sessionIds) {
    const row = await moved(f, id);
    assert.equal(row.projectId, "two");
    assert.equal(row.projectMove?.fromProjectId, "one");
    assert.equal(row.projectMove?.toProjectId, "two");
    assert.equal(row.projectMove?.operationId, result.operationId);
    assert.equal(row.workspace?.repositories[0]?.path, f.rows.get("two")!.path);
    const [marker] = await markerOf(f, id);
    assert.equal(marker?.ignorable, true, "old reducers skip it");
    assert.deepEqual(
      [marker?.data.fromProjectId, marker?.data.toProjectId, marker?.data.rootSessionId, marker?.data.toProjectName],
      ["one", "two", root.id, "Project two"],
    );
  }
  assert.equal((await moved(f, grandchild.id)).parentId, child.id, "the tree keeps its shape");
  assert.equal((await moved(f, unrelated.id)).projectId, "one");
  assert.deepEqual((await f.store.projections("two")).map((row) => row.id).sort(), [root.id, child.id, grandchild.id].sort());
  assert.equal(f.accessChanged.flat().length, 3, "every reader hears about all three");
});

test("what belonged to the old project does not come along", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  await f.store.upsertProjection({
    ...(await moved(f, root.id)),
    folderId: "folder-of-one",
    worktreePath: join(f.rows.get("one")!.path, "wt"),
    worktreeId: "wt",
    worktreeState: "ready",
    branch: "feature",
    isolationMerge: { commit: "abc" } as SessionProjection["isolationMerge"],
    labelIds: ["space-label"],
    draft: "keep me",
  });
  f.restart();
  await f.sessions.moveToProject!(root.id, { projectId: "two" });
  const row = await moved(f, root.id);
  for (const key of ["folderId", "worktreePath", "worktreeId", "worktreeState", "branch", "isolationMerge"] as const) {
    assert.equal(row[key], undefined, `${key} named the old project`);
  }
  assert.deepEqual(row.labelIds, ["space-label"], "labels belong to the Space");
  assert.equal(row.draft, "keep me");
});

test("a fork is its own chat and stays; it can also move alone", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  const fork = await f.sessions.create({ projectId: "one", parentId: root.id });
  await f.store.append(fork.id, "session/forked", { fromSessionId: root.id }, { ignorable: true });
  const child = await f.sessions.create({ projectId: "one", parentId: root.id });

  const result = await f.sessions.moveToProject!(root.id, { projectId: "two" });
  assert.deepEqual(result.sessionIds, [root.id, child.id]);
  assert.equal((await moved(f, fork.id)).projectId, "one");

  const alone = await f.sessions.moveToProject!(fork.id, { projectId: "three" });
  assert.deepEqual(alone.sessionIds, [fork.id]);
  assert.equal((await moved(f, fork.id)).projectId, "three");
});

for (const sharedAuthority of [true, false]) {
  test(`the next message starts a fresh leg in the target folder (${sharedAuthority ? "one daemon" : "a runtime per folder"})`, async (t) => {
    const f = fixture(t, { sharedAuthority });
    const root = await f.sessions.create({ projectId: "one", title: "Chat" });
    const before = await moved(f, root.id);
    assert.ok(before.runtimeBinding, "the chat has a native leg");

    await f.sessions.moveToProject!(root.id, { projectId: "two" });

    const after = await moved(f, root.id);
    assert.equal(after.status, "epoch-pending");
    assert.equal(after.runtimeBinding?.location.directory, f.rows.get("one")!.path, "the old leg stays named until replaced");
    assert.equal(f.world.resets.length, 0, "moving starts nothing in the target");
    assert.equal(after.releasedExecution?.backendSessionId, before.backendSessionId);

    await f.sessions.send(root.id, { text: "continue here" });

    const settled = await moved(f, root.id);
    assert.equal(f.world.resets.at(-1)?.cwd, f.rows.get("two")!.path);
    assert.equal(settled.runtimeBinding?.location.directory, f.rows.get("two")!.path);
    assert.notEqual(settled.backendSessionId, before.backendSessionId, "a new native session");
    assert.equal(settled.runtimeBinding?.epoch, (before.runtimeBinding?.epoch ?? 0) + 1);
    const delivered = f.world.starts.at(-1)!;
    assert.match(delivered.text, /continue here/);
    assert.match(delivered.text, /moved from project "Project one" to project "Project two"/);
    const message = (await f.store.events(root.id)).findLast((event) => event.type === "user/message");
    assert.equal(message?.data.text, "continue here", "the person's words stay theirs");
    assert.match(String(message?.data.recoveryContext), /files did not/, "persisted before delivery");
  });
}

test("the move note reaches the model once", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  await f.sessions.moveToProject!(root.id, { projectId: "two" });
  await f.sessions.send(root.id, { text: "first" });
  assert.match(f.world.starts.at(-1)!.text, /was moved from project/);
  await f.store.append(root.id, "turn/stopped", { turnId: "turn-1", reason: "completed" }, { ignorable: true });
  f.restart();
  await f.sessions.send(root.id, { text: "second" });
  assert.equal(f.world.starts.at(-1)!.text.includes("was moved from project"), false);
});

test("opening a moved chat after a restart recovers it without a person repeating anything", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  await f.sessions.moveToProject!(root.id, { projectId: "two" });
  f.restart();
  await f.sessions.activate!(root.id, { intent: "open" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const row = await moved(f, root.id);
  assert.equal(row.status, "idle");
  assert.equal(row.runtimeBinding?.location.directory, f.rows.get("two")!.path);
});

test("a wired chat proves its leg stopped, once; a chat at rest starts no runtime to prove it", async (t) => {
  const f = fixture(t);
  const wired = await f.sessions.create({ projectId: "one" });
  const binding = (await moved(f, wired.id)).runtimeBinding!;
  await f.sessions.moveToProject!(wired.id, { projectId: "two" });
  assert.deepEqual(f.world.released, [{ directory: f.rows.get("one")!.path, backendSessionId: binding.backendSessionId }]);
  assert.equal((await moved(f, wired.id)).releasedExecution?.proof, "released");
  const events = await f.store.events(wired.id);
  assert.ok(events.some((event) => event.type === "session/workspace-execution-released"));

  const dormant = await f.sessions.create({ projectId: "one" });
  f.restart();
  const acquiredBefore = f.world.acquired.length;
  await f.sessions.moveToProject!(dormant.id, { projectId: "two" });
  assert.equal(f.world.acquired.length, acquiredBefore, "no process spawned for a chat nobody is using");
  assert.equal((await moved(f, dormant.id)).releasedExecution?.proof, "at-rest");
});

test("a moved chat can move again before anyone opened it", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  await f.sessions.moveToProject!(root.id, { projectId: "two" });
  const result = await f.sessions.moveToProject!(root.id, { projectId: "three" });
  assert.deepEqual(result.sessionIds, [root.id]);
  assert.equal(f.world.released.length, 1, "the proof is not asked for twice");
  const row = await moved(f, root.id);
  assert.equal(row.projectMove?.fromProjectId, "two");
  assert.equal(row.releasedExecution?.proof, "released", "the proof still names the same leg");
  await f.sessions.send(root.id, { text: "here" });
  assert.equal(f.world.resets.at(-1)?.cwd, f.rows.get("three")!.path);
});

test("moving to the project it is already in changes nothing", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  const seq = await f.store.latestSeq(root.id);
  const result = await f.sessions.moveToProject!(root.id, { projectId: "one" });
  assert.deepEqual(result.sessionIds, []);
  assert.equal(await f.store.latestSeq(root.id), seq);
  assert.equal(f.world.released.length, 0);
});

test("an unknown project and another Space's project read the same", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  for (const projectId of ["nope", "foreign"]) {
    await assert.rejects(f.sessions.moveToProject!(root.id, { projectId }), { code: "not-found", message: "project not found" });
    await assert.rejects(f.sessions.previewMoveToProject!(root.id, { projectId }), { code: "not-found", message: "project not found" });
  }
  assert.equal((await moved(f, root.id)).projectId, "one");
});

test("a stale expectation refuses the move", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  await assert.rejects(f.sessions.moveToProject!(root.id, { projectId: "three", expectedProjectId: "two" }), { code: "conflict" });
  assert.equal((await moved(f, root.id)).projectId, "one");
});

const refusals: Array<{
  name: string;
  reason: string;
  target?: string;
  source?: string;
  prepare(f: ReturnType<typeof fixture>, id: string, child: string): Promise<string | void>;
}> = [
  { name: "a chat that is working", reason: "busy", prepare: async (f, id) => { await f.store.upsertProjection({ ...(await moved(f, id)), status: "working" }); } },
  { name: "a chat waiting for a person", reason: "busy", prepare: async (f, id) => { await f.store.upsertProjection({ ...(await moved(f, id)), status: "waiting" }); } },
  { name: "a chat whose outcome is unknown", reason: "busy", prepare: async (f, id) => { await f.store.upsertProjection({ ...(await moved(f, id)), status: "unknown" }); } },
  { name: "a paused chat", reason: "busy", prepare: async (f, id) => { await f.store.upsertProjection({ ...(await moved(f, id)), paused: { at: 1, stopSeq: 1 } }); } },
  { name: "a chat waiting to auto-resume", reason: "busy", prepare: async (f, id) => { await f.store.upsertProjection({ ...(await moved(f, id)), resume: { resumeAt: Date.now() + 60_000 } as SessionProjection["resume"] }); } },
  { name: "a chat with a working subagent", reason: "busy", prepare: async (f, _id, child) => { await f.store.upsertProjection({ ...(await moved(f, child)), status: "working" }); } },
  { name: "an isolated chat", reason: "isolated", prepare: async (f, id) => {
    await f.store.upsertProjection({ ...(await moved(f, id)), isolation: { kind: "git-worktree", state: "active", worktreePath: "/x", worktreeBranch: "polyth/isolate/x" } as SessionProjection["isolation"] });
  } },
  { name: "a subagent in an isolated row of its workspace", reason: "isolated", prepare: async (f, _id, child) => {
    const row = await moved(f, child);
    await f.store.upsertProjection({ ...row, workspace: { ...row.workspace!, repositories: row.workspace!.repositories.map((repository) => ({ ...repository, isolation: { kind: "git-worktree", state: "active" } as never })) } });
  } },
  { name: "a chat a package owns", reason: "package-owned", prepare: async (f, id) => { await f.store.upsertProjection({ ...(await moved(f, id)), purpose: "agents" }); } },
  { name: "a chat an automation started", reason: "package-owned", prepare: async (f, id) => { await f.store.upsertProjection({ ...(await moved(f, id)), origin: { kind: "schedule" } as unknown as SessionProjection["origin"] }); } },
  { name: "a chat that ran a workflow", reason: "package-owned", prepare: async (f, id) => { await f.store.append(id, "workflow/run-started", { runId: "r" }, { ignorable: true }); } },
  { name: "a chat with queued messages", reason: "queued", prepare: async (f, id) => { await f.store.enqueue(id, "later", "normal" as never); } },
  { name: "a delegated subagent on its own", reason: "delegated", prepare: async (_f, _id, child) => child },
  { name: "a chat going into a private room", reason: "private", target: "room", prepare: async () => {} },
  { name: "a chat coming out of a private room", reason: "private", source: "room", prepare: async () => {} },
  { name: "a chat going to another machine", reason: "other-machine", target: "remote", prepare: async () => {} },
  { name: "a chat coming from another machine", reason: "other-machine", source: "remote", prepare: async () => {} },
  { name: "an archived chat", reason: "archived", prepare: async (f, id) => { await f.sessions.archive(id); } },
];

for (const refusal of refusals) {
  test(`${refusal.name} stays where it is, and the preview said so first`, async (t) => {
    const f = fixture(t);
    const root = await f.sessions.create({ projectId: "one" });
    const child = await f.sessions.create({ projectId: "one", parentId: root.id });
    if (refusal.source) {
      for (const id of [root.id, child.id]) await f.store.upsertProjection({ ...(await moved(f, id)), projectId: refusal.source });
    }
    const asked = await refusal.prepare(f, root.id, child.id) || root.id;
    const input = { projectId: refusal.target ?? "two" };
    const seqBefore = await f.store.latestSeq(asked);

    const preview = await f.sessions.previewMoveToProject!(asked, input);
    assert.equal(preview.blocked?.reason, refusal.reason);
    await assert.rejects(f.sessions.moveToProject!(asked, input), (error: { code?: string; reason?: string }) =>
      error.code === "conflict" && error.reason === refusal.reason);

    assert.equal(await f.store.latestSeq(asked), seqBefore, "not even a marker");
    assert.equal((await markerOf(f, root.id)).length + (await markerOf(f, child.id)).length, 0);
    assert.equal(f.world.released.length, 0, "nothing was released on the way to a refusal");
  });
}

test("a harness that can't prove its leg stopped refuses before anything happens", async (t) => {
  const f = fixture(t);
  f.world.noRelease = true;
  const root = await f.sessions.create({ projectId: "one" });
  const preview = await f.sessions.previewMoveToProject!(root.id, { projectId: "two" });
  assert.equal(preview.blocked?.reason, "unsupported");
  await assert.rejects(f.sessions.moveToProject!(root.id, { projectId: "two" }), { code: "conflict" });
  assert.equal((await moved(f, root.id)).projectId, "one");
});

test("an uncertain release leaves the chat in place and never claims it stopped", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  f.world.failRelease = true;
  await assert.rejects(f.sessions.moveToProject!(root.id, { projectId: "two" }));
  const row = await moved(f, root.id);
  assert.equal(row.projectId, "one");
  assert.equal(row.releasedExecution, undefined);
  assert.equal(row.projectMove, undefined);
  assert.equal((await markerOf(f, root.id)).length, 0);
});

test("a subagent left released by a failed move recovers where it still is", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  const child = await f.sessions.create({ projectId: "one", parentId: root.id });
  const realRelease = f.world.released;
  let calls = 0;
  Object.defineProperty(f.world, "failRelease", { get: () => ++calls > 1 });
  await assert.rejects(f.sessions.moveToProject!(root.id, { projectId: "two" }));
  assert.equal(realRelease.length, 1, "the subagent released first");
  const left = await moved(f, child.id);
  assert.equal(left.projectId, "one", "nothing moved");
  assert.equal(left.status, "epoch-pending");
  assert.equal((await moved(f, root.id)).projectId, "one");
  Object.defineProperty(f.world, "failRelease", { value: false });
  await f.sessions.send(child.id, { text: "still here" });
  const settled = await moved(f, child.id);
  assert.equal(settled.projectId, "one");
  assert.equal(settled.runtimeBinding?.location.directory, f.rows.get("one")!.path);
  assert.notEqual(settled.backendSessionId, left.backendSessionId);
});

test("a preview changes nothing and counts what would move", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  const child = await f.sessions.create({ projectId: "one", parentId: root.id });
  const seq = await f.store.latestSeq(root.id);
  const preview = await f.sessions.previewMoveToProject!(root.id, { projectId: "two" });
  assert.deepEqual(preview.sessionIds, [root.id, child.id]);
  assert.equal(preview.restartsAgent, true);
  assert.equal(preview.blocked, undefined);
  assert.equal(await f.store.latestSeq(root.id), seq);
  assert.equal((await moved(f, root.id)).projectId, "one");
  assert.equal(f.world.released.length, 0);
});

test("an archived subagent comes along at rest and stays archived", async (t) => {
  const f = fixture(t);
  const root = await f.sessions.create({ projectId: "one" });
  const child = await f.sessions.create({ projectId: "one", parentId: root.id });
  await f.sessions.archive(child.id);
  const result = await f.sessions.moveToProject!(root.id, { projectId: "two" });
  assert.deepEqual(result.sessionIds, [root.id, child.id]);
  const row = await moved(f, child.id);
  assert.equal(row.projectId, "two");
  assert.equal(row.status, "archived");
  assert.equal(row.releasedExecution?.proof, "at-rest");
});

test("media: the inbox always comes along; anything else only where Git ignores it", async (t) => {
  const f = fixture(t, { media: true });
  const root = await f.sessions.create({ projectId: "one" });
  await f.sessions.moveToProject!(root.id, { projectId: "two" });
  assert.equal(f.preserved.length, 1);
  const [copy] = f.preserved;
  assert.equal(copy!.sourceRoot, f.rows.get("one")!.path);
  assert.equal(copy!.destinationRoot, f.rows.get("two")!.path);
  assert.deepEqual(copy!.sessionIds, [root.id]);
  assert.deepEqual(copy!.allowed, ["_inbox/a.png", "scratch/ignored.png"]);
});
