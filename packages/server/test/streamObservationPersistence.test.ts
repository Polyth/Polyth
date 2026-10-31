import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEvent,
  RuntimeObservation,
  PersistedRuntimeBinding,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Emit = (sessionId: string, event: RuntimeEvent) => void;
type Observe = (sessionId: string, observation: RuntimeObservation) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const observers = new Set<Observe>();
  const emit = (sessionId: string, event: RuntimeEvent): void => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const observe = (sessionId: string, observation: RuntimeObservation): void => {
    for (const observer of observers) observer(sessionId, observation);
  };
  const runtime: AgentRuntime = {
    harnessId: "fixture",
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
    onObservation(callback) {
      observers.add(callback);
      return { dispose: () => observers.delete(callback) };
    },
    dispose: async () => {},
  };
  return { runtime, observe };
}

const until = async (ready: () => Promise<boolean>, message: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
};

const streamObservation = (
  binding: PersistedRuntimeBinding,
  ordinal: number,
  revision: string,
  text: string,
): RuntimeObservation => ({
  channel: "sse",
  entityKey: "answer",
  identity: {
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId,
    artifactKind: "part",
    entityId: "answer",
    revision,
  },
  reconciliationOrdinal: ordinal,
  events: [{ type: "assistant/chunk", partId: "answer", text }],
  cursorAfter: revision,
});

const finalObservation = (
  binding: PersistedRuntimeBinding,
  ordinal: number,
): RuntimeObservation => ({
  channel: "sse",
  entityKey: "answer-message",
  identity: {
    authorityId: binding.authorityId,
    generation: binding.generation,
    location: binding.location,
    backendSessionId: binding.backendSessionId,
    artifactKind: "message",
    entityId: "answer-message",
    revision: "done",
  },
  reconciliationOrdinal: ordinal,
  events: [{ type: "assistant/message", partId: "answer", text: "abc" }],
  cursorAfter: "done",
});

test("stream observations share one durable transaction without merging canonical rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-observation-batch-"));
  const rawStore = createStore(join(dir, "sessions.db"));
  let ingestObservationCalls = 0;
  let ingestSnapshotCalls = 0;
  const store = new Proxy(rawStore, {
    get(target, property, receiver) {
      if (property === "ingestObservation") {
        return (...args: Parameters<typeof rawStore.ingestObservation>) => {
          ingestObservationCalls += 1;
          return rawStore.ingestObservation(...args);
        };
      }
      if (property === "ingestSnapshot") {
        return (...args: Parameters<typeof rawStore.ingestSnapshot>) => {
          ingestSnapshotCalls += 1;
          return rawStore.ingestSnapshot(...args);
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

  const { id } = await sessions.create({ projectId: project.id, title: "observation stream" });
  await sessions.send(id, { text: "go" });
  await until(
    async () => (await rawStore.events(id)).some((event) => event.type === "turn/started"),
    "turn did not start",
  );

  const projection = await rawStore.projection(id);
  assert.ok(projection?.runtimeBinding);
  const reconciliation = await rawStore.startReconciliation(id);
  const binding = projection.runtimeBinding;

  const snapshotBefore = ingestSnapshotCalls;
  const singleBefore = ingestObservationCalls;

  // First event after quiet publishes immediately. The next two remain inside
  // the 50ms window; the non-stream observation is their ordering barrier.
  fake.observe(id, streamObservation(binding, reconciliation.ordinal, "r1", "a"));
  await until(
    async () => (await rawStore.events(id)).some((event) =>
      event.type === "assistant/chunk" && (event.data as { text?: string }).text === "a"),
    "first stream observation did not ingest",
  );
  fake.observe(id, streamObservation(binding, reconciliation.ordinal, "r2", "b"));
  fake.observe(id, streamObservation(binding, reconciliation.ordinal, "r3", "c"));
  fake.observe(id, finalObservation(binding, reconciliation.ordinal));

  await until(
    async () => (await rawStore.events(id)).some((event) => event.type === "assistant/message"),
    "stream observation barrier did not ingest",
  );

  const relevant = (await rawStore.events(id))
    .filter((event) => event.type === "assistant/chunk" || event.type === "assistant/message")
    .map((event) => ({
      type: event.type,
      text: (event.data as { text?: string }).text,
      seq: event.seq,
    }));

  assert.deepEqual(relevant.map(({ type, text }) => ({ type, text })), [
    { type: "assistant/chunk", text: "a" },
    { type: "assistant/chunk", text: "b" },
    { type: "assistant/chunk", text: "c" },
    { type: "assistant/message", text: "abc" },
  ]);
  assert.deepEqual(
    relevant.map((event) => event.seq),
    [...relevant.map((event) => event.seq)].sort((left, right) => left - right),
    "canonical rows retain monotonic individual sequence numbers",
  );
  assert.ok(ingestSnapshotCalls > snapshotBefore, "sustained observations should share ingestSnapshot");
  assert.ok(
    ingestObservationCalls - singleBefore <= 2,
    "the first observation and the non-stream barrier may ingest individually",
  );
  assert.deepEqual(
    broadcasted.filter((type) => type === "assistant/chunk" || type === "assistant/message"),
    relevant.map((event) => event.type),
  );

  await rawStore.close();
});
