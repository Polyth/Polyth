import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  AgentRuntime,
  ProjectService,
  RuntimeEvent,
  SessionProjection,
  SessionService,
  SpaceContext,
  UserTurnInput,
} from "@polyth/contracts";
import { createStore } from "@polyth/session";
import type { PermissionService } from "@polyth/permissions";
import { createSessionWatchCoordinator } from "../src/sessionWatches.ts";
import { createSessionService } from "../src/sessions.ts";

const space: SpaceContext = {
  spaceId: "space-watch",
  spaceSlug: "space-watch",
  userId: "user-watch",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/space-watch",
};

const projection = (id: string): SessionProjection => ({
  id,
  projectId: "project-watch",
  spaceId: space.spaceId,
  title: id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "polyth-session-watch-"));
  const dbPath = join(dir, "sessions.db");
  const store = createStore(dbPath);
  const sends: Array<{ sessionId: string; input: UserTurnInput }> = [];
  const sessions = {
    async send(sessionId: string, input: UserTurnInput) {
      sends.push({ sessionId, input });
      return { turnId: `turn-${sessionId}-${sends.length}` };
    },
  } as unknown as SessionService;
  const coordinator = createSessionWatchCoordinator({
    store,
    sessions: () => sessions,
    broadcast: { event() {} },
  });
  return { dir, dbPath, store, sessions, sends, coordinator };
}

async function seed(
  store: ReturnType<typeof createStore>,
  ...ids: string[]
): Promise<void> {
  for (const id of ids) await store.upsertProjection(projection(id));
}

test("v18 upgrades a v17 sessions database and reopens idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-session-watch-migration-"));
  const dbPath = join(dir, "sessions.db");
  const initial = createStore(dbPath);
  await initial.close();

  const legacy = new DatabaseSync(dbPath);
  legacy.exec("DROP TABLE session_watches");
  legacy.prepare("UPDATE schema_meta SET value = '17' WHERE key = 'version'").run();
  legacy.close();

  const upgraded = createStore(dbPath);
  await seed(upgraded, "source", "target");
  const inserted = await upgraded.createSessionWatch({
    id: "watch-upgrade",
    spaceId: space.spaceId,
    sourceSessionId: "source",
    targetSessionId: "target",
    events: ["completed"],
    delivery: "wake",
    once: false,
    cursorSeq: await upgraded.latestSeq("source"),
    createdAt: 1,
  });
  assert.equal(inserted.created, true);
  await upgraded.close();

  const reopened = createStore(dbPath);
  assert.equal((await reopened.sessionWatch("watch-upgrade"))?.sourceSessionId, "source");
  await reopened.close();
});

test("one terminal event wakes every subscribed target without polling", async () => {
  const h = harness();
  await seed(h.store, "source", "target-a", "target-b");

  await h.coordinator.create(space, {
    sourceSessionId: "source",
    targetSessionId: "target-a",
  });
  await h.coordinator.create(space, {
    sourceSessionId: "source",
    targetSessionId: "target-b",
  });

  await h.store.append("source", "turn/stopped", { reason: "error", turnId: "turn-source" });
  await h.coordinator.kick("source");

  assert.deepEqual(h.sends.map((send) => send.sessionId).sort(), ["target-a", "target-b"]);
  for (const send of h.sends) {
    assert.equal(send.input.delivery, "normal");
    assert.equal(send.input.hiddenUserMessage, true);
    assert.match(send.input.text, /failed/);
    assert.match(send.input.clientOperationId ?? "", /^[0-9a-f-]{36}$/);
  }
  assert.equal((await h.coordinator.list(space)).length, 0, "one-shot watches are removed after delivery");

  await h.coordinator.close();
  await h.store.close();
});

