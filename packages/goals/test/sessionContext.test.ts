import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { createStore } from "@polyth/session";
import { createGoalContextReader, latestGoalEvent } from "../src/sessionContext.ts";
import { createGoalService, type GoalState } from "../src/index.ts";
import { emptyModel, reduceEvent } from "../../../apps/web/src/reduce.ts";

const row = (id: string, patch: Partial<SessionProjection> = {}): SessionProjection => ({
  id, spaceId: "space-goals", projectId: "project-goals", title: id, status: "idle", createdAt: 1, updatedAt: 1, ...patch,
});

async function harness(t: test.TestContext) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const goals = new Map<string, GoalState>();
  const queue = new Set<string>();
  const reader = createGoalContextReader({
    store,
    admit: async (id) => {
      const projection = await store.projection(id);
      if (!projection) throw new Error("not found");
      return projection;
    },
    goal: async (id) => goals.get(id) ?? null,
    queued: async (id) => queue.has(id),
  });
  await store.upsertProjection(row("parent"));
  await store.append("parent", "user/message", { text: "Ship the feature" });
  await store.append("parent", "turn/started", { turnId: "parent-turn" });
  await store.append("parent", "assistant/message", { text: "Waiting for implementation and verification" });
  await store.append("parent", "turn/stopped", { turnId: "parent-turn", reason: "completed" }, { ignorable: true });
  return { store, goals, queue, reader };
}

test("canonical descendants include nested workers, ignore forks and stay in their Space/project", async (t) => {
  const { store, reader } = await harness(t);
  for (const projection of [
    row("worker", { parentId: "parent" }),
    row("grandchild", { parentId: "worker", status: "working" }),
    row("fork", { parentId: "parent", status: "working" }),
    row("fork-worker", { parentId: "fork", status: "working" }),
    row("foreign", { parentId: "parent", spaceId: "valid-foreign-space", status: "working" }),
    row("other-project", { parentId: "parent", projectId: "valid-other-project", status: "working" }),
  ]) await store.upsertProjection(projection);
  await store.append("fork", "session/forked", { fromSessionId: "parent" }, { ignorable: true });
  await store.append("worker", "user/message", { text: "Implement the feature" });
  await store.append("worker", "assistant/message", { text: "Implemented and checked" });
  await store.append("worker", "goal/attached", { objective: "Implement feature" }, { ignorable: true });
  await store.append("parent", "goal/attached", { objective: "Ship feature" }, { ignorable: true });
  const context = await reader.context("parent");
  assert.deepEqual(context.pendingSessionIds, ["grandchild"]);
  assert.deepEqual(context.children.map((child) => child.sessionId).sort(), ["grandchild", "worker"]);
  assert.equal(context.children.find((child) => child.sessionId === "worker")?.reply, "Implemented and checked");
  assert.deepEqual((await reader.related("grandchild")).map((entry) => entry.sessionId), ["worker", "parent"]);
  assert.deepEqual(await reader.related("fork-worker"), []);
  assert.deepEqual(await reader.related("foreign"), []);
  assert.deepEqual(await reader.related("other-project"), []);
});

test("uncertain child execution and open requests cannot be treated as completion", async (t) => {
  const { store, reader } = await harness(t);
  for (const status of ["working", "waiting", "reconciling", "unknown", "epoch-pending"] as const) {
    await store.upsertProjection(row("child", { parentId: "parent", status }));
    assert.deepEqual((await reader.context("parent")).pendingSessionIds, ["child"], status);
  }
  await store.upsertProjection(row("parent", { status: "waiting" }));
  assert.equal((await reader.context("parent")).ready, true, "mirrored child attention remains a dependency wait");
});

test("an idle child with an active goal is pending until its own audit settles", async (t) => {
  const { store, goals, reader } = await harness(t);
  await store.upsertProjection(row("child", { parentId: "parent" }));
  await store.append("child", "turn/stopped", { reason: "completed" }, { ignorable: true });
  const service = createGoalService({ append: async () => {}, send: async () => {}, complete: async () => "" });
  goals.set("child", await service.attach("child", { objective: "Implement feature" }));
  assert.deepEqual((await reader.context("parent")).pendingSessionIds, ["child"]);
  goals.get("child")!.status = "completed";
  assert.deepEqual((await reader.context("parent")).pendingSessionIds, []);
});

test("failed and aborted children settle even if their goal remains active", async (t) => {
  const { store, goals, reader } = await harness(t);
  const service = createGoalService({ append: async () => {}, send: async () => {}, complete: async () => "" });
  goals.set("child", await service.attach("child", { objective: "Implement feature" }));
  for (const reason of ["error", "aborted"] as const) {
    await store.upsertProjection(row("child", { parentId: "parent", status: reason === "error" ? "failed" : "idle" }));
    await store.append("child", "turn/stopped", { reason, error: "Provider stopped" }, { ignorable: true });
    const context = await reader.context("parent");
    assert.deepEqual(context.pendingSessionIds, []);
    assert.equal(context.children[0]?.stopReason, reason);
    assert.equal(context.children[0]?.error, "Provider stopped");
  }
});

