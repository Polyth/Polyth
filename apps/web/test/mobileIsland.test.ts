import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import {
  activeSessionsForIsland,
  buildIslandItems,
  eventsHaveCodeChanges,
  groupRecentSessionsByDay,
  hasWorktreeSession,
  isIsolatedSession,
  lastTask,
  latestStartedTask,
  notablePeers,
  promptExcerpt,
  projectSessionStatusCounts,
  recentSessionsForIsland,
  tasksForIsland,
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

test("dormant owned epochs remain recent sessions rather than filling the live overview", () => {
  const owned = session({ id: "owned", status: "epoch-pending", runtimeControl: "owned" });
  const borrowed = session({ id: "borrowed", status: "epoch-pending", runtimeControl: "borrowed" });
  const active = activeSessionsForIsland([owned, borrowed], undefined, undefined, NOW);
  const recent = recentSessionsForIsland([owned, borrowed], undefined, 8, NOW);
  assert.deepEqual(active.map((row) => row.id), ["borrowed"]);
  assert.deepEqual(recent.map((row) => row.id), ["owned"]);
});

test("latestStartedTask selects only the newest explicit task start", () => {
  const messages = [
    { kind: "task", id: "created", taskId: "a", action: "created", text: "Draft", time: NOW, eventSeq: 1 },
    { kind: "task", id: "started-a", taskId: "a", action: "started", text: "Implement", time: NOW, eventSeq: 2 },
    { kind: "task", id: "done-a", taskId: "a", action: "completed", text: "Implement", time: NOW, eventSeq: 3 },
    { kind: "task", id: "started-b", taskId: "b", action: "started", text: "Verify", time: NOW, eventSeq: 4 },
  ] as const;
  assert.equal(latestStartedTask(messages)?.id, "started-b");
  assert.equal(latestStartedTask(messages)?.text, "Verify");
  assert.equal(latestStartedTask([]), undefined);
});

test("task overview falls back to TodoWrite tool state and keeps completed items visible", () => {
  const tasks = tasksForIsland(null, [{
    kind: "tool",
    id: "todo-1",
    callId: "todo-1",
    eventSeq: 1,
    tool: "TodoWrite",
    input: {
      todos: [
        { id: "a", content: "Inspect", status: "completed" },
        { id: "b", content: "Polish", status: "in_progress" },
        { id: "c", content: "Ship", status: "pending" },
      ],
    },
    status: "done",
    time: NOW,
  }]);
  assert.deepEqual(tasks, [
    { id: "a", text: "Inspect", status: "done" },
    { id: "b", text: "Polish", status: "active" },
    { id: "c", text: "Ship", status: "pending" },
  ]);

  assert.deepEqual(tasksForIsland({ listId: "todo", revision: 3, items: [] }, [{
    kind: "tool",
    id: "old-todo",
    callId: "old-todo",
    eventSeq: 1,
    tool: "todo_write",
    input: { todos: [{ content: "Old", status: "pending" }] },
    status: "done",
    time: NOW,
  }]), []);
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

test("overview partitions live sessions from recent history and keeps the current row addressable", () => {
  const current = session({ id: "current", status: "idle", lastTurnAt: NOW });
  const working = session({ id: "working", status: "working", lastTurnAt: NOW - 1_000 });
  const unread = session({ id: "unread", attention: { questions: 0, permissions: 0, unread: 1 }, lastTurnAt: NOW - 2_000 });
  const recent = session({ id: "recent", lastTurnAt: NOW - 3_000 });
  const active = activeSessionsForIsland([current, working, unread, recent], current.id, undefined, NOW);
  const history = recentSessionsForIsland([current, working, unread, recent], current.id, 8, NOW);

  assert.deepEqual(active.map((row) => row.id), ["current", "working"]);
  assert.deepEqual(history.map((row) => row.id), ["unread", "recent"]);
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

test("recent sessions preserve the source order, deduplicate overlap, and keep descending activity", () => {
  const source = [
    session({ id: "older", lastTurnAt: NOW - 80_000 }),
    session({ id: "newer", lastTurnAt: NOW - 10_000 }),
    session({ id: "newer", lastTurnAt: NOW - 10_000 }),
  ];
  const recent = recentSessionsForIsland(source, undefined, 8);
  assert.deepEqual(source.map((row) => row.id), ["older", "newer", "newer"]);
  assert.deepEqual(recent.map((row) => row.id), ["newer", "older"]);
});

test("recent sessions group by the same local activity day used for ordering", () => {
  const first = new Date(2026, 4, 2, 18, 0, 0).getTime();
  const second = new Date(2026, 4, 2, 9, 0, 0).getTime();
  const previous = new Date(2026, 4, 1, 23, 0, 0).getTime();
  const groups = groupRecentSessionsByDay([
    session({ id: "first", lastTurnAt: first }),
    session({ id: "second", lastTurnAt: second }),
    session({ id: "previous", lastTurnAt: previous }),
    session({ id: "second", lastTurnAt: second }),
  ], "en", new Date(2026, 4, 2, 20, 0, 0).getTime());
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.sessions.map((row) => row.id)), [["first", "second"], ["previous"]]);
  assert.equal(groups[0]?.key, "2026-05-02");
  assert.equal(groups[1]?.key, "2026-05-01");
  assert.equal(groups[0]?.label, "today");
  assert.equal(groups[1]?.label, "yesterday");
});

test("session location metadata distinguishes worktrees and managed isolation", () => {
  const worktree = session({ id: "worktree", worktreePath: "/repo/feature", branch: "feature/ui" });
  const isolated = session({
    id: "isolated",
    branch: "polyth/isolate/abc",
    isolation: {
      kind: "git-worktree",
      createdAt: "2026-01-01T00:00:00.000Z",
      worktreePath: "/repo/.polyth/isolated",
      worktreeBranch: "polyth/isolate/abc",
      targetPath: "/repo",
      targetBranch: "main",
      baseCommit: "abc",
      state: "active",
    },
  });
  const regular = session({ id: "regular", branch: "main" });
  assert.equal(hasWorktreeSession(worktree), true);
  assert.equal(isIsolatedSession(worktree), false);
  assert.equal(hasWorktreeSession(isolated), true);
  assert.equal(isIsolatedSession(isolated), true);
  assert.equal(hasWorktreeSession(regular), false);
  assert.equal(isIsolatedSession(regular), false);
});

test("project status counts reuse navigator status priority", () => {
  const counts = projectSessionStatusCounts([
    session({ id: "working", status: "working" }),
    session({ id: "waiting", status: "waiting" }),
    session({ id: "approval", attention: { questions: 0, permissions: 1, unread: 0 } }),
    session({ id: "unread", attention: { questions: 0, permissions: 0, unread: 1 } }),
    session({ id: "failed", status: "failed" }),
    session({
      id: "limited",
      status: "failed",
      resume: { resumeAt: NOW + 60_000, scope: "quota", attempt: 1, userMessageSeq: 3 },
    }),
  ], NOW);
  assert.deepEqual(counts, { active: 1, waiting: 2, unread: 1, failed: 1, limited: 1 });
});

test("project status counts exclude archived sessions like the navigator", () => {
  const counts = projectSessionStatusCounts([
    session({ id: "active", status: "working" }),
    session({ id: "archived-unread", status: "archived", attention: { questions: 0, permissions: 0, unread: 1 } }),
  ], NOW);
  assert.deepEqual(counts, { active: 1, waiting: 0, unread: 0, failed: 0, limited: 0 });
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
