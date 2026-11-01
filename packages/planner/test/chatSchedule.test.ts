// Which planned tasks belong to a chat, and which session events mean its
// schedule may have changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatSchedule, plannerScheduleWatch, plannerTaskChat } from "../src/chatSchedule.ts";
import { PLANNER_RUN_STARTED_EVENT, type PlannerTask } from "../src/model.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");

function task(id: string, over: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id,
    projectId: "p1",
    spaceId: "space-1",
    prompt: `Prompt ${id}`,
    kind: "every",
    everyMinutes: 60,
    cadence: { kind: "every", everyMinutes: 60 },
    target: { mode: "existing-session", sessionId: "s1" },
    sessionId: "s1",
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: NOW + 60 * 60_000,
    runs: 0,
    ...over,
  };
}

test("a task belongs to the chat it posts into", () => {
  assert.equal(plannerTaskChat(task("a")), "s1");
  // Older tasks carry only the flat session id.
  assert.equal(plannerTaskChat({ sessionId: "s2" }), "s2");
  assert.equal(plannerTaskChat({ target: { mode: "existing-session" }, sessionId: "s3" }), "s3");
  // "Keep one chat" posts where its runs have been going.
  assert.equal(plannerTaskChat({ target: { mode: "dedicated-session" }, lastSessionId: "s4" }), "s4");
  assert.equal(plannerTaskChat({ target: { mode: "dedicated-session" } }), undefined);
  assert.equal(plannerTaskChat({ target: { mode: "new-session-per-run" }, lastSessionId: "s5" }), undefined);
});

test("the chat's schedule: upcoming soonest first, then paused, nothing from other chats or finished", () => {
  const tasks = [
    task("later", { nextRunAt: NOW + 3 * 60 * 60_000, title: "Later" }),
    task("soon", { nextRunAt: NOW + 10 * 60_000, title: "Soon" }),
    task("paused", { enabled: false, nextRunAt: null, title: "Paused" }),
    task("elsewhere", { target: { mode: "existing-session", sessionId: "s2" }, sessionId: "s2" }),
    task("fresh-chats", { target: { mode: "new-session-per-run" }, sessionId: undefined }),
    // A one-time task that already ran has left the schedule.
    task("done", { kind: "at", cadence: { kind: "at", at: NOW - 60_000 }, enabled: false, nextRunAt: null, runs: 1 }),
  ];
  const schedule = chatSchedule(tasks, "s1");
  assert.deepEqual(schedule.tasks.map((item) => item.id), ["soon", "later", "paused"]);
  assert.equal(schedule.next?.id, "soon");
  assert.equal(schedule.upcoming, 2);
  assert.equal(schedule.idle, 1);
  assert.deepEqual(chatSchedule(tasks, "s2").tasks.map((item) => item.id), ["elsewhere"]);
});

test("no chat or no tasks is an empty schedule", () => {
  for (const [tasks, sessionId] of [[null, "s1"], [[], "s1"], [[task("a")], null], [[task("a")], "other"]] as const) {
    const schedule = chatSchedule(tasks, sessionId);
    assert.equal(schedule.tasks.length, 0);
    assert.equal(schedule.next, undefined);
  }
});

test("a chat with only paused tasks has nothing next", () => {
  const schedule = chatSchedule([task("paused", { enabled: false, nextRunAt: null })], "s1");
  assert.equal(schedule.next, undefined);
  assert.equal(schedule.upcoming, 0);
  assert.equal(schedule.idle, 1);
});

test("a planned run and a finished planner call change the schedule; other tools do not", () => {
  const changed = plannerScheduleWatch();
  assert.equal(changed({ type: PLANNER_RUN_STARTED_EVENT, data: { taskId: "a" } }), true);
  assert.equal(changed({ type: "tool/call", data: { callId: "c1", tool: "mcp__polyth-agent-tools__polyth_planner" } }), false);
  // Claude reports every result as tool "tool": the call id names it.
  assert.equal(changed({ type: "tool/result", data: { callId: "c1", tool: "tool", output: "Scheduled" } }), true);
  assert.equal(changed({ type: "tool/result", data: { callId: "c1", tool: "tool" } }), false, "a call settles once");
  assert.equal(changed({ type: "tool/call", data: { callId: "c2", tool: "Bash" } }), false);
  assert.equal(changed({ type: "tool/result", data: { callId: "c2", tool: "tool" } }), false);
  // A harness that names the tool on its result needs no remembered call.
  assert.equal(changed({ type: "tool/result", data: { callId: "c3", tool: "polyth-agent-tools.polyth_planner" } }), true);
  assert.equal(changed({ type: "tool/started", data: { callId: "c4", tool: "polyth_planner" } }), false);
  assert.equal(changed({ type: "tool/error", data: { callId: "c4", tool: "tool", error: "x" } }), true);
  assert.equal(changed({ type: "assistant/message", data: { text: "polyth_planner" } }), false);
});

test("calls whose result never comes do not pile up", () => {
  const changed = plannerScheduleWatch();
  for (let index = 0; index < 200; index += 1) changed({ type: "tool/call", data: { callId: `c${index}`, tool: "polyth_planner" } });
  // The oldest were forgotten; the newest is still known.
  assert.equal(changed({ type: "tool/result", data: { callId: "c0", tool: "tool" } }), false);
  assert.equal(changed({ type: "tool/result", data: { callId: "c199", tool: "tool" } }), true);
});
