import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import {
  buildIslandItems,
  eventsHaveCodeChanges,
  lastTask,
  notablePeers,
  promptExcerpt,
  recentSessionsForIsland,
} from "../src/mobileIsland.ts";
import { lastUserText } from "../src/utils.ts";

const NOW = 1_000_000_000;
const labels = {
  task: "Task",
  request: "Request",
  session: "Session",
  peer: "Session",
  working: "Working",
  newChat: "New chat",
};

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s",
  projectId: "p",
  title: "Session",
  status: "idle",
  createdAt: NOW - 600_000,
  updatedAt: NOW - 120_000,
  ...over,
});

const ev = (type: string, data: JsonObject, seq = 1): SessionEvent => ({
  id: `e${seq}`,
  sessionId: "s",
  seq,
  time: NOW,
  type,
  data,
  v: 1,
});

test("lastTask prefers the active item and otherwise keeps the latest snapshot row", () => {
  assert.equal(lastTask(undefined), undefined);
  assert.equal(lastTask([]), undefined);
  const items = [
    { id: "a", text: "one", status: "done" as const },
    { id: "b", text: "two", status: "pending" as const },
    { id: "c", text: "three", status: "active" as const },
  ];
  assert.equal(lastTask(items)?.id, "c");
  assert.equal(lastTask(items.slice(0, 2))?.id, "b");
});

test("the island marks tasks, current requests, and notable peer sessions", () => {
  const items = buildIslandItems({
    sessionTitle: "Ship island",
    hasSession: true,
    tasks: [{ id: "t1", text: "Write the pill", status: "active" }],
    permissions: [{
      sessionId: "s",
      requestId: "p1",
      permission: "bash",
      patterns: ["ls *"],
      tool: "bash",
      status: "pending",
      time: NOW,
      preview: { title: "List files", lines: [] },
    }],
    questions: [],
    secrets: [],
    peers: [{
      id: "other",
      title: "Review auth",
      status: { kind: "working", elapsedMs: 4_000, glyph: "◌", label: "Working" },
    }],
    labels,
  });
  assert.deepEqual(items.map((item) => [item.kind, item.mark, item.text]), [
    ["request", "Request", "List files"],
    ["task", "Task", "Write the pill"],
    ["peer", "Working", "Review auth"],
  ]);
  assert.equal(items[1]?.live, true);
});

test("an idle session with no tasks falls back to the session title, marked as Session", () => {
  const items = buildIslandItems({
    sessionTitle: "Ship island",
    hasSession: true,
    tasks: [],
    permissions: [],
    questions: [],
    secrets: [],
    peers: [],
    labels,
  });
  assert.deepEqual(items, [{
    id: "session",
    kind: "session",
    mark: "Session",
    text: "Ship island",
  }]);
});

test("peer attention is labeled as a request against the other session title", () => {
  const items = buildIslandItems({
    sessionTitle: "Current",
    hasSession: true,
    tasks: undefined,
    permissions: [],
    questions: [],
    secrets: [],
    peers: [{
      id: "other",
      title: "Needs a look",
      status: { kind: "needs-approval", glyph: "✓", label: "Approval required" },
    }],
    labels,
  });
  assert.equal(items[0]?.kind, "request");
  assert.equal(items[0]?.mark, "Request");
  assert.equal(items[0]?.text, "Needs a look");
});

test("notablePeers rank human attention above background work and skip the active session", () => {
  const rows = notablePeers([
    session({ id: "active", title: "Here" }),
    session({ id: "work", title: "Working", status: "working", lastTurnAt: NOW - 10_000 }),
    session({
      id: "ask",
      title: "Approve me",
      attention: { questions: 0, permissions: 1, unread: 0 },
      lastTurnAt: NOW - 50_000,
    }),
    session({ id: "idle", title: "Quiet", lastTurnAt: NOW }),
  ], "active", {});
  assert.deepEqual(rows.map((row) => row.id), ["ask", "work"]);
});

test("recent sessions drop the active row, archived rows, and stay bounded", () => {
  const recent = recentSessionsForIsland([
    session({ id: "active", lastTurnAt: NOW }),
    session({ id: "old", lastTurnAt: NOW - 80_000 }),
    session({ id: "newer", lastTurnAt: NOW - 10_000 }),
    session({ id: "archived", status: "archived", lastTurnAt: NOW - 1_000 }),
  ], "active", 2);
  assert.deepEqual(recent.map((row) => row.id), ["newer", "old"]);
});

test("eventsHaveCodeChanges is true only for edit-like tool writes", () => {
  assert.equal(eventsHaveCodeChanges(undefined), false);
  assert.equal(eventsHaveCodeChanges([]), false);
  assert.equal(eventsHaveCodeChanges([
    ev("tool/call", { callId: "r", tool: "read", input: { path: "src/a.ts" } }),
  ]), false);
  assert.equal(eventsHaveCodeChanges([
    ev("tool/call", { callId: "w", tool: "write", input: { filePath: "src/a.ts" } }, 1),
    ev("tool/result", { callId: "w", output: "ok" }, 2),
  ]), true);
});

test("promptExcerpt collapses to a single compact line", () => {
  assert.equal(promptExcerpt("Fix the island\n\nand then ship it", 20), "Fix the island");
  assert.match(promptExcerpt("x".repeat(120), 20), /…$/);
});

test("lastUserText reads the latest non-empty user message", () => {
  assert.equal(lastUserText(undefined), undefined);
  assert.equal(lastUserText([
    ev("user/message", { text: "first" }, 1),
    ev("assistant/message", { text: "ok" }, 2),
    ev("user/message", { text: "later prompt" }, 3),
  ]), "later prompt");
  assert.equal(lastUserText([
    ev("user/message", { text: "keep" }, 1),
    ev("user/message", { text: "   " }, 2),
  ]), "keep");
});
