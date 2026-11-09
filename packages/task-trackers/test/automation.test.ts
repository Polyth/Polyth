import test from "node:test";
import assert from "node:assert/strict";
import type {
  TaskTrackerColumnDto,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import { applyAgentStop, resolveAutomationTarget, type AgentStopDeps } from "../src/automation.ts";
import {
  DEFAULT_TASK_TRACKER_PREFERENCES,
  normalizePreferences,
  type TaskTrackerAgentStop,
  type TaskTrackerAgentStopReceipt,
  type TaskTrackerAutomationPreferences,
  type TaskTrackerTaskLinkDto,
} from "../src/types.ts";

const statuses: TaskTrackerStatusDto[] = [
  { id: "todo", name: "To do", category: "todo" },
  { id: "doing", name: "Doing", category: "in_progress" },
  { id: "review", name: "Review", category: "in_progress" },
  { id: "done", name: "Done", category: "done" },
];

const columns: TaskTrackerColumnDto[] = [
  { id: "c1", name: "To do", category: "todo", statusIds: ["todo"] },
  { id: "c2", name: "Doing", category: "in_progress", statusIds: ["doing"] },
  { id: "c3", name: "Review", category: "in_progress", statusIds: ["review"] },
  { id: "c4", name: "Done", category: "done", statusIds: ["done"] },
];

const task = (overrides: Partial<TaskTrackerTaskDto> = {}): TaskTrackerTaskDto => ({
  provider: "jira",
  id: "POL-1",
  key: "POL-1",
  title: "Fix mobile overflow",
  description: "",
  boardId: "board-1",
  status: statuses[0]!,
  availableStatuses: statuses,
  labels: [],
  assignees: [],
  ...overrides,
});

const link = (overrides: Partial<TaskTrackerTaskLinkDto> = {}): TaskTrackerTaskLinkDto => ({
  provider: "jira",
  taskId: "POL-1",
  taskKey: "POL-1",
  sessionId: "s-1",
  linkedAt: 1,
  ...overrides,
});

const automation = (
  patch: Partial<TaskTrackerAutomationPreferences> = {},
): TaskTrackerAutomationPreferences => ({
  ...DEFAULT_TASK_TRACKER_PREFERENCES.automation,
  enabled: true,
  ...patch,
});

interface Ran {
  receipts: TaskTrackerAgentStopReceipt[];
  written: string[];
  appended: string[];
}

function deps(options: {
  automation?: TaskTrackerAutomationPreferences;
  statusUpdates?: boolean;
  existing?: TaskTrackerTaskLinkDto | undefined;
  task?: TaskTrackerTaskDto | Error;
  boardColumns?: TaskTrackerColumnDto[] | Error;
  write?: Error;
} = {}): { deps: AgentStopDeps; ran: Ran } {
  const ran: Ran = { receipts: [], written: [], appended: [] };
  const read = async (): Promise<TaskTrackerTaskDto> => {
    const value = options.task ?? task();
    if (value instanceof Error) throw value;
    return value;
  };
  const value: AgentStopDeps = {
    now: () => 1_000,
    automation: () => options.automation ?? automation(),
    statusUpdates: () => options.statusUpdates ?? true,
    link: () => "existing" in options ? options.existing : link(),
    trackers: () => ({
      providers: () => [],
      listProjects: async () => [],
      listBoards: async () => [],
      listTasks: async () => [],
      getTask: read,
      listColumns: async () => {
        const board = options.boardColumns ?? columns;
        if (board instanceof Error) throw board;
        return { columns: board, editable: false };
      },
      updateStatus: async (_provider, _taskId, statusId) => {
        const current = await read();
        if (options.write) throw options.write;
        ran.written.push(statusId);
        return { ...current, status: statuses.find((status) => status.id === statusId) ?? current.status };
      },
    }),
    record: (receipt) => ran.receipts.push(receipt),
    moved: ({ task: updated }) => ran.appended.push(updated.status.id),
  };
  return { deps: value, ran };
}

const stop = (kind: TaskTrackerAgentStop = "finished", turnAt?: number) => ({
  provider: "jira" as const,
  taskId: "POL-1",
  sessionId: "s-1",
  kind,
  ...(turnAt !== undefined ? { turnAt } : {}),
});

test("the named column's own status is the target, matched in any letter case", () => {
  const resolution = resolveAutomationTarget(columns, statuses, "  rEvIeW ");
  assert.deepEqual(resolution, { ok: true, target: { id: "review", name: "Review", category: "in_progress" } });
});

test("a board without that column leaves the task alone", () => {
  assert.deepEqual(
    resolveAutomationTarget(columns, statuses, "Needs review"),
    { ok: false, refused: "no-column" },
    "a near-miss name is a refusal, never a guess",
  );
});

test("done is never a target, by category or by column", () => {
  assert.deepEqual(
    resolveAutomationTarget(columns, statuses, "Done"),
    { ok: false, refused: "no-target" },
    "a done column is refused even when named exactly",
  );
  const noColumns = resolveAutomationTarget(null, statuses, "Done");
  assert.deepEqual(noColumns, { ok: false, refused: "no-column" }, "without columns, only movable statuses are matched");
  const renamedDone = resolveAutomationTarget(
    [{ id: "x", name: "Review", category: "in_progress", statusIds: ["done"] }],
    statuses,
    "Review",
  );
  assert.deepEqual(renamedDone, { ok: false, refused: "no-target" }, "a column holding only a done status is refused");
});

test("without board columns, a status the task can move to is matched by name", () => {
  assert.deepEqual(
    resolveAutomationTarget(null, statuses, "review"),
    { ok: true, target: { id: "review", name: "Review", category: "in_progress" } },
  );
});

test("a finished turn moves a linked task to the named column and records it", async () => {
  const { deps: input, ran } = deps();
  const receipt = await applyAgentStop(input, stop("finished", 42));
  assert.deepEqual(ran.written, ["review"]);
  assert.deepEqual(ran.appended, ["review"]);
  assert.deepEqual(receipt, {
    at: 1_000,
    kind: "finished",
    turnAt: 42,
    moved: { statusId: "review", statusName: "Review", column: "Review" },
  });
  assert.deepEqual(ran.receipts, [receipt]);
});

test("the same turn never moves a task twice", async () => {
  const { deps: input, ran } = deps({
    existing: link({ agentStop: { at: 900, kind: "finished", turnAt: 42 } }),
  });
  assert.equal(await applyAgentStop(input, stop("finished", 42)), undefined);
  assert.deepEqual(ran.written, [], "a repeated stop replays nothing");
  assert.deepEqual(ran.receipts, [], "and writes no second receipt");
});

test("every refusal is a receipt the board can show", async () => {
  const cases: Array<[string, Parameters<typeof deps>[0], string]> = [
    ["off", { automation: automation({ enabled: false }) }, "off"],
    ["status updates off", { statusUpdates: false }, "off"],
    ["this stop kind unlisted", { automation: automation({ on: ["error"] }) }, "not-listed"],
    ["an unlinked task", { existing: undefined }, ""],
    ["a task already done", { task: task({ status: statuses[3]! }) }, "done"],
    ["a task already there", { task: task({ status: statuses[2]! }) }, "same-status"],
    ["a tracker that refused the write", { write: new Error("403") }, "write-refused"],
    ["a task the tracker did not return", { task: new Error("404") }, "write-refused"],
  ];
  for (const [name, options, refused] of cases) {
    const { deps: input, ran } = deps(options);
    const receipt = await applyAgentStop(input, stop("finished", 7));
    if (!refused) {
      assert.equal(receipt, undefined, `${name}: no receipt for an unlinked task`);
      assert.deepEqual(ran.receipts, [], `${name}: nothing recorded`);
      continue;
    }
    assert.equal(receipt?.refused, refused, name);
    assert.equal(receipt?.moved, undefined, `${name}: nothing moved`);
    assert.deepEqual(ran.receipts.length, 1, `${name}: one receipt`);
    assert.deepEqual(ran.written, [], `${name}: no tracker write`);
  }
});

test("a board whose columns did not load still moves to a status the task can use", async () => {
  const { deps: input, ran } = deps({ boardColumns: new Error("boom") });
  const receipt = await applyAgentStop(input, stop("finished"));
  assert.deepEqual(ran.written, ["review"], "the task's own movable statuses are the fallback");
  assert.equal(receipt?.moved?.statusId, "review");
});

test("an unreadable index does not take the stop down", async () => {
  const { deps: input } = deps();
  const receipt = await applyAgentStop({ ...input, record: () => { throw new Error("disk full"); } }, stop("finished"));
  assert.equal(receipt?.moved?.statusId, "review", "the move still happened and is reported");
});

test("automation preferences default off, keep known stop kinds and drop unknown ones", () => {
  const base = normalizePreferences(undefined).automation;
  assert.equal(base.enabled, false, "nothing moves a task until a Space asks");
  assert.equal(base.column, "Review");
  assert.deepEqual(base.on, ["finished", "needs-input"]);

  const stored = normalizePreferences({
    automation: { enabled: true, column: "  In   Review ", on: ["error", "teleported", 7] },
  }).automation;
  assert.equal(stored.column, "In Review", "a column is one trimmed line");
  assert.deepEqual(stored.on, ["error"], "unknown stop kinds are dropped");
});