test("a child a person paused stays pending until it is continued or stopped", async (t) => {
  const { store, reader } = await harness(t);
  const stop = await store.append("child", "turn/stopped", { reason: "aborted", paused: true }, { ignorable: true });
  await store.upsertProjection(row("child", { parentId: "parent", paused: { at: stop.time, stopSeq: stop.seq } }));
  const paused = await reader.context("parent");
  assert.deepEqual(paused.pendingSessionIds, ["child"], "paused work is neither finished nor failed");
  assert.equal(paused.children[0]?.stopReason, "paused");
  // Stop ends the pause: now the interrupted work settles as aborted.
  await store.append("child", "session/pause-ended", { outcome: "stopped", stopSeq: stop.seq }, { ignorable: true });
  await store.upsertProjection(row("child", { parentId: "parent" }));
  const stopped = await reader.context("parent");
  assert.deepEqual(stopped.pendingSessionIds, []);
  assert.equal(stopped.children[0]?.stopReason, "aborted");
  assert.notEqual(stopped.revision, paused.revision, "ending the pause wakes a waiting audit");
});

test("parent work, queued input, new admissions and explicit abort prevent automatic wake", async (t) => {
  const { store, queue, reader } = await harness(t);
  for (const status of ["working", "waiting", "reconciling", "unknown", "epoch-pending", "archived", "failed"] as const) {
    await store.upsertProjection(row("parent", { status }));
    assert.equal((await reader.context("parent")).ready, false, status);
  }
  await store.upsertProjection(row("parent"));
  queue.add("parent");
  assert.equal((await reader.context("parent")).ready, false);
  queue.clear();
  assert.equal((await reader.context("parent")).ready, true);
  await store.append("parent", "user/message", { text: "A new request" });
  assert.equal((await reader.context("parent")).ready, false);
  await store.append("parent", "turn/started", { turnId: "new" });
  assert.equal((await reader.context("parent")).ready, false);
  await store.append("parent", "turn/stopped", { reason: "aborted" }, { ignorable: true });
  assert.equal((await reader.context("parent")).ready, false);
});

test("child reports are bounded while readiness accounts for every descendant", async (t) => {
  const { store, reader } = await harness(t);
  for (let i = 0; i < 24; i++) {
    const id = `worker-${i}`;
    await store.upsertProjection(row(id, { parentId: "parent", status: i === 23 ? "working" : "idle", updatedAt: 100 - i }));
    await store.append(id, "user/message", { text: "task".repeat(5000) });
    await store.append(id, "assistant/message", { text: "report".repeat(5000) });
  }
  const context = await reader.context("parent");
  assert.deepEqual(context.pendingSessionIds, ["worker-23"]);
  assert.ok(context.children.length <= 16);
  assert.equal(context.omittedChildren, 24 - context.children.length);
  assert.ok(JSON.stringify(context.children).length < 20_000);
});

test("goal bookkeeping does not change the context revision or expose secret/tool payloads", async (t) => {
  const { store, reader } = await harness(t);
  await store.upsertProjection(row("child", { parentId: "parent" }));
  await store.append("child", "assistant/chunk", { partId: "report", text: "A chunk-only report" });
  const before = await reader.context("parent");
  await store.append("parent", "goal/audit", { verdict: "keep" }, { ignorable: true });
  await store.append("child", "secret/requested", { value: "private-fixture" }, { ignorable: true });
  await store.append("child", "tool/completed", { output: "private-tool-fixture" }, { ignorable: true });
  const after = await reader.context("parent");
  assert.equal(after.revision, before.revision);
  assert.equal(after.children[0]?.reply, "A chunk-only report");
  assert.doesNotMatch(JSON.stringify(after), /private-fixture|private-tool-fixture/);
});

test("durable audit snapshots replay the wait, counters and reason in the web model", async (t) => {
  const { store, reader } = await harness(t);
  await store.upsertProjection(row("child", { parentId: "parent", status: "working" }));
  const service = createGoalService({
    append: (id, type, data) => store.append(id, type, data, { ignorable: true }),
    send: async () => {}, complete: async () => '{"verdict":"done"}', context: reader.context,
  });
  await service.attach("parent", { objective: "Ship feature" });
  await service.onTurnCompleted("parent", "waiting");
  const model = (await store.events("parent")).reduce(reduceEvent, emptyModel());
  assert.deepEqual(model.goal?.waitingFor, ["child"]);
  assert.equal(model.goal?.status, "active");
  assert.equal(model.goal?.continuations, 0);
  assert.equal(model.goal?.lastReason, "Waiting for delegated sessions to settle");
  assert.equal(service.rehydrate("parent", await store.events("parent"))?.auditRevision, model.goal?.auditRevision);
});

test("latestGoalEvent returns the newest goal event across oldest-first pages", async () => {
  const types = ["goal/attached", "goal/audit", "goal/stopped"];
  const events = Array.from({ length: 1203 }, (_, index) => ({
    id: `e${index + 1}`, sessionId: "s", seq: index + 1, ts: index, type: index % 3 === 2 ? "assistant/message" : index === 1201 ? "goal/stopped" : "goal/audit", data: {},
  })) as unknown as SessionEvent[];
  const paged = {
    events: async () => events,
    latestSeq: async () => events.length,
    eventsOfTypes: async (_id: string, wanted: readonly string[], after: number, through: number, limit = 500) =>
      events.filter((event) => wanted.includes(event.type) && event.seq > after && event.seq <= through).slice(0, limit),
  };
  assert.equal((await latestGoalEvent(paged, "s", types))?.seq, 1202);
  assert.equal((await latestGoalEvent({ events: paged.events, latestSeq: paged.latestSeq }, "s", types))?.seq, 1202);
  assert.equal(await latestGoalEvent({ ...paged, events: async () => [], eventsOfTypes: async () => [] }, "s", types), undefined);
});