test("wake retry reuses the same operation id and deterministic payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-session-watch-retry-"));
  const dbPath = join(dir, "sessions.db");
  const store = createStore(dbPath);
  await seed(store, "source", "target");
  const sends: Array<{ sessionId: string; input: UserTurnInput }> = [];
  let loseResponse = true;
  const sessions = {
    async send(sessionId: string, input: UserTurnInput) {
      sends.push({ sessionId, input });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost after admission");
      }
      return { turnId: "wake-turn" };
    },
  } as unknown as SessionService;
  const coordinator = createSessionWatchCoordinator({
    store,
    sessions: () => sessions,
    broadcast: { event() {} },
  });
  await coordinator.create(space, {
    sourceSessionId: "source",
    targetSessionId: "target",
    once: false,
  });
  await store.append("source", "turn/stopped", { reason: "completed" });
  await coordinator.kick("source");
  assert.equal(sends.length, 1);

  await coordinator.close();
  await store.close();
  const reopened = createStore(dbPath);
  const recovered = createSessionWatchCoordinator({
    store: reopened,
    sessions: () => sessions,
    broadcast: { event() {} },
  });
  await reopened.patchProjection?.("source", (current) => ({
    ...current,
    title: "A title that changed after the lost response",
  }));
  await recovered.recover();
  assert.equal(sends.length, 2);
  assert.equal(sends[1]!.input.clientOperationId, sends[0]!.input.clientOperationId);
  assert.equal(sends[1]!.input.text, sends[0]!.input.text);

  await recovered.close();
  await reopened.close();
});

test("restart recovery drains only matching terminal events and is idempotent", async () => {
  const h = harness();
  await seed(h.store, "source", "target");

  const watch = await h.coordinator.create(space, {
    sourceSessionId: "source",
    targetSessionId: "target",
    events: ["error"],
    once: false,
  });
  await h.store.append("source", "turn/stopped", { reason: "completed" });
  await h.store.append("source", "turn/stopped", { reason: "error" });
  await h.coordinator.close();
  await h.store.close();

  const reopened = createStore(h.dbPath);
  const recovered = createSessionWatchCoordinator({
    store: reopened,
    sessions: () => h.sessions,
    broadcast: { event() {} },
  });
  await recovered.recover();
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0]!.input.text, /failed/);
  assert.deepEqual((await recovered.list(space)).map((item) => item.id), [watch.id]);

  await recovered.recover();
  assert.equal(h.sends.length, 1, "recovery cursor prevents duplicate wake delivery");

  await reopened.append("source", "turn/stopped", { reason: "error" });
  await recovered.kick("source");
  assert.equal(h.sends.length, 2);

  await recovered.close();
  await reopened.close();
});

test("retriable provider stops do not wake a watcher before the final outcome", async () => {
  const h = harness();
  await seed(h.store, "source", "target");

  await h.coordinator.create(space, {
    sourceSessionId: "source",
    targetSessionId: "target",
    once: false,
  });
  await h.store.append("source", "turn/stopped", {
    reason: "error",
    retry: { scope: "rate", resumeAt: Date.now() + 1_000 },
  });
  await h.coordinator.kick("source");
  assert.equal(h.sends.length, 0);

  await h.store.append("source", "turn/stopped", { reason: "completed" });
  await h.coordinator.kick("source");
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0]!.input.text, /completed successfully/);

  await h.coordinator.close();
  await h.store.close();
});

test("watch creation closes the latestSeq-to-insert terminal race", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-session-watch-race-"));
  const dbPath = join(dir, "sessions.db");
  const store = createStore(dbPath);
  await seed(store, "source", "target");
  const sends: Array<{ sessionId: string; input: UserTurnInput }> = [];
  const sessions = {
    async send(sessionId: string, input: UserTurnInput) {
      sends.push({ sessionId, input });
      return { turnId: "wake-turn" };
    },
  } as unknown as SessionService;
  let inject = true;
  const racingStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "latestSeq") {
        return async (sessionId: string) => {
          const seq = await store.latestSeq(sessionId);
          if (inject && sessionId === "source") {
            inject = false;
            await store.append("source", "turn/stopped", { reason: "completed" });
          }
          return seq;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as typeof store;
  const coordinator = createSessionWatchCoordinator({
    store: racingStore,
    sessions: () => sessions,
    broadcast: { event() {} },
  });

  await coordinator.create(space, {
    sourceSessionId: "source",
    targetSessionId: "target",
  });
  assert.equal(sends.length, 1);
  assert.match(sends[0]!.input.text, /completed successfully/);

  await coordinator.close();
  await store.close();
});

