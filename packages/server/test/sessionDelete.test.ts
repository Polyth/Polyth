// UX-SHELL-CONSOLIDATION-02 finding 4/5: hard session delete through the
// guarded service path — durable log, projection, and queue are removed in
// one transaction; a running turn is aborted first and its stray turn/stopped
// can never be re-appended to the deleted log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEvent } from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const aborted: string[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => { emit(req.sessionId, { type: "turn/started", turnId: "t1" }); },
    abort: async (sessionId) => { aborted.push(sessionId); emit(sessionId, { type: "turn/stopped", reason: "aborted" }); },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, aborted };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeService(fake: ReturnType<typeof fakeRuntime>) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-delete-"));
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
    evaluate: () => "allow",
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

test("delete removes projection, events, and queued messages durably", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "hello" });
  await flush();
  fake.emit(id, { type: "assistant/message", partId: "a1", text: "hi" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await store.enqueue(id, "queued follow-up", "queue");
  assert.ok((await store.events(id)).length > 0);

  await sessions.delete!(id);

  assert.equal(await store.projection(id), undefined);
  assert.deepEqual(await store.events(id), []);
  assert.deepEqual(await store.queueList(id), []);
  assert.deepEqual(await sessions.list("p1"), []);
});

test("delete of a running session aborts first and leaves no resurrected events", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "long task" });
  await flush();
  assert.equal((await store.projection(id))?.status, "working");

  await sessions.delete!(id);
  await flush(); // any stray turn/stopped dispatch would land here

  assert.deepEqual(fake.aborted, [id]);
  assert.equal(await store.projection(id), undefined);
  // The abort's turn/stopped must not re-append to the deleted log.
  assert.deepEqual(await store.events(id), []);
});

test("delete of an unknown session is a typed not-found", async () => {
  const fake = fakeRuntime();
  const { sessions } = makeService(fake);
  await assert.rejects(sessions.delete!("nope"), (err: Error & { code?: string }) => {
    assert.equal(err.code, "not-found");
    return true;
  });
});
