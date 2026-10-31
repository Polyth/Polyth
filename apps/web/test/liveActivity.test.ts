import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import type { LiveActivitySnapshot } from "@polyth/mobile/native";
import {
  LiveActivityPublisher,
  liveActivityFinal,
  liveActivitySnapshot,
  type LiveActivityModel,
} from "../src/liveActivity.ts";

const NOW = 1_000_000_000;

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s",
  projectId: "p",
  title: "Session",
  status: "idle",
  createdAt: NOW - 600_000,
  updatedAt: NOW - 120_000,
  ...over,
});

const emptyModel = (over: Partial<LiveActivityModel> = {}): LiveActivityModel => ({
  permissions: [],
  questions: [],
  tasks: null,
  messages: [],
  ...over,
});

const snapshot = (sessions: SessionProjection[], activeSessionId: string | null = null, activeModel: LiveActivityModel | null = null) =>
  liveActivitySnapshot({ sessions, activeSessionId, activeModel, events: {}, now: NOW });

test("nothing live means no activity", () => {
  assert.equal(snapshot([session({ id: "a" }), session({ id: "b", status: "archived" })]), null);
});

test("a person-needed chat outranks work, approval outranks a question", () => {
  const sessions = [
    session({ id: "work", title: "Refactor", status: "working", lastTurnAt: NOW - 30_000 }),
    session({ id: "ask", title: "Docs", status: "working", attention: { questions: 1, permissions: 0, unread: 0 } }),
    session({ id: "approve", title: "Deploy", status: "working", attention: { questions: 0, permissions: 1, unread: 0 } }),
  ];
  const result = snapshot(sessions)!;
  assert.equal(result.state, "needs-approval");
  assert.equal(result.sessionId, "approve");
  assert.equal(result.title, "Deploy");
  assert.match(result.summary, /1/);
  assert.equal(result.startedAt, undefined);

  const withoutApproval = snapshot(sessions.filter((item) => item.id !== "approve"))!;
  assert.equal(withoutApproval.state, "needs-reply");
  assert.equal(withoutApproval.sessionId, "ask");
});

test("subagent children never compete with their parent", () => {
  const result = snapshot([
    session({ id: "parent", status: "working", lastTurnAt: NOW - 1_000 }),
    session({ id: "child", parentId: "parent", status: "working", attention: { questions: 1, permissions: 0, unread: 0 } }),
  ])!;
  assert.equal(result.sessionId, "parent");
  assert.equal(result.summary, "");
});

test("the active chat names its pending question and task progress", () => {
  const model = emptyModel({
    questions: [{ sessionId: "a", requestId: "q1", status: "pending", time: NOW, questions: [{ question: "Which branch should I merge?" }] }],
    tasks: { listId: "l", revision: 1, items: [
      { id: "1", text: "Plan", status: "done" },
      { id: "2", text: "Build", status: "active" },
      { id: "3", text: "Ship", status: "pending" },
    ] },
  });
  const result = snapshot([
    session({ id: "a", title: "Merge", status: "waiting", attention: { questions: 1, permissions: 0, unread: 0 } }),
  ], "a", model)!;
  assert.equal(result.state, "needs-reply");
  assert.equal(result.detail, "Which branch should I merge?");
  assert.deepEqual([result.done, result.total], [1, 3]);
});

test("a background chat never borrows the active chat's question text", () => {
  const model = emptyModel({
    questions: [{ sessionId: "active", requestId: "q1", status: "pending", time: NOW, questions: [{ question: "Secret plan?" }] }],
  });
  const result = snapshot([
    session({ id: "active", status: "idle" }),
    session({ id: "bg", status: "waiting", attention: { questions: 1, permissions: 0, unread: 0 } }),
  ], "active", model)!;
  assert.equal(result.sessionId, "bg");
  assert.equal(result.detail, "");
});

test("working shows the current task and a stable start for the system timer", () => {
  const model = emptyModel({ tasks: { listId: "l", revision: 1, items: [{ id: "1", text: "Run tests", status: "active" }] } });
  const sessions = [session({ id: "a", status: "working", lastTurnAt: NOW - 42_000 })];
  const first = liveActivitySnapshot({ sessions, activeSessionId: "a", activeModel: model, events: {}, now: NOW })!;
  const later = liveActivitySnapshot({ sessions, activeSessionId: "a", activeModel: model, events: {}, now: NOW + 5_000 })!;
  assert.equal(first.state, "working");
  assert.equal(first.detail, "Run tests");
  assert.equal(first.startedAt, NOW - 42_000);
  assert.deepEqual(later, first, "time passing alone must not cross the bridge");
});

test("the final snapshot says done or failed, and ends silently for a vanished chat", () => {
  const previous = snapshot([session({ id: "a", title: "Build", status: "working", lastTurnAt: NOW - 1_000 })])!;
  const done = liveActivityFinal(previous, [session({ id: "a", title: "Build", status: "idle" })], NOW)!;
  assert.equal(done.state, "done");
  assert.equal(done.startedAt, undefined);
  assert.equal(done.summary, "");
  const failed = liveActivityFinal(previous, [session({ id: "a", status: "failed" })], NOW)!;
  assert.equal(failed.state, "failed");
  assert.equal(liveActivityFinal(previous, [], NOW), undefined);
  assert.equal(liveActivityFinal(previous, [session({ id: "a", status: "archived" })], NOW), undefined);
});

test("the publisher throttles, dedupes, orders calls and ends with a final snapshot", async () => {
  const calls: string[] = [];
  let current: LiveActivitySnapshot | null = null;
  const timers: Array<{ callback: () => void; ms: number }> = [];
  let clock = 0;
  const publisher = new LiveActivityPublisher({
    bridge: {
      update: async (value) => { calls.push(`update:${value.state}`); return true; },
      end: async (final) => { calls.push(`end:${final?.state ?? "none"}`); },
    },
    evaluate: () => ({ snapshot: current, final: (previous) => ({ ...previous, state: "done" }) }),
    timers: { set: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clear: () => {} },
    throttleMs: 1_000,
    now: () => clock,
  });

  // First evaluation always reaches native, even when nothing is live.
  await publisher.flush();
  assert.deepEqual(calls, ["end:none"]);

  current = snapshot([session({ id: "a", status: "working", lastTurnAt: NOW })]);
  publisher.schedule();
  publisher.schedule();
  assert.equal(timers.length, 1, "store bursts coalesce into one timer");
  assert.equal(timers[0]!.ms, 1_000);
  clock = 1_000;
  timers[0]!.callback();
  await publisher.flush(); // unchanged → no second update
  assert.deepEqual(calls, ["end:none", "update:working"]);
  assert.equal(publisher.currentSessionId(), "a");

  current = null;
  await publisher.flush();
  assert.deepEqual(calls, ["end:none", "update:working", "end:done"]);
  publisher.dispose();
  publisher.schedule();
  assert.equal(timers.length, 1, "a disposed publisher schedules nothing");
});