test("dropping a deleted session removes incoming and outgoing watch edges", async () => {
  const h = harness();
  await seed(h.store, "a", "b", "c");

  await h.coordinator.create(space, {
    sourceSessionId: "a",
    targetSessionId: "b",
    delivery: "observe",
    once: false,
  });
  await h.coordinator.create(space, {
    sourceSessionId: "c",
    targetSessionId: "a",
    delivery: "observe",
    once: false,
  });
  await h.coordinator.create(space, {
    sourceSessionId: "b",
    targetSessionId: "c",
    delivery: "observe",
    once: false,
  });

  await h.store.deleteSession("a");
  const remaining = await h.coordinator.list(space);
  assert.deepEqual(
    remaining.map((watch) => [watch.sourceSessionId, watch.targetSessionId]),
    [["b", "c"]],
  );

  await h.coordinator.close();
  await h.store.close();
});

test("concurrent subscriptions dedupe identical edges and cannot race a wake cycle", async () => {
  const h = harness();
  await seed(h.store, "a", "b", "target");

  const duplicates = await Promise.all([
    h.coordinator.create(space, { sourceSessionId: "a", targetSessionId: "target", once: false }),
    h.coordinator.create(space, { sourceSessionId: "a", targetSessionId: "target", once: false }),
  ]);
  assert.equal(duplicates[0]!.id, duplicates[1]!.id);
  assert.equal((await h.coordinator.list(space, {
    sourceSessionId: "a",
    targetSessionId: "target",
  })).length, 1);

  const cycle = await Promise.allSettled([
    h.coordinator.create(space, { sourceSessionId: "a", targetSessionId: "b", once: false }),
    h.coordinator.create(space, { sourceSessionId: "b", targetSessionId: "a", once: false }),
  ]);
  assert.equal(cycle.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(cycle.filter((result) => result.status === "rejected").length, 1);

  await h.coordinator.close();
  await h.store.close();
});

test("wake graph rejects cycles while observe links remain safe", async () => {
  const h = harness();
  await seed(h.store, "a", "b");

  await h.coordinator.create(space, {
    sourceSessionId: "a",
    targetSessionId: "b",
    once: false,
  });
  await assert.rejects(
    () => h.coordinator.create(space, {
      sourceSessionId: "b",
      targetSessionId: "a",
      once: false,
    }),
    /create a session cycle/,
  );
  await assert.rejects(
    () => h.coordinator.create(space, {
      sourceSessionId: "a",
      targetSessionId: "a",
    }),
    /cannot watch itself/,
  );

  await h.coordinator.create(space, {
    sourceSessionId: "b",
    targetSessionId: "a",
    delivery: "observe",
    once: false,
  });
  await h.store.append("b", "turn/stopped", { reason: "aborted" });
  await h.coordinator.kick("b");
  assert.equal(h.sends.length, 0);
  assert.equal(
    (await h.store.events("a")).filter((event) => event.type === "session/watch-fired").length,
    1,
  );

  await h.coordinator.close();
  await h.store.close();
});

test("lost wake acknowledgement behind an executing operation admits one queue item", async (t) => {
  const h = harness();
  await seed(h.store, "source", "target");
  const sessions = createSessionService({
    store: h.store,
    queue: h.store,
    projects: {
      get: async () => ({ id: "project-watch", name: "Watch", path: tmpdir(), createdAt: 1 }),
    } as ProjectService,
    permissions: { evaluate: () => "ask", addRule() {}, rules: () => [] } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    runtimes: { forProject: async () => { throw new Error("a blocked wake must not launch a runtime"); } },
  });
  const operation = await h.store.prepareOperation({
    sessionId: "target",
    mutationKind: "turn-submit",
    intentEvent: { type: "user/message", data: { text: "already executing" } },
  });
  await h.store.claimOperation(operation.operation.operationId);
  let loseResponse = true;
  const coordinator = createSessionWatchCoordinator({
    store: h.store,
    sessions: () => ({
      async send(sessionId, input) {
        const result = await sessions.send(sessionId, input);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("lost response after durable queue admission");
        }
        return result;
      },
    }) as SessionService,
    broadcast: { event() {} },
  });
  t.after(async () => {
    await coordinator.close();
    await h.coordinator.close();
    sessions.dispose();
    await h.store.close();
  });
  const watch = await coordinator.create(space, { sourceSessionId: "source", targetSessionId: "target" });
  await h.store.append("source", "turn/stopped", { reason: "completed" });
  await coordinator.kick("source");
  const pending = await h.store.sessionWatch(watch.id);
  assert.ok(pending?.pendingOperationId);
  await coordinator.kick("source");
  const queue = await h.store.queueList("target");
  assert.equal(queue.length, 1, "lost acknowledgement must not duplicate a hidden wake");
  assert.equal(queue[0]?.id, pending.pendingOperationId);
  assert.equal(queue[0]?.hiddenUserMessage, true);
  assert.equal(await h.store.sessionWatch(watch.id), undefined);
});

