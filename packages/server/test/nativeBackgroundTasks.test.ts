import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, ProjectService, RuntimeCapabilities, RuntimeEvent } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type IdleSessionRuntimePolicy } from "../src/sessions.ts";
import { lostBackgroundTasksText, normalizeBackgroundTasks } from "../src/nativeBackgroundTasks.ts";

const STATIC: RuntimeCapabilities = {
  streaming: true,
  permissions: false,
  questions: false,
  compaction: false,
  subagents: false,
  title: "native",
  attachments: { modalities: { image: "native", file: "unsupported", pdf: "native", audio: "native" } },
  commands: { discovery: "native", invoke: "raw-native-input" },
  contextOccupancy: "unknown",
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const until = async (condition: () => boolean | Promise<boolean>, rounds = 100) => {
  for (let i = 0; i < rounds && !await condition(); i += 1) await flush();
};

const watcher = { id: "binwjo0go", description: "Wait for release runs", kind: "local_bash" };

function fixture(policy: Partial<IdleSessionRuntimePolicy>, store = createStore(":memory:")) {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const prompts: string[] = [];
  const retired: string[] = [];
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const newRuntime = (): AgentRuntime => ({
    harnessId: "fake",
    capabilities: async () => STATIC,
    commands: async () => [],
    models: async () => [],
    agents: async () => [],
    ensureSession: async ({ sessionId }) => `native-${sessionId}`,
    sessions: async () => [],
    history: async () => [],
    async startTurn(request) {
      prompts.push(request.text);
      emit(request.sessionId, { type: "turn/started", turnId: `turn-${prompts.length}` });
      // The turn ends waiting on work it started in the background.
      if (request.text === "start the watcher") emit(request.sessionId, { type: "runtime/background-tasks", tasks: [watcher] });
      emit(request.sessionId, { type: "turn/stopped", turnId: `turn-${prompts.length}`, reason: "completed" });
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    dispose: async () => {},
  });
  const projects = {
    get: async (id: string) => id === "p"
      ? { id: "p", name: "p", path: "/tmp", spaceId: "space", createdAt: 0 }
      : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store,
    projects,
    runtimes: {
      forProject: async () => { throw new Error("forProject is not used here"); },
      // One session-scoped process per wiring, as Claude Code runs.
      forSession: async () => newRuntime(),
      retireSession: async (sessionId) => { retired.push(sessionId); },
      isSessionScoped: () => true,
    },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    harnesses: { staticFeatures: () => STATIC },
    idleSessionRuntimes: policy,
  });
  const lostPrompts = () => prompts.filter((prompt) => prompt.includes("no completion notice will ever arrive"));
  return { store, sessions, emit, prompts, retired, lostPrompts };
}

test("background work that has not reported back keeps its idle runtime; settling releases it", async () => {
  const { sessions, emit, retired, store, lostPrompts } = fixture({ sweepMs: 10, minIdleMs: 0, ttlMs: 0, maxIdle: 0, backgroundGraceMs: 0 });
  try {
    const created = await sessions.create({ projectId: "p" });
    await sessions.send(created.id, { text: "start the watcher" });
    await flush();
    await flush();
    assert.deepEqual((await store.projection(created.id))?.nativeBackgroundTasks?.tasks, [watcher]);
    for (let i = 0; i < 5; i += 1) await flush();
    assert.deepEqual(retired, [], "a runtime with pending background work is not idle");
    assert.equal((await sessions.releaseRuntimeIfIdle!(created.id)).released, false);

    emit(created.id, { type: "runtime/background-tasks", tasks: [] });
    await until(() => retired.includes(created.id));
    assert.ok(retired.includes(created.id), "once the work settled the runtime is released as usual");
    assert.equal((await store.projection(created.id))?.nativeBackgroundTasks, undefined);
    assert.deepEqual(lostPrompts(), [], "work that reported back is not lost");
  } finally {
    sessions.dispose?.();
  }
});

test("a runtime released with background work still owed wakes the session once, saying the work was lost", async () => {
  const { sessions, emit, retired, store, lostPrompts } = fixture({ sweepMs: 10, minIdleMs: 0, ttlMs: 0, maxIdle: 0, backgroundHoldMs: 0, backgroundGraceMs: 0 });
  try {
    const created = await sessions.create({ projectId: "p" });
    await sessions.send(created.id, { text: "start the watcher" });
    await flush();
    await until(() => lostPrompts().length > 0);
    assert.ok(retired.includes(created.id), "the hold expired and the runtime was released");
    assert.equal(lostPrompts().length, 1);
    assert.match(lostPrompts()[0]!, /binwjo0go/);
    assert.match(lostPrompts()[0]!, /Wait for release runs/);
    for (let i = 0; i < 5; i += 1) await flush();
    assert.equal(lostPrompts().length, 1, "the loss is told once");
    assert.equal((await store.projection(created.id))?.nativeBackgroundTasks, undefined);
    const woken = (await store.events(created.id)).filter((event) => event.type === "user/message"
      && String((event.data as { text?: unknown }).text).includes("binwjo0go"));
    assert.equal(woken.length, 1);
    assert.equal((woken[0]!.data as { hiddenUserMessage?: unknown }).hiddenUserMessage, true);
  } finally {
    sessions.dispose?.();
  }
});

test("work the runtime reports lost with its process becomes one wake", async () => {
  const { sessions, emit, store, lostPrompts } = fixture({ sweepMs: 0, backgroundGraceMs: 0 });
  try {
    const created = await sessions.create({ projectId: "p" });
    await sessions.send(created.id, { text: "start the watcher" });
    await flush();
    await flush();
    emit(created.id, { type: "runtime/background-tasks", tasks: [], lost: [watcher] });
    await until(() => lostPrompts().length > 0);
    assert.equal(lostPrompts().length, 1);
    assert.match(lostPrompts()[0]!, /the harness process stopped/);
    assert.equal((await store.projection(created.id))?.nativeBackgroundTasks, undefined);
  } finally {
    sessions.dispose?.();
  }
});

test("after a server restart every recorded background task is lost and its session is woken", async () => {
  const store = createStore(":memory:");
  const before = fixture({ sweepMs: 0 }, store);
  const created = await before.sessions.create({ projectId: "p" });
  await before.sessions.send(created.id, { text: "start the watcher" });
  await flush();
  await flush();
  // The process dies with the server; nothing detached it in an orderly way.
  before.sessions.dispose?.();
  assert.deepEqual((await store.projection(created.id))?.nativeBackgroundTasks?.tasks, [watcher]);

  const after = fixture({ sweepMs: 0, backgroundGraceMs: 0 }, store);
  try {
    await until(() => after.lostPrompts().length > 0);
    assert.equal(after.lostPrompts().length, 1);
    assert.match(after.lostPrompts()[0]!, /binwjo0go/);
    assert.equal((await store.projection(created.id))?.nativeBackgroundTasks, undefined);
  } finally {
    after.sessions.dispose?.();
  }
});

test("an archived session drops its background-task record without a wake", async () => {
  const { sessions, emit, store, lostPrompts } = fixture({ sweepMs: 0, backgroundGraceMs: 0 });
  try {
    const created = await sessions.create({ projectId: "p" });
    await sessions.send(created.id, { text: "start the watcher" });
    await flush();
    await flush();
    await sessions.archive!(created.id);
    await until(async () => (await store.projection(created.id))?.nativeBackgroundTasks === undefined);
    assert.equal((await store.projection(created.id))?.nativeBackgroundTasks, undefined);
    assert.deepEqual(lostPrompts(), []);
  } finally {
    sessions.dispose?.();
  }
});

test("background task reports are bounded and the loss notice names each task", () => {
  const tasks = normalizeBackgroundTasks([
    { id: " a ", description: "x".repeat(400), kind: "local_bash" },
    { id: "a" },
    { id: "" },
    "junk",
    ...Array.from({ length: 40 }, (_, i) => ({ id: `t${i}` })),
  ]);
  assert.equal(tasks.length, 32);
  assert.equal(tasks[0]!.id, "a");
  assert.equal(tasks[0]!.description!.length, 300);
  const text = lostBackgroundTasksText({ tasks: [watcher], at: 1, reason: "its runtime was released or replaced" });
  assert.match(text, /Wait for release runs \(task binwjo0go, local_bash\)/);
});

test("a server-owned wait holds the session's runtime until it is released", async () => {
  const { sessions, retired } = fixture({ sweepMs: 10, minIdleMs: 0, ttlMs: 0, maxIdle: 0 });
  try {
    const created = await sessions.create({ projectId: "p" });
    await sessions.send(created.id, { text: "start a build" });
    sessions.holdRuntime!(created.id, "wait-1", Date.now() + 60_000);
    for (let i = 0; i < 5; i += 1) await flush();
    assert.deepEqual(retired, [], "a held runtime is not idle");
    assert.deepEqual(await sessions.releaseRuntimeIfIdle!(created.id), { released: false, blocker: "wait" });
    sessions.releaseRuntimeHold!(created.id, "wait-1");
    await until(() => retired.includes(created.id));
    assert.ok(retired.includes(created.id));
  } finally {
    sessions.dispose?.();
  }
});
