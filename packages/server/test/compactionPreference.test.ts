import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, CanonicalTurnRequest, ProjectService, RuntimeEvent } from "@polyth/contracts";
import type { CompactionPreference } from "@polyth/contracts/compaction-policy";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../src/sessions.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("condition was not met");
};

function fixture(options: { personDefault?: CompactionPreference } = {}) {
  const store = createStore(":memory:");
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const requests: CanonicalTurnRequest[] = [];
  const switches: boolean[] = [];
  let compactCalls = 0;
  let compactResult: Awaited<ReturnType<NonNullable<AgentRuntime["compactOperation"]>>> = { kind: "confirmed", value: { completion: "pending" } };
  const runtime: AgentRuntime = {
    harnessId: "fake",
    capabilities: async () => ({ streaming: true, permissions: false, questions: false, compaction: true, subagents: false, autoCompactionSwitch: true }),
    commands: async () => [],
    models: async () => [],
    agents: async () => [],
    ensureSession: async ({ sessionId }) => `native-${sessionId}`,
    sessions: async () => [],
    history: async () => [],
    async startTurn(request) {
      requests.push(request);
      for (const listener of listeners) listener(request.sessionId, { type: "turn/started", turnId: `turn-${requests.length}` });
    },
    abort: async () => {},
    setAutoCompaction: async (_sessionId, enabled) => { switches.push(enabled); },
    compactOperation: async () => { compactCalls += 1; return compactResult; },
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
  const sessions = createSessionService({
    store,
    projects,
    runtimes: { forProject: async () => runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    ...(options.personDefault ? { compactionDefault: (userId: string | undefined) => userId === "u1" ? options.personDefault : undefined } : {}),
  });
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  /** One finished turn that leaves the window at `fraction`. */
  const finishedTurn = async (sessionId: string, fraction: number, admission?: Parameters<typeof sessions.send>[2]) => {
    await sessions.send(sessionId, { text: "fill context" }, admission);
    emit(sessionId, { type: "context/updated", source: "native", updatedAt: Date.now(), usedTokens: fraction * 200_000, limitTokens: 200_000, fraction });
    emit(sessionId, { type: "turn/stopped", reason: "completed" });
    await flush();
  };
  return {
    store,
    sessions,
    emit,
    requests,
    switches,
    finishedTurn,
    compactCalls: () => compactCalls,
    resolveCompactWith(result: typeof compactResult) { compactResult = result; },
  };
}

test("earlier compacts before the next message, then sends it on the smaller context", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.setCompactionPreference!(id, { mode: "earlier" });
  await f.finishedTurn(id, 0.7);

  const sent = await f.sessions.send(id, { text: "next" });
  assert.equal(sent.queued, true, "the message waits for the compaction");
  await waitUntil(() => f.compactCalls() === 1);
  assert.equal(f.requests.length, 1, "nothing reaches the runtime while it compacts");

  f.emit(id, { type: "session/compacted" });
  await waitUntil(() => f.requests.length === 2);
  assert.equal(f.requests[1]?.text.endsWith("next"), true);
  const marker = (await f.store.events(id)).findLast((event) => event.type === "session/compacted");
  assert.equal(marker?.data.contextFraction, 0.7, "the marker can say how full the memory was");
  await f.store.close();
});

test("auto never spends a summary request, however full the window is", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.finishedTurn(id, 0.95);
  const sent = await f.sessions.send(id, { text: "next" });
  assert.notEqual(sent.queued, true);
  assert.equal(f.compactCalls(), 0);
  assert.equal(f.requests.length, 2);
  await f.store.close();
});

test("earlier waits for the threshold and needs a measured window", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.setCompactionPreference!(id, { mode: "earlier" });
  await f.sessions.send(id, { text: "unmeasured" });
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await f.sessions.send(id, { text: "still unmeasured" });
  assert.equal(f.compactCalls(), 0);
  f.emit(id, { type: "context/updated", source: "native", updatedAt: Date.now(), usedTokens: 100_000, limitTokens: 200_000, fraction: 0.5 });
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await f.sessions.send(id, { text: "below the line" });
  assert.equal(f.compactCalls(), 0);
  assert.equal(f.requests.length, 3);
  await f.store.close();
});

test("a failed compaction never blocks the message and is not repeated on the next one", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.setCompactionPreference!(id, { mode: "earlier" });
  await f.finishedTurn(id, 0.7);
  f.resolveCompactWith({ kind: "rejected", code: "native-failure", message: "no" });

  await f.sessions.send(id, { text: "second" });
  await waitUntil(() => f.requests.length === 2);
  assert.equal(f.compactCalls(), 1);
  f.emit(id, { type: "context/updated", source: "native", updatedAt: Date.now(), usedTokens: 142_000, limitTokens: 200_000, fraction: 0.71 });
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  await f.sessions.send(id, { text: "third" });
  assert.equal(f.compactCalls(), 1, "the same conversation does not pay for a second failure");
  assert.equal(f.requests.length, 3);

  f.emit(id, { type: "context/updated", source: "native", updatedAt: Date.now(), usedTokens: 160_000, limitTokens: 200_000, fraction: 0.8 });
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await f.sessions.send(id, { text: "fourth" });
  await waitUntil(() => f.compactCalls() === 2);
  await f.store.close();
});