test("valid foreign-Space sessions cannot be watched, listed, removed or delivered to", async () => {
  const h = harness();
  await seed(h.store, "source", "target");
  const foreignSpace = { ...space, spaceId: "space-foreign" };
  await h.store.upsertProjection({ ...projection("foreign"), spaceId: foreignSpace.spaceId });
  for (const input of [
    { sourceSessionId: "foreign", targetSessionId: "target" },
    { sourceSessionId: "source", targetSessionId: "foreign" },
  ]) {
    await assert.rejects(() => h.coordinator.create(space, input), { code: "not-found" });
  }
  const watch = await h.coordinator.create(space, { sourceSessionId: "source", targetSessionId: "target" });
  assert.deepEqual(await h.coordinator.list(foreignSpace), []);
  assert.equal(await h.coordinator.remove(foreignSpace, watch.id), false);
  assert.equal(await h.coordinator.remove(space, watch.id, "source"), false);
  await h.store.upsertProjection({ ...projection("target"), spaceId: foreignSpace.spaceId });
  await h.store.append("source", "turn/stopped", { reason: "completed" });
  await h.coordinator.kick("source");
  assert.equal(h.sends.length, 0, "Space ownership is checked again at delivery");
  assert.equal(await h.store.sessionWatch(watch.id), undefined);
  await h.coordinator.close();
  await h.store.close();
});

test("canonical runtime completion wakes the caller through the real queue path", async (t) => {
  const h = harness();
  await seed(h.store, "target");
  const listeners = new Set<(id: string, event: RuntimeEvent) => void>();
  const emit = (id: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(id, event);
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: false }),
    models: async () => [], agents: async () => [],
    ensureSession: async (input) => `backend-${input.sessionId}`,
    sessions: async () => [], history: async () => [],
    startTurn: async (input) => { emit(input.sessionId, { type: "turn/started", turnId: "source-turn" }); },
    abort: async () => {}, replyPermission: async () => {}, replyQuestion: async () => {},
    onEvent(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    dispose: async () => {},
  };
  let notified: Promise<void> | undefined;
  const project = { id: "project-watch", name: "Watch", path: h.dir, spaceId: space.spaceId, createdAt: 1 };
  const sessions = createSessionService({
    store: h.store, queue: h.store,
    projects: {
      get: async (id) => id === project.id ? project : undefined,
      list: async () => [project], add: async () => project,
      create: async () => project, remove: async () => {},
    },
    permissions: { evaluate: () => "allow", addRule() {}, rules: () => [] } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    runtimes: { forProject: async () => runtime },
    notify: {
      attention() {},
      turnStopped(id) { notified = coordinator.kick(id); },
    },
  });
  const coordinator = createSessionWatchCoordinator({
    store: h.store, sessions: () => sessions, broadcast: { event() {} },
  });
  t.after(async () => {
    await coordinator.close();
    await h.coordinator.close();
    sessions.dispose();
    await h.store.close();
  });
  const blocking = await h.store.prepareOperation({
    sessionId: "target", mutationKind: "turn-submit",
    intentEvent: { type: "user/message", data: { text: "caller is still executing" } },
  });
  await h.store.claimOperation(blocking.operation.operationId);
  const source = await sessions.create({ projectId: project.id, title: "source" });
  const watch = await coordinator.create(space, { sourceSessionId: source.id, targetSessionId: "target" });
  await sessions.send(source.id, { text: "finish the delegated work" });
  emit(source.id, { type: "turn/stopped", reason: "completed", turnId: "source-turn" });
  for (let attempt = 0; !notified && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(notified, "canonical completion must kick the watcher without an explicit test kick");
  await notified;
  const queued = await h.store.queueList("target");
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.hiddenUserMessage, true);
  assert.match(queued[0]?.text ?? "", /completed successfully/);
  assert.equal((await h.store.sessionWatchStopsAfter(source.id, 0)).length, 1);
  assert.equal(await h.store.sessionWatch(watch.id), undefined);
});

