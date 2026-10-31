import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEvent } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster, type RuntimePool } from "../src/sessions.ts";

type Emit = (sessionId: string, event: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const emit = (sessionId: string, event: RuntimeEvent): void => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (context) => `be_${context.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      emit(request.sessionId, { type: "turn/started", turnId: "turn-1" });
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    dispose: async () => {},
  };
  return { runtime, emit };
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test("legacy streamed chunks journal coalesced checkpoints in canonical event order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-stream-batch-"));
  const rawStore = createStore(join(dir, "sessions.db"));
  let appendCalls = 0;
  const store = new Proxy(rawStore, {
    get(target, property, receiver) {
      if (property === "append") {
        return (...args: Parameters<typeof rawStore.append>) => {
          appendCalls += 1;
          return rawStore.append(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcasted: string[] = [];
  const broadcast: Broadcaster = {
    event: (event) => { broadcasted.push(event.type); },
    projection: () => {},
  };
  const fake = fakeRuntime();
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => fake.runtime },
  });

  const { id } = await sessions.create({ projectId: project.id, title: "stream" });
  await sessions.send(id, { text: "go" });
  await settle(20);

  const appendBeforeStream = appendCalls;
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "a" });
  await settle(5);
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "b" });
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "c" });
  fake.emit(id, { type: "assistant/message", partId: "answer", text: "abc" });
  fake.emit(id, { type: "turn/stopped", turnId: "turn-1", reason: "completed" });
  await settle();

  const events = await store.events(id);
  const relevant = events
    .filter((event) => event.type === "assistant/chunk"
      || event.type === "assistant/message"
      || event.type === "turn/stopped")
    .map((event) => ({
      type: event.type,
      text: (event.data as { text?: string }).text,
    }));

  // Streamed deltas are journaled as checkpoints (streamCoalesce.ts): the first
  // delta of a quiet session lands immediately, later deltas of the same part
  // merge into one run, and the next non-stream event is the barrier that
  // persists it. Text is never lost, only its row granularity changes.
  assert.deepEqual(relevant, [
    { type: "assistant/chunk", text: "a" },
    { type: "assistant/chunk", text: "bc" },
    { type: "assistant/message", text: "abc" },
    { type: "turn/stopped", text: undefined },
  ]);
  assert.ok(appendCalls - appendBeforeStream < 5, "stream chunks should not each require their own append transaction");
  assert.deepEqual(
    broadcasted.filter((type) => type === "assistant/chunk" || type === "assistant/message" || type === "turn/stopped"),
    relevant.map((event) => event.type),
  );

  await rawStore.close();
});

test("a sustained stream journals checkpoint runs, not one durable row per token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-stream-checkpoint-"));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const fake = fakeRuntime();
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    runtimes: { forProject: async () => fake.runtime },
  });

  const { id } = await sessions.create({ projectId: project.id, title: "sustained" });
  await sessions.send(id, { text: "go" });
  await settle(20);

  // 400 provider deltas in one burst, exactly how a token-per-event backend
  // reports a long reasoning block.
  const deltas = Array.from({ length: 400 }, (_unused, index) => `t${index} `);
  for (const text of deltas) fake.emit(id, { type: "assistant/reasoning-chunk", partId: "think", text });
  fake.emit(id, { type: "turn/stopped", turnId: "turn-1", reason: "completed" });
  await settle();
  const rowsAfterBarrier = (await store.events(id)).filter((event) => event.type === "assistant/reasoning-chunk");

  // The barrier persisted the whole pending run; no timer may write after it.
  await settle(300);
  const chunks = (await store.events(id)).filter((event) => event.type === "assistant/reasoning-chunk");

  assert.equal(chunks.map((event) => (event.data as { text: string }).text).join(""), deltas.join(""), "no streamed text is lost");
  assert.equal(chunks.length, rowsAfterBarrier.length, "a finished turn leaves no pending checkpoint behind");
  assert.ok(chunks.length <= 5, `400 deltas must journal a bounded number of checkpoints, got ${chunks.length}`);

  sessions.dispose();
  await store.close();
});


test("runtime eviction drains accepted stream chunks and fences later callbacks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-stream-evict-"));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const fake = fakeRuntime();
  let evictListener: ((runtime: AgentRuntime) => void | Promise<void>) | undefined;
  const runtimes: RuntimePool = {
    forProject: async () => fake.runtime,
    onEvict(listener) {
      evictListener = listener;
      return {
        dispose: () => {
          if (evictListener === listener) evictListener = undefined;
        },
      };
    },
  };
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    runtimes,
  });

  const { id } = await sessions.create({ projectId: project.id, title: "stream eviction" });
  await sessions.send(id, { text: "go" });
  await settle(20);

  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "a" });
  await settle(10);
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "b" });
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "c" });

  assert.ok(evictListener, "runtime pool registered its eviction listener");
  const eviction = Promise.resolve(evictListener!(fake.runtime));

  // The eviction listener fences the wire synchronously before its first
  // await. A late callback from the retired facade must therefore be ignored.
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "late" });
  await eviction;
  await settle(70);

  const chunks = (await store.events(id))
    .filter((event) => event.type === "assistant/chunk")
    .map((event) => (event.data as { text?: string }).text);
  assert.deepEqual(chunks, ["a", "bc"]);

  sessions.dispose();
  await store.close();
});

test("flushPendingStreams journals deltas still buffered in a checkpoint window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-stream-flush-"));
  const store = createStore(join(dir, "sessions.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const fake = fakeRuntime();
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    runtimes: { forProject: async () => fake.runtime },
  });

  // Nothing buffered: resolves cleanly.
  await sessions.flushPendingStreams();

  const { id } = await sessions.create({ projectId: project.id, title: "flush" });
  await sessions.send(id, { text: "go" });
  await settle(20);

  // The first delta of a quiet session lands immediately; the rest sit in the window.
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "a" });
  await settle(5);
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "b" });
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "c" });
  fake.emit(id, { type: "assistant/chunk", partId: "answer", text: "d" });
  await settle(5);
  const chunkTexts = async () => (await store.events(id))
    .filter((event) => event.type === "assistant/chunk")
    .map((event) => (event.data as { text: string }).text);
  assert.deepEqual(await chunkTexts(), ["a"], "buffered deltas are not journaled yet");

  await sessions.flushPendingStreams();
  assert.deepEqual(await chunkTexts(), ["a", "bcd"]);

  await sessions.flushPendingStreams();
  await settle(300);
  assert.deepEqual(await chunkTexts(), ["a", "bcd"], "no timer double-flushes");

  sessions.dispose();
  await store.close();
});