test("a message queued behind a running turn is compacted for too", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.setCompactionPreference!(id, { mode: "earlier" });
  await f.sessions.send(id, { text: "long turn" });
  const queued = await f.sessions.send(id, { text: "behind it", delivery: "queue" });
  assert.equal(queued.queued, true);
  f.emit(id, { type: "context/updated", source: "native", updatedAt: Date.now(), usedTokens: 140_000, limitTokens: 200_000, fraction: 0.7 });
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await waitUntil(() => f.compactCalls() === 1);
  assert.equal(f.requests.length, 1);
  f.emit(id, { type: "session/compacted" });
  await waitUntil(() => f.requests.length === 2);
  assert.equal(f.requests[1]?.text.endsWith("behind it"), true);
  await f.store.close();
});

test("a keep-alive never triggers it", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.setCompactionPreference!(id, { mode: "earlier" });
  await f.finishedTurn(id, 0.7);
  await f.sessions.send(id, { text: "ping", keepAlive: true });
  assert.equal(f.compactCalls(), 0);
  await f.store.close();
});

test("the person's default reaches their own chats, not delegated workers or package threads", async () => {
  const f = fixture({ personDefault: { mode: "earlier" } });
  const admission = { author: { userId: "u1" } };
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.finishedTurn(id, 0.7, admission);
  await f.sessions.send(id, { text: "next" }, admission);
  await waitUntil(() => f.compactCalls() === 1);
  f.emit(id, { type: "session/compacted" });
  await waitUntil(() => f.requests.length === 2);
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  const child = await f.sessions.create({ projectId: "p", title: "C", parentId: id });
  await f.finishedTurn(child.id, 0.7, admission);
  await f.sessions.send(child.id, { text: "next" }, admission);
  assert.equal(f.compactCalls(), 1, "a worker follows only a choice made on it");
  await f.store.close();
});

test("the chat's own choice overrides the default, and null returns to it", async () => {
  const f = fixture({ personDefault: { mode: "earlier" } });
  const admission = { author: { userId: "u1" } };
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  assert.deepEqual(await f.sessions.setCompactionPreference!(id, { mode: "auto" }), { preference: { mode: "auto" } });
  assert.deepEqual((await f.store.projection(id))?.compactionPreference, { mode: "auto" });
  await f.finishedTurn(id, 0.7, admission);
  await f.sessions.send(id, { text: "stays" }, admission);
  assert.equal(f.compactCalls(), 0);
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  assert.deepEqual(await f.sessions.setCompactionPreference!(id, null), { preference: null });
  assert.equal((await f.store.projection(id))?.compactionPreference, undefined);
  await f.sessions.send(id, { text: "follows the default" }, admission);
  await waitUntil(() => f.compactCalls() === 1);
  await f.store.close();
});

test("manual switches the harness's compaction off before each turn and on when it is left", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, { text: "default" });
  assert.deepEqual(f.switches, [true]);
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  await f.sessions.setCompactionPreference!(id, { mode: "manual" });
  assert.equal(f.switches.at(-1), false, "a live runtime hears it at once, mid-turn included");
  await f.sessions.send(id, { text: "by hand" });
  assert.equal(f.switches.at(-1), false);
  f.emit(id, { type: "context/updated", source: "native", updatedAt: Date.now(), usedTokens: 190_000, limitTokens: 200_000, fraction: 0.95 });
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await f.sessions.send(id, { text: "still by hand" });
  assert.equal(f.compactCalls(), 0, "manual means only the person compacts");
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  await f.sessions.setCompactionPreference!(id, null);
  assert.equal(f.switches.at(-1), true);
  await f.store.close();
});

test("a chat refused for being full stays idle, so compacting it stays possible", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.setCompactionPreference!(id, { mode: "manual" });
  await f.sessions.send(id, { text: "too much" });
  f.emit(id, { type: "turn/stopped", reason: "error", code: "context-full", error: "Prompt is too long" });
  await flush();
  assert.equal((await f.store.projection(id))?.status, "idle");
  await f.sessions.compact!(id);
  assert.equal(f.compactCalls(), 1);

  const { id: other } = await f.sessions.create({ projectId: "p", title: "Other" });
  await f.sessions.send(other, { text: "hello" });
  f.emit(other, { type: "turn/stopped", reason: "error", code: "unknown", error: "boom" });
  await flush();
  assert.equal((await f.store.projection(other))?.status, "failed", "any other unanswered failure stays a failure");
  await f.store.close();
});

test("an invalid choice is refused and a valid one does not reorder the chat list", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    () => f.sessions.setCompactionPreference!(id, { mode: "later" } as unknown as CompactionPreference),
    /invalid compaction preference/,
  );
  const before = (await f.store.projection(id))!.updatedAt;
  await flush();
  await f.sessions.setCompactionPreference!(id, { mode: "custom", percent: 73 });
  const after = (await f.store.projection(id))!;
  assert.equal(after.updatedAt, before);
  assert.deepEqual(after.compactionPreference, { mode: "custom", percent: 75 });
  await f.store.close();
});
