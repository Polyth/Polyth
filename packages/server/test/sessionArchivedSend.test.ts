// An archived session runs no further turn. The composer blocks behind an
// explicit restore, but agents, API clients and old shells reach `send`
// directly, so the service itself refuses every delivery mode instead of
// running a turn that the archived projection would hide.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEvent } from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

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

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function makeService(t: TestContext) {
  const listeners = new Set<Emit>();
  const started: string[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: true,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      started.push(req.sessionId);
      emit(req.sessionId, { type: "turn/started", turnId: `t${started.length}` });
    },
    abort: async (sessionId) => { emit(sessionId, { type: "turn/stopped", reason: "aborted" }); },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  const dir = tempDir(join(tmpdir(), "polyth-archived-send-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = { evaluate: () => "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => rt },
  });
  t.after(async () => {
    sessions.dispose();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { sessions, store, emit, started };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test("send to an archived session is refused in every delivery mode and starts no turn", async (t) => {
  const { sessions, store, emit, started } = makeService(t);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "first" });
  await flush();
  emit(id, { type: "assistant/message", partId: "a1", text: "done" });
  emit(id, { type: "turn/stopped", turnId: "t1", reason: "completed" });
  await flush();
  assert.equal((await store.projection(id))?.status, "idle");
  const startedBeforeArchive = started.length;
  await sessions.archive(id);
  const before = (await store.events(id)).length;

  for (const delivery of [undefined, "queue", "steer", "interrupt"] as const) {
    await assert.rejects(
      sessions.send(id, { text: `after archive (${delivery ?? "default"})`, ...(delivery ? { delivery } : {}) }),
      (error: { code?: string; message?: string }) =>
        error.code === "conflict" && /archived/.test(error.message ?? ""),
    );
  }
  await flush();

  assert.equal(started.length, startedBeforeArchive, "no turn reached the runtime");
  assert.equal((await store.projection(id))?.status, "archived");
  assert.deepEqual(await store.queueList(id), [], "nothing waits to run on restore");
  assert.equal((await store.events(id)).length, before, "the log took no user message or turn");
});

test("a restored session takes messages again", async (t) => {
  const { sessions, started } = makeService(t);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.archive(id);
  await assert.rejects(sessions.send(id, { text: "while archived" }), { code: "conflict" });
  await sessions.restore(id);
  await sessions.send(id, { text: "after restore" });
  await flush();
  assert.equal(started.length, 1);
});
