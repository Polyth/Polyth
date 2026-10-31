import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTodoSnapshotTracker,
  createTodoToolTracker,
  isIncrementalTodoToolName,
  isTodoToolName,
  latestTodoItemsFromMessages,
  mergeTodoItems,
  nativeTodoStatus,
  normalizeTodoItems,
  normalizeTodoStatus,
  todoItemsFromToolInput,
  todoProgress,
} from "../src/index.ts";

test("native statuses from every harness map to the four canonical states", () => {
  const cases: Array<[unknown, string]> = [
    ["pending", "pending"], ["queued", "pending"], ["not started", "pending"],
    ["in_progress", "active"], ["inProgress", "active"], ["in-progress", "active"], ["IN PROGRESS", "active"],
    ["completed", "done"], ["succeeded", "done"],
    ["cancelled", "failed"], ["canceled", "failed"], ["error", "failed"],
    ["something-new", "pending"], [undefined, "pending"], [3, "pending"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeTodoStatus(input), expected, String(input));
  assert.equal(nativeTodoStatus("active"), "in_progress");
  assert.equal(nativeTodoStatus("failed"), "cancelled");
});

test("normalizes Claude TodoWrite, Codex plan, ACP entries and string rows", () => {
  assert.deepEqual(normalizeTodoItems([
    { content: " Read code ", status: "completed", activeForm: "Reading code" },
    { content: "Write tests", status: "in_progress", id: "t2" },
    { content: "   ", status: "pending" },
    null,
  ]), [
    { id: "todo:0", text: "Read code", status: "done" },
    { id: "t2", text: "Write tests", status: "active" },
  ]);
  assert.deepEqual(normalizeTodoItems([{ step: "Plan", status: "inProgress" }], {
    fallbackId: (index, text) => `codex:${index}:${text}`,
  }), [{ id: "codex:0:Plan", text: "Plan", status: "active" }]);
  assert.deepEqual(normalizeTodoItems([{ content: "Ship", priority: "high", status: "pending" }, "Loose row"]), [
    { id: "todo:0", text: "Ship", status: "pending" },
    { id: "todo:1", text: "Loose row", status: "pending" },
  ]);
  assert.equal(normalizeTodoItems(undefined), undefined);
  assert.deepEqual(normalizeTodoItems([]), []);
});

test("duplicate native ids stay unique so per-item activity is unambiguous", () => {
  const items = normalizeTodoItems([{ id: "a", content: "One" }, { id: "a", content: "Two" }, { id: 7, content: "Num" }]);
  assert.deepEqual(items?.map((item) => item.id), ["a", "a#1", "7"]);
});

test("recognizes todo tools by native and MCP-qualified names only", () => {
  for (const name of ["TodoWrite", "todowrite", "todo_write", "update_plan", "write_todos", "mcp__polyth__TodoWrite"]) {
    assert.equal(isTodoToolName(name), true, name);
  }
  for (const name of ["Write", "Bash", "todo_read", "TodoRead", "", undefined]) {
    assert.equal(isTodoToolName(name), false, String(name));
  }
  assert.deepEqual(todoItemsFromToolInput("update_plan", { plan: [{ step: "A", status: "completed" }] }), [
    { id: "todo:0", text: "A", status: "done" },
  ]);
  assert.equal(todoItemsFromToolInput("Bash", { todos: [{ content: "x" }] }), undefined);
  assert.equal(todoItemsFromToolInput("TodoWrite", "not an object"), undefined);
});

test("tracker publishes revisioned full snapshots and drops repeats", () => {
  const tracker = createTodoSnapshotTracker();
  assert.equal(tracker.replace([]), undefined, "an initial empty list carries no news");
  const first = tracker.replace([{ id: "a", text: "A", status: "active" }]);
  assert.deepEqual(first, { type: "task/snapshot", listId: "todo", revision: 1, items: [{ id: "a", text: "A", status: "active" }] });
  assert.equal(tracker.replace([{ id: "a", text: "A", status: "active" }]), undefined);
  const merged = tracker.merge([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "pending" }]);
  assert.equal(merged?.revision, 2);
  assert.deepEqual(merged?.items.map((item) => `${item.id}:${item.status}`), ["a:done", "b:pending"]);
  const cleared = tracker.replace([]);
  assert.deepEqual(cleared?.items, [], "clearing a populated list is published");
  assert.equal(cleared?.revision, 3);
  // Published items are copies: mutating them cannot corrupt tracker state.
  merged!.items[0]!.status = "failed";
  assert.equal(tracker.revision(), 3);
});

test("clock-seeded revisions stay ahead of an earlier leg and remain monotonic", () => {
  let now = 1_000;
  const tracker = createTodoSnapshotTracker({ revisionClock: () => now });
  assert.equal(tracker.replace([{ id: "a", text: "A", status: "pending" }])?.revision, 1_000);
  // Same millisecond, or a clock that steps backwards, still increases.
  assert.equal(tracker.replace([{ id: "a", text: "A", status: "active" }])?.revision, 1_001);
  now = 10;
  assert.equal(tracker.replace([{ id: "a", text: "A", status: "done" }])?.revision, 1_002);
  const broken = createTodoSnapshotTracker({ revisionClock: () => Number.NaN });
  assert.equal(broken.replace([{ id: "a", text: "A", status: "done" }])?.revision, 1);
});

