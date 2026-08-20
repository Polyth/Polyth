// WP3: active-turn delivery admission, durable FIFO queue, steer fallback,
// and send-time question/permission arbitration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, JsonObject, Project, ProjectService, RuntimeEvent,
} from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime(opts: { steering?: boolean; steerResult?: boolean } = {}) {
  const listeners = new Set<Emit>();
  const startedTexts: string[] = [];
  const steeredTexts: string[] = [];
  const permissionReplies: Array<{ requestId: string; reply: string }> = [];
  const questionReplies: Array<{ requestId: string; answers: JsonObject }> = [];
  let aborted = 0;
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
      steering: opts.steering ?? false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      startedTexts.push(req.text);
      emit(req.sessionId, { type: "turn/started", turnId: `t${startedTexts.length}` });
    },
    ...(opts.steering
      ? {
          steer: async (_sessionId: string, text: string) => {
            if (opts.steerResult === false) return false;
            steeredTexts.push(text);
            return true;
          },
        }
      : {}),
    abort: async (sessionId) => {
      aborted += 1;
      emit(sessionId, { type: "turn/stopped", reason: "aborted" });
    },
    replyPermission: async (_s, requestId, reply) => { permissionReplies.push({ requestId, reply }); },
    replyQuestion: async (_s, requestId, answers) => { questionReplies.push({ requestId, answers }); },
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return {
    rt, emit, startedTexts, steeredTexts, permissionReplies, questionReplies,
    get aborted() { return aborted; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeService(fake: ReturnType<typeof fakeRuntime>) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-delivery-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "ask",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => fake.rt },
  });
  return { sessions, store };
}

test("idle send starts a normal turn; active send queues; FIFO dispatch on stop", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  const r1 = await sessions.send(id, { text: "first" });
  assert.ok(r1.turnId);
  await flush();
  assert.deepEqual(fake.startedTexts, ["first"]);

  // active turn: queue two follow-ups
  const q1 = await sessions.send(id, { text: "second", delivery: "queue" });
  const q2 = await sessions.send(id, { text: "third", delivery: "queue" });
  assert.ok(q1.queued && q1.queueId);
  assert.ok(q2.queued && q2.queueId);
  assert.deepEqual(fake.startedTexts, ["first"]); // nothing entered the stream

  // turn completes -> head dispatches; next dispatch after the next stop
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["first", "second"]);
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake.startedTexts, ["first", "second", "third"]);

  // durable event order: queue/enqueued before queue/dispatched before user/message
  const evs = await store.events(id);
  const types = evs.map((e) => e.type);
  const enq = types.indexOf("queue/enqueued");
  const disp = types.indexOf("queue/dispatched");
  assert.ok(enq >= 0 && disp > enq, `expected enqueue before dispatch: ${types.join(",")}`);
  await store.close();
});

test("normal send racing an active turn falls back to queue with reason", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "first" });
  await flush();
  const res = await sessions.send(id, { text: "race" }); // no delivery flag
  assert.ok(res.queued);
  const evs = await store.events(id);
  const fb = evs.find((e) => e.type === "delivery/fallback-queued");
  assert.equal((fb?.data as { reason?: string }).reason, "turn-active");
  await store.close();
});

test("steer delivers into the active turn and logs delivery/steered before user/message", async () => {
  const fake = fakeRuntime({ steering: true });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "start" });
  await flush();
  const res = await sessions.send(id, { text: "go left", delivery: "steer" });
  assert.ok(res.turnId);
  assert.deepEqual(fake.steeredTexts, ["go left"]);
  const evs = await store.events(id);
  const types = evs.map((e) => e.type);
  const steered = types.indexOf("delivery/steered");
  const um = types.lastIndexOf("user/message");
  assert.ok(steered >= 0 && um > steered);
  await store.close();
});

test("unsupported/rejected steer falls back to queue", async () => {
  // runtime without steering capability
  const noCap = fakeRuntime({ steering: false });
  const a = makeService(noCap);
  const s1 = await a.sessions.create({ projectId: "p1", title: "T" });
  await a.sessions.send(s1.id, { text: "start" });
  await flush();
  const r1 = await a.sessions.send(s1.id, { text: "steer me", delivery: "steer" });
  assert.ok(r1.queued);
  let evs = await a.store.events(s1.id);
  assert.equal(
    (evs.find((e) => e.type === "delivery/fallback-queued")?.data as { reason?: string }).reason,
    "steer-unsupported",
  );
  await a.store.close();

  // runtime that claims steering but rejects the call
  const rejects = fakeRuntime({ steering: true, steerResult: false });
  const b = makeService(rejects);
  const s2 = await b.sessions.create({ projectId: "p1", title: "T" });
  await b.sessions.send(s2.id, { text: "start" });
  await flush();
  const r2 = await b.sessions.send(s2.id, { text: "steer me", delivery: "steer" });
  assert.ok(r2.queued);
  evs = await b.store.events(s2.id);
  assert.equal(
    (evs.find((e) => e.type === "delivery/fallback-queued")?.data as { reason?: string }).reason,
    "steer-rejected",
  );
  // no dangling user/message for the failed steer
  const userMsgs = evs.filter((e) => e.type === "user/message");
  assert.equal(userMsgs.length, 1);
  await b.store.close();
});

