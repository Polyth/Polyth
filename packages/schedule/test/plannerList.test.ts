import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterPlannerTasks,
  formatPlannerRowTime,
  groupPlannerTasks,
  parsePlannerFilters,
  plannerCounts,
  presentPlannerGroups,
  serializePlannerFilters,
  taskDisplayTitle,
  type PlannerTaskLike,
} from "../src/plannerList.ts";

function task(partial: Partial<PlannerTaskLike> & Pick<PlannerTaskLike, "id">): PlannerTaskLike {
  return {
    projectId: "p1",
    enabled: true,
    nextRunAt: null,
    prompt: "Prompt for " + partial.id,
    ...partial,
  };
}

const now = Date.parse("2026-09-15T12:00:00"); // Tuesday local-dependent; grouping uses local Date

test("taskDisplayTitle prefers title then first prompt line", () => {
  assert.equal(taskDisplayTitle({ title: " Standup ", prompt: "ignored" }), "Standup");
  assert.equal(taskDisplayTitle({ prompt: "\nSecond\nThird" }), "Second");
});

test("filters by project and status", () => {
  const tasks = [
    task({ id: "a", projectId: "p1", enabled: true, nextRunAt: now + 1 }),
    task({ id: "b", projectId: "p1", enabled: false, nextRunAt: null }),
    task({ id: "c", projectId: "p2", enabled: true, nextRunAt: now + 2 }),
  ];
  assert.deepEqual(filterPlannerTasks(tasks, { projectId: null, status: "all" }).map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(filterPlannerTasks(tasks, { projectId: "p1", status: "all" }).map((t) => t.id), ["a", "b"]);
  assert.deepEqual(filterPlannerTasks(tasks, { projectId: null, status: "active" }).map((t) => t.id), ["a", "c"]);
  assert.deepEqual(filterPlannerTasks(tasks, { projectId: "p1", status: "paused" }).map((t) => t.id), ["b"]);
});

test("groups today / tomorrow / later / paused with injected now", () => {
  const today = new Date(now);
  const laterToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 18, 0).getTime();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 9, 0).getTime();
  const friday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3, 9, 0).getTime();
  const tasks = [
    task({ id: "later-today", nextRunAt: laterToday }),
    task({ id: "tomorrow", nextRunAt: tomorrow }),
    task({ id: "friday", nextRunAt: friday }),
    task({ id: "paused", enabled: false, nextRunAt: null }),
    task({ id: "done", enabled: true, nextRunAt: null }),
    task({ id: "earlier-today", nextRunAt: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8, 0).getTime() }),
  ];
  const groups = groupPlannerTasks(tasks, now);
  assert.deepEqual(groups.map((g) => g.kind), ["today", "tomorrow", "date", "unscheduled", "paused"]);
  assert.deepEqual(groups[0]!.tasks.map((t) => t.id), ["earlier-today", "later-today"]);
  assert.deepEqual(groups[1]!.tasks.map((t) => t.id), ["tomorrow"]);
  assert.equal(groups[2]!.kind, "date");
  assert.deepEqual(groups[3]!.tasks.map((t) => t.id), ["done"]);
  assert.deepEqual(groups[4]!.tasks.map((t) => t.id), ["paused"]);
});

test("completed Once is grouped separately from legacy tasks with no next run", () => {
  const tasks = [
    task({ id: "legacy", enabled: true, nextRunAt: null, kind: "cron" }),
    task({ id: "once-leftover", enabled: true, nextRunAt: null, kind: "at" }),
    task({ id: "once-fired", enabled: false, nextRunAt: null, kind: "at", runs: 1 }),
    task({ id: "paused-once", enabled: false, nextRunAt: null, kind: "at", runs: 0 }),
    task({ id: "paused", enabled: false, nextRunAt: null, kind: "cron" }),
  ];
  const groups = groupPlannerTasks(tasks, now);
  assert.deepEqual(groups.map((g) => g.kind), ["unscheduled", "completed", "paused"]);
  assert.deepEqual(groups.find((g) => g.kind === "unscheduled")?.tasks.map((t) => t.id), ["legacy"]);
  assert.deepEqual(groups.find((g) => g.kind === "completed")?.tasks.map((t) => t.id), ["once-fired", "once-leftover"]);
  assert.deepEqual(groups.find((g) => g.kind === "paused")?.tasks.map((t) => t.id), ["paused", "paused-once"]);
  assert.deepEqual(filterPlannerTasks(tasks, { projectId: null, status: "all" }).map((t) => t.id), [
    "legacy", "once-leftover", "once-fired", "paused-once", "paused",
  ]);
  assert.deepEqual(filterPlannerTasks(tasks, { projectId: null, status: "active" }).map((t) => t.id), []);
  assert.deepEqual(filterPlannerTasks(tasks, { projectId: null, status: "paused" }).map((t) => t.id), ["paused-once", "paused"]);
});