test("mergeTodoItems keeps order and replaces by id", () => {
  assert.deepEqual(
    mergeTodoItems([{ id: "a", text: "A", status: "pending" }], [{ id: "a", text: "A2", status: "done" }]),
    [{ id: "a", text: "A2", status: "done" }],
  );
});

test("progress summarizes counts and the current item", () => {
  const progress = todoProgress([
    { id: "a", text: "A", status: "done" },
    { id: "b", text: "B", status: "pending" },
    { id: "c", text: "C", status: "active" },
    { id: "d", text: "D", status: "failed" },
  ]);
  assert.deepEqual({ ...progress, current: progress.current?.id }, {
    total: 4, pending: 1, active: 1, done: 1, failed: 1, current: "c", settled: false,
  });
  assert.equal(todoProgress(undefined).settled, true);
  assert.equal(todoProgress([{ id: "a", text: "A", status: "done" }]).current, undefined);
});

test("transcript fallback reads the newest todo tool call, including an explicit clear", () => {
  const messages = [
    { kind: "tool", tool: "TodoWrite", input: { todos: [{ content: "Old", status: "pending" }] } },
    { kind: "assistant", text: "hi" },
    { kind: "tool", tool: "update_plan", input: { plan: [{ step: "New", status: "inProgress" }] } },
    { kind: "tool", tool: "Bash", input: { command: "ls" } },
  ];
  assert.deepEqual(latestTodoItemsFromMessages(messages, { fallbackId: (index) => `todo-${index}` }), [
    { id: "todo-0", text: "New", status: "active" },
  ]);
  assert.deepEqual(latestTodoItemsFromMessages([...messages, { kind: "tool", tool: "TodoWrite", input: { todos: [] } }]), []);
  assert.equal(latestTodoItemsFromMessages([{ kind: "tool", tool: "Bash", input: {} }]), undefined);
});

test("Claude Code TaskCreate/TaskUpdate/TaskList build one canonical list (shapes from a live Haiku run)", () => {
  const tracker = createTodoToolTracker();
  assert.equal(tracker.call("c1", "TaskCreate", { subject: "Create notes.md", description: "heading and primes" }), undefined,
    "a new task has no id until its result");
  const first = tracker.result("c1", "Task #1 created successfully: Create notes.md", { task: { id: "1", subject: "Create notes.md" } });
  assert.deepEqual(first?.items, [{ id: "1", text: "Create notes.md", status: "pending" }]);
  tracker.call("c2", "TaskCreate", { subject: "Write summary", description: "count lines" });
  // Text-only result (no typed output) still yields the id.
  assert.equal(tracker.result("c2", [{ type: "text", text: "Task #2 created successfully: Write summary" }])?.items.length, 2);
  // Live Haiku sent `id`, the schema documents `taskId`: both are accepted.
  assert.deepEqual(tracker.call("u1", "TaskUpdate", { id: "1", status: "in_progress" })?.items[0], { id: "1", text: "Create notes.md", status: "active" });
  assert.equal(tracker.call("u2", "TaskUpdate", { taskId: "1", status: "completed", subject: "Create notes.md (done)" })?.items[0]?.text, "Create notes.md (done)");
  assert.equal(tracker.call("u3", "TaskUpdate", { taskId: "404", status: "completed" }), undefined, "unknown ids are ignored");
  assert.deepEqual(tracker.call("u4", "TaskUpdate", { taskId: "2", status: "deleted" })?.items.map((item) => item.id), ["1"]);
  tracker.call("l1", "TaskList", {});
  const listed = tracker.result("l1", "", { tasks: [
    { id: "1", subject: "Create notes.md", status: "completed", blockedBy: [] },
    { id: "3", subject: "Verify", status: "pending", blockedBy: [] },
  ] });
  assert.deepEqual(listed?.items, [
    { id: "1", text: "Create notes.md", status: "done" },
    { id: "3", text: "Verify", status: "pending" },
  ]);
  assert.equal(tracker.result("unknown", "Task #9 created"), undefined, "results without a tracked call are ignored");
  assert.deepEqual(tracker.call("w1", "TodoWrite", { todos: [{ content: "Full list", status: "pending" }] })?.items, [
    { id: "todo:0", text: "Full list", status: "pending" },
  ], "full-list tools still replace");
  for (const name of ["TaskCreate", "TaskUpdate", "TaskList", "mcp__x__task_create"]) assert.equal(isIncrementalTodoToolName(name), true, name);
  for (const name of ["Task", "TaskGet", "TaskStop", "TodoWrite"]) assert.equal(isIncrementalTodoToolName(name), false, name);
});