test("interrupt aborts the active turn and its message dispatches first", async () => {
  const fake = fakeRuntime();
  const { sessions } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "long job" });
  await flush();
  await sessions.send(id, { text: "already queued", delivery: "queue" });
  const res = await sessions.send(id, { text: "urgent", delivery: "interrupt" });
  assert.ok(res.queued);
  await flush();
  assert.equal(fake.aborted, 1);
  // abort triggered dispatch: urgent runs before the earlier queued item
  assert.deepEqual(fake.startedTexts, ["long job", "urgent"]);
});

test("dismissPending rejects open questions and denies open permissions before send", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "start" });
  await flush();
  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "fs/write", patterns: ["*"] });
  fake.emit(id, { type: "question/asked", requestId: "que_1", questions: [{ prompt: "pick" }] });
  await flush();

  await sessions.send(id, { text: "never mind, do this", delivery: "queue", dismissPending: true });
  await flush();

  assert.deepEqual(fake.permissionReplies.filter((p) => p.requestId === "per_1").map((p) => p.reply), ["reject"]);
  assert.equal(fake.questionReplies.some((q) => q.requestId === "que_1"), true);

  const evs = await store.events(id);
  const types = evs.map((e) => e.type);
  // resolution events precede the queue event atomically
  const resolved = types.indexOf("permission/resolved");
  const answered = types.indexOf("question/answered");
  const enq = types.lastIndexOf("queue/enqueued");
  assert.ok(resolved >= 0 && resolved < enq);
  assert.ok(answered >= 0 && answered < enq);
  await store.close();
});

test("queue order survives service restart and dispatches after reopen", async () => {
  const fake = fakeRuntime();
  const dir = mkdtempSync(join(tmpdir(), "polyth-restart-"));
  const dbPath = join(dir, "s.db");
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project], get: async () => project,
    add: async () => project, create: async () => project, remove: async () => {},
  };
  const permissions = { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };

  let sessionId = "";
  {
    const store = createStore(dbPath);
    const sessions = createSessionService({
      store, projects, permissions, broadcast, queue: store,
      runtimes: { forProject: async () => fake.rt },
    });
    const ref = await sessions.create({ projectId: "p1", title: "T" });
    sessionId = ref.id;
    await sessions.send(sessionId, { text: "turn" });
    await flush();
    await sessions.send(sessionId, { text: "q-a", delivery: "queue" });
    await sessions.send(sessionId, { text: "q-b", delivery: "queue" });
    await store.close();
  }
  // restart: new store + service over the same DB; opening the session drains FIFO
  const fake2 = fakeRuntime();
  const store2 = createStore(dbPath);
  const sessions2 = createSessionService({
    store: store2, projects, permissions, broadcast, queue: store2,
    runtimes: { forProject: async () => fake2.rt },
  });
  const queued = await sessions2.queueList!(sessionId);
  assert.deepEqual(queued.map((q) => q.text), ["q-a", "q-b"]);
  await sessions2.events(sessionId, 0); // session open triggers dispatch
  await flush();
  assert.deepEqual(fake2.startedTexts, ["q-a"]);
  fake2.emit(sessionId, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.deepEqual(fake2.startedTexts, ["q-a", "q-b"]);
  await store2.close();
});

test("queue reorder validates permutations and remove is session-scoped", async () => {
  const fake = fakeRuntime();
  const { sessions } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "turn" });
  await flush();
  const a = await sessions.send(id, { text: "a", delivery: "queue" });
  const b = await sessions.send(id, { text: "b", delivery: "queue" });
  await assert.rejects(() => sessions.queueReorder!(id, [a.queueId!]), /permutation/);
  const reordered = await sessions.queueReorder!(id, [b.queueId!, a.queueId!]);
  assert.deepEqual(reordered.map((i) => i.text), ["b", "a"]);
  await sessions.queueRemove!(id, b.queueId!);
  assert.deepEqual((await sessions.queueList!(id)).map((i) => i.text), ["a"]);
  await assert.rejects(() => sessions.queueRemove!(id, "nope"), /not found/);
});