test("plannerCounts reports active, paused, and next upcoming run", () => {
  const tasks = [
    task({ id: "a", enabled: true, nextRunAt: now + 3_600_000 }),
    task({ id: "b", enabled: true, nextRunAt: now + 120_000 }),
    task({ id: "c", enabled: false, nextRunAt: null }),
    task({ id: "done", enabled: false, nextRunAt: null, kind: "at", runs: 1 }),
  ];
  assert.deepEqual(plannerCounts(tasks), { active: 2, paused: 1, nextRunAt: now + 120_000 });
  assert.deepEqual(plannerCounts([]), { active: 0, paused: 0, nextRunAt: null });
});

test("completed one-shot tasks are not counted as active", () => {
  const done = task({ id: "done", enabled: true, nextRunAt: null });
  const paused = task({ id: "paused", enabled: false, nextRunAt: null });
  const live = task({ id: "live", enabled: true, nextRunAt: now + 60_000 });
  assert.deepEqual(plannerCounts([done, paused, live]), { active: 1, paused: 1, nextRunAt: now + 60_000 });
  assert.deepEqual(filterPlannerTasks([done, paused, live], { projectId: null, status: "active" }).map((t) => t.id), ["live"]);
  assert.deepEqual(filterPlannerTasks([done, paused, live], { projectId: null, status: "all" }).map((t) => t.id), ["done", "paused", "live"]);
});

test("dated agenda groups show clock time without repeating the date", () => {
  const stamp = new Date(2026, 8, 19, 9, 58).getTime();
  const label = formatPlannerRowTime(stamp, "date", "en-US");
  assert.match(label, /9:58/);
  assert.doesNotMatch(label, /Sep|September|19,/);
  assert.equal(formatPlannerRowTime(stamp, "paused", "en-US"), "");
  assert.equal(formatPlannerRowTime(stamp, "unscheduled", "en-US"), "");
  assert.equal(formatPlannerRowTime(stamp, "completed", "en-US"), "");
});

test("filter persistence round-trips", () => {
  const filters = { projectId: "abc", status: "paused" as const };
  assert.deepEqual(parsePlannerFilters(serializePlannerFilters(filters)), filters);
  assert.deepEqual(parsePlannerFilters(null), { projectId: null, status: "all" });
  assert.deepEqual(parsePlannerFilters("{"), { projectId: null, status: "all" });
});

test("completed group keeps only the most recent slice", () => {
  const tasks = [
    task({ id: "old", enabled: false, nextRunAt: null, kind: "at", runs: 1, lastRunAt: 1 }),
    task({ id: "mid", enabled: false, nextRunAt: null, kind: "at", runs: 1, lastRunAt: 2 }),
    task({ id: "new", enabled: false, nextRunAt: null, kind: "at", runs: 1, lastRunAt: 3 }),
    task({ id: "newer", enabled: false, nextRunAt: null, kind: "at", runs: 1, lastRunAt: 4 }),
    task({ id: "newest", enabled: false, nextRunAt: null, kind: "at", runs: 1, lastRunAt: 5 }),
    task({ id: "fresh", enabled: false, nextRunAt: null, kind: "at", runs: 1, lastRunAt: 6 }),
  ];
  const groups = presentPlannerGroups(groupPlannerTasks(tasks, now));
  const completed = groups.find((group) => group.kind === "completed");
  assert.deepEqual(completed?.tasks.map((item) => item.id), ["fresh", "newest", "newer", "new", "mid"]);
});
