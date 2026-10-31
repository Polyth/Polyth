import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, CanonicalTurnRequest, ProjectService, RuntimeEvent } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../src/sessions.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition was not met");
    await sleep(10);
  }
};

function fixture() {
  const store = createStore(":memory:");
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  let turns = 0;
  const emit = (sessionId: string, event: RuntimeEvent) => { for (const listener of listeners) listener(sessionId, event); };
  const runtime: AgentRuntime = {
    harnessId: "fake",
    capabilities: async () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }),
    commands: async () => [],
    models: async () => [],
    agents: async () => [],
    ensureSession: async ({ sessionId }) => `native-${sessionId}`,
    sessions: async () => [],
    history: async () => [],
    async startTurn(request: CanonicalTurnRequest) {
      emit(request.sessionId, { type: "turn/started", turnId: `turn-${++turns}` });
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    dispose: async () => {},
  };
  const projects = {
    get: async (id: string) => id === "p" ? { id: "p", name: "p", path: "/tmp", spaceId: "space", createdAt: 0 } : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const stops: string[] = [];
  const completions: string[] = [];
  const sessions = createSessionService({
    store,
    projects,
    runtimes: { forProject: async () => runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    notify: { attention() {}, turnStopped(sessionId, reason) { stops.push(`${sessionId}:${reason}`); } },
    hooks: { onTurnCompleted(sessionId, text) { completions.push(`${sessionId}:${text}`); } },
  });
  const finish = async (sessionId: string, text: string) => {
    emit(sessionId, { type: "assistant/message", partId: `p-${turns}`, text });
    emit(sessionId, { type: "turn/stopped", turnId: `turn-${turns}`, reason: "completed" });
    await waitUntil(async () => (await store.projection(sessionId))?.status === "idle");
  };
  return { store, sessions, stops, completions, finish };
}

test("a keep-alive turn is maintenance: hidden, silent and not the latest turn", async () => {
  const f = fixture();
  const session = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(session.id, { text: "real work" });
  await f.finish(session.id, "done");
  await waitUntil(() => f.completions.length === 1);
  const lastTurnAt = (await f.store.projection(session.id))?.lastTurnAt;
  assert.ok(lastTurnAt);

  await sleep(5);
  await f.sessions.send(session.id, { text: "keep-alive", keepAlive: true });
  await f.finish(session.id, "OK");
  await sleep(30);
  const message = (await f.store.events(session.id)).findLast((event) => event.type === "user/message");
  assert.equal((message?.data as { keepAlive?: unknown }).keepAlive, true);
  assert.equal((message?.data as { hiddenUserMessage?: unknown }).hiddenUserMessage, true);
  assert.deepEqual(f.stops, [`${session.id}:completed`], "no notification for the keep-alive");
  assert.deepEqual(f.completions, [`${session.id}:done`], "no completion hooks for the keep-alive");
  assert.equal((await f.store.projection(session.id))?.lastTurnAt, lastTurnAt);

  // The next real turn notifies again.
  await f.sessions.send(session.id, { text: "more work" });
  await f.finish(session.id, "more");
  await waitUntil(() => f.completions.length === 2);
  assert.equal(f.stops.length, 2);
  await f.store.close();
});

test("a keep-alive is refused for a busy session instead of being queued", async () => {
  const f = fixture();
  const session = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(session.id, { text: "long work" });
  await waitUntil(async () => (await f.store.projection(session.id))?.status === "working");
  await assert.rejects(f.sessions.send(session.id, { text: "keep-alive", keepAlive: true }), { code: "conflict" });
  assert.equal((await f.store.events(session.id)).filter((event) => event.type === "user/message").length, 1);
  await f.finish(session.id, "done");
  await f.store.close();
});
