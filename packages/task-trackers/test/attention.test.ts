import test from "node:test";
import assert from "node:assert/strict";
import { byAgentAttention, groupLinksByTask, hasUnseenAgentStop, unseenAgentStop } from "../src/attention.ts";
import type { TaskTrackerTaskLinkDto } from "../src/types.ts";

const link = (
  taskId: string,
  sessionId: string,
  extra: Partial<TaskTrackerTaskLinkDto> = {},
): TaskTrackerTaskLinkDto => ({
  provider: "jira",
  taskId,
  taskKey: `POL-${taskId}`,
  sessionId,
  linkedAt: 1,
  ...extra,
});

test("a stop is unseen only until someone opens the task", () => {
  const stop = { at: 200, kind: "finished" as const };
  assert.deepEqual(unseenAgentStop([link("1", "s-1", { agentStop: stop })]), stop, "a stop nobody saw is unseen");
  assert.equal(hasUnseenAgentStop([link("1", "s-1", { agentStop: stop, seenAt: 100 })]), true, "a stop after the sighting is unseen");
  assert.equal(hasUnseenAgentStop([link("1", "s-1", { agentStop: stop, seenAt: 200 })]), false, "opening at the same instant counts as seen");
  assert.equal(hasUnseenAgentStop([link("1", "s-1", { agentStop: stop, seenAt: 300 })]), false);
});

test("a task with several sessions shows the newest unseen stop", () => {
  const links = [
    link("1", "s-1", { agentStop: { at: 100, kind: "finished" }, seenAt: 50 }),
    link("1", "s-2", { agentStop: { at: 300, kind: "needs-input" }, seenAt: 50 }),
    link("1", "s-3", { agentStop: { at: 200, kind: "error" }, seenAt: 250 }),
  ];
  assert.deepEqual(unseenAgentStop(links), { at: 300, kind: "needs-input" });
});

test("links group by the task the board renders, not by session", () => {
  const grouped = groupLinksByTask([link("1", "s-1"), link("1", "s-2"), link("2", "s-3")]);
  assert.deepEqual([...grouped.keys()], ["jira:1", "jira:2"]);
  assert.equal(grouped.get("jira:1")?.length, 2);
});

test("unseen stops sort to the top, newest first, and the rest keep their order", () => {
  const tasks = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const links = new Map<string, TaskTrackerTaskLinkDto[]>([
    ["a", [link("a", "s-a", { agentStop: { at: 100, kind: "finished" } })]],
    ["c", [link("c", "s-c", { agentStop: { at: 300, kind: "error" }, seenAt: 150 })]],
    ["d", [link("d", "s-d", { agentStop: { at: 50, kind: "finished" }, seenAt: 60 })]],
  ]);
  assert.deepEqual(
    byAgentAttention(tasks, (task) => links.get(task.id) ?? []).map((task) => task.id),
    ["c", "a", "b", "d"],
    "a looked-at task keeps its place and an untouched task is not reshuffled",
  );
});

test("a board with nothing to look at keeps its exact order", () => {
  const tasks = [{ id: "a" }, { id: "b" }];
  const same = byAgentAttention(tasks, () => []);
  assert.deepEqual(same.map((task) => task.id), ["a", "b"]);
  assert.notEqual(same, tasks, "a fresh array, so React sees a stable value per render");
});