test("a delegated child's wake tells its delegator how isolated work comes back", async () => {
  const h = harness();
  await seed(h.store, "orchestrator", "observer");
  await h.store.upsertProjection({ ...projection("delegate"), parentId: "orchestrator" });
  await h.coordinator.create(space, { sourceSessionId: "delegate", targetSessionId: "orchestrator" });
  await h.coordinator.create(space, { sourceSessionId: "delegate", targetSessionId: "observer" });

  await h.store.append("delegate", "turn/stopped", { reason: "completed", turnId: "turn-delegate" });
  await h.coordinator.kick("delegate");

  const text = new Map(h.sends.map((send) => [send.sessionId, send.input.text]));
  assert.match(text.get("orchestrator") ?? "", /agent\.merge/);
  assert.doesNotMatch(text.get("observer") ?? "", /agent\.merge/, "only the delegator owns the merge");

  await h.coordinator.close();
  await h.store.close();
});

test("a pause wakes the watcher as paused and keeps even a one-shot watch armed", async () => {
  const h = harness();
  await seed(h.store, "source", "target", "completions-only");
  const watch = await h.coordinator.create(space, { sourceSessionId: "source", targetSessionId: "target" });
  // A watch for completions alone does not hear of a pause.
  await h.coordinator.create(space, { sourceSessionId: "source", targetSessionId: "completions-only", events: ["completed"] });

  await h.store.append("source", "turn/stopped", { reason: "aborted", paused: true, turnId: "turn-source" });
  await h.coordinator.kick("source");
  assert.deepEqual(h.sends.map((send) => send.sessionId), ["target"]);
  assert.match(h.sends[0]!.input.text, /paused by a person/);
  assert.match(h.sends[0]!.input.text, /Result: paused/);
  assert.ok(await h.store.sessionWatch(watch.id), "a pause is not the end: the watch stays armed");

  // Continuing is not a stop; the continued turn's end is.
  await h.store.append("source", "session/pause-ended", { outcome: "continued" });
  await h.store.append("source", "turn/stopped", { reason: "completed", turnId: "turn-source-2" });
  await h.coordinator.kick("source");
  // Watches deliver concurrently: compare what each target got.
  const later = h.sends.slice(1);
  assert.deepEqual(later.map((send) => send.sessionId).sort(), ["completions-only", "target"]);
  for (const send of later) assert.match(send.input.text, /completed successfully/);
  assert.equal(await h.store.sessionWatch(watch.id), undefined);

  await h.coordinator.close();
  await h.store.close();
});

test("a pause the person ends with Stop reaches the watcher as aborted", async () => {
  const h = harness();
  await seed(h.store, "source", "target");
  const watch = await h.coordinator.create(space, { sourceSessionId: "source", targetSessionId: "target" });

  await h.store.append("source", "turn/stopped", { reason: "aborted", paused: true, turnId: "turn-source" });
  await h.coordinator.kick("source");
  await h.store.append("source", "session/pause-ended", { outcome: "stopped" });
  await h.coordinator.kick("source");

  assert.equal(h.sends.length, 2);
  assert.match(h.sends[1]!.input.text, /Result: was aborted/);
  assert.equal(await h.store.sessionWatch(watch.id), undefined);

  await h.coordinator.close();
  await h.store.close();
});

test("a wake into a paused session waits until its pause ends", async () => {
  const h = harness();
  await seed(h.store, "source");
  const paused = { ...projection("target"), paused: { at: 1, stopSeq: 1 } };
  await h.store.upsertProjection(paused);
  await h.coordinator.create(space, { sourceSessionId: "source", targetSessionId: "target" });

  await h.store.append("source", "turn/stopped", { reason: "completed", turnId: "turn-source" });
  await h.coordinator.kick("source");
  assert.equal(h.sends.length, 0, "the wake would continue a session a person paused");

  const { paused: _paused, ...continued } = paused;
  await h.store.upsertProjection(continued);
  await h.coordinator.kickTarget("target");
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0]!.input.text, /completed successfully/);

  await h.coordinator.close();
  await h.store.close();
});
