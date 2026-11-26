// A turn that ends `completed` with an incomplete answer (nothing said and no
// tool run, or the model's output limit) is recorded as `turn/incomplete` and
// continued once, hidden, with a deterministic operation id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEndpoint, RuntimeEvent,
  RuntimeObservation, RuntimeSessionBinding, RuntimeSnapshot,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

import { after } from "node:test";
import { rmSync } from "node:fs";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  attempts = 200,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await flush(10);
  }
  throw new Error("condition was not reached");
};

const harness = (options: { autoContinueIncomplete?: boolean } = {}) => {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const observers = new Set<(sessionId: string, observation: RuntimeObservation) => void>();
  const startedTexts: string[] = [];
  const aborted: string[] = [];
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  const endpoint: RuntimeEndpoint = {
    authorityId: "fake-runtime",
    continuity: "verified",
    generation: 1,
    url: "http://fake.invalid",
    location: { directory: "/fake" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const runtime: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (canonical) => `be_${canonical.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      startedTexts.push(request.text);
      emit(request.sessionId, { type: "turn/started", turnId: `t${startedTexts.length}` });
    },
    abort: async (sessionId) => {
      aborted.push(sessionId);
      emit(sessionId, { type: "turn/stopped", reason: "aborted" });
    },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    endpoint: async () => endpoint,
    reconcile: async (binding: RuntimeSessionBinding & { reconciliationOrdinal?: number }): Promise<RuntimeSnapshot> => ({
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId!,
      reconciliationOrdinal: binding.reconciliationOrdinal ?? 1,
      state: { value: "idle", watermark: "1", comparison: { domain: "test", order: 1 } },
      completeness: { events: "partial", permissions: "partial", questions: "partial" },
      permissions: [],
      questions: [],
      events: [],
    }),
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

  const dir = tempDir(join(tmpdir(), "polyth-tool-timeout-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", spaceId: "space-a", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "ask", addRule: () => {}, rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => runtime },
    ...(options.autoContinueIncomplete === undefined ? {} : { autoContinueIncomplete: options.autoContinueIncomplete }),
  });
  return { sessions, store, emit, startedTexts, aborted, observers, endpoint, dir, runtime };
};

const teardown = async (h: ReturnType<typeof harness>) => {
  h.sessions.dispose();
  await h.store.close();
  rmSync(h.dir, { recursive: true, force: true });
};

const CONTINUE_TEXT = "Your previous answer ended before it was complete. Continue from where you stopped without repeating what you already wrote.";
const operationId = (sessionId: string, turnId: string) => {
  const hex = createHash("sha256").update(sessionId + turnId + "incomplete-continue").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const incompletes = async (store: ReturnType<typeof createStore>, id: string) =>
  (await store.events(id)).filter((event) => event.type === "turn/incomplete");
const continuations = async (store: ReturnType<typeof createStore>, id: string) =>
  (await store.events(id)).filter((event) => event.type === "user/message"
    && (event.data as { text?: unknown }).text === CONTINUE_TEXT);

test("an empty completed turn is recorded, then continued once with a stable operation id", async (t) => {
  const h = harness();
  t.after(() => teardown(h));
  const { id } = await h.sessions.create({ projectId: "p1", title: "Empty" });
  await h.sessions.send(id, { text: "hello" });
  h.emit(id, { type: "turn/stopped", turnId: "t1", reason: "completed" });
  await waitFor(async () => (await continuations(h.store, id)).length === 1);
  const facts = await incompletes(h.store, id);
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0]!.data, { turnId: "t1", kind: "empty", autoContinued: true });
  const [message] = await continuations(h.store, id);
  assert.ok(facts[0]!.seq < message!.seq, "the fact is durable before the continuation");
  assert.equal((message!.data as { hiddenUserMessage?: unknown }).hiddenUserMessage, true);
  assert.deepEqual(h.startedTexts.slice(-1), [CONTINUE_TEXT]);
  // A retry of the same continuation resolves to the admitted one.
  const started = h.startedTexts.length;
  await h.sessions.send(id, { text: CONTINUE_TEXT, delivery: "normal", hiddenUserMessage: true, clientOperationId: operationId(id, "t1") });
  await flush(60);
  assert.equal(h.startedTexts.length, started);
  assert.equal((await continuations(h.store, id)).length, 1);
});

test("a reasoning-only turn counts as empty", async (t) => {
  const h = harness();
  t.after(() => teardown(h));
  const { id } = await h.sessions.create({ projectId: "p1", title: "Reasoning" });
  await h.sessions.send(id, { text: "hello" });
  h.emit(id, { type: "assistant/message", partId: "r1", text: "", reasoning: "thinking about it" });
  h.emit(id, { type: "turn/stopped", turnId: "t1", reason: "completed" });
  await waitFor(async () => (await continuations(h.store, id)).length === 1);
  assert.equal((await incompletes(h.store, id))[0]!.data.kind, "empty");
});

test("a tool-only turn is not empty", async (t) => {
  const h = harness();
  t.after(() => teardown(h));
  const { id } = await h.sessions.create({ projectId: "p1", title: "Tools" });
  await h.sessions.send(id, { text: "hello" });
  h.emit(id, { type: "tool/started", callId: "c1", tool: "bash", input: {} });
  h.emit(id, { type: "tool/result", callId: "c1", tool: "bash", output: "ok" } as RuntimeEvent);
  h.emit(id, { type: "turn/stopped", turnId: "t1", reason: "completed" });
  await flush(120);
  assert.equal((await incompletes(h.store, id)).length, 0);
  assert.equal((await continuations(h.store, id)).length, 0);
});

test("aborted and error stops are never incomplete", async (t) => {
  const h = harness();
  t.after(() => teardown(h));
  const { id } = await h.sessions.create({ projectId: "p1", title: "Aborted" });
  await h.sessions.send(id, { text: "hello" });
  h.emit(id, { type: "turn/stopped", turnId: "t1", reason: "aborted" });
  await flush(120);
  const other = await h.sessions.create({ projectId: "p1", title: "Error" });
  await h.sessions.send(other.id, { text: "hello" });
  h.emit(other.id, { type: "turn/stopped", turnId: "t1", reason: "error", error: "boom", code: "unknown" });
  await flush(120);
  for (const sessionId of [id, other.id]) {
    assert.equal((await incompletes(h.store, sessionId)).length, 0);
    assert.equal((await continuations(h.store, sessionId)).length, 0);
  }
});

test("the output limit is a length kind even with text; a second incomplete only records the fact", async (t) => {
  const h = harness();
  t.after(() => teardown(h));
  const { id } = await h.sessions.create({ projectId: "p1", title: "Length" });
  await h.sessions.send(id, { text: "write a lot" });
  h.emit(id, { type: "assistant/message", partId: "a1", text: "partial answer" });
  h.emit(id, { type: "turn/stopped", turnId: "t1", reason: "completed", outputLimit: true });
  await waitFor(async () => (await continuations(h.store, id)).length === 1);
  assert.deepEqual((await incompletes(h.store, id))[0]!.data, { turnId: "t1", kind: "length", autoContinued: true });
  h.emit(id, { type: "turn/stopped", turnId: "t2", reason: "completed" });
  await waitFor(async () => (await incompletes(h.store, id)).length === 2);
  assert.deepEqual((await incompletes(h.store, id))[1]!.data, { turnId: "t2", kind: "empty", autoContinued: false });
  await flush(120);
  assert.equal((await continuations(h.store, id)).length, 1, "no second continuation");
});

test("with autoContinueIncomplete off only the fact is kept", async (t) => {
  const h = harness({ autoContinueIncomplete: false });
  t.after(() => teardown(h));
  const { id } = await h.sessions.create({ projectId: "p1", title: "Off" });
  await h.sessions.send(id, { text: "hello" });
  h.emit(id, { type: "turn/stopped", turnId: "t1", reason: "completed" });
  await waitFor(async () => (await incompletes(h.store, id)).length === 1);
  assert.deepEqual((await incompletes(h.store, id))[0]!.data, { turnId: "t1", kind: "empty", autoContinued: false });
  await flush(120);
  assert.equal((await continuations(h.store, id)).length, 0);
});

test("a paused stop records nothing", async (t) => {
  const h = harness();
  t.after(() => teardown(h));
  const { id } = await h.sessions.create({ projectId: "p1", title: "Paused" });
  await h.sessions.send(id, { text: "hello" });
  await h.sessions.pause(id);
  await flush(120);
  assert.equal((await incompletes(h.store, id)).length, 0);
  assert.equal((await continuations(h.store, id)).length, 0);
});
