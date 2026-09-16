import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import {
  canSubmitPlannerEditor,
  duplicatePlannerTaskInput,
  existingSessionTargetValid,
  isCompletedOnce,
  plannerRowShowsActiveSwitch,
  sessionIdAfterProjectChange,
} from "../src/plannerTask.ts";

function task(partial: Partial<ScheduleTaskDto> & Pick<ScheduleTaskDto, "id">): ScheduleTaskDto {
  return {
    projectId: "p1",
    prompt: "Prompt",
    kind: "every",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: null,
    runs: 0,
    ...partial,
  };
}

test("changing project clears a session that does not belong to the new project", () => {
  const sessionsB = [{ id: "sess-b" }];
  assert.equal(
    sessionIdAfterProjectChange("sess-a", "existing-session", sessionsB),
    "",
  );
  assert.equal(
    sessionIdAfterProjectChange("sess-b", "existing-session", sessionsB),
    "sess-b",
  );
});

test("new-session and dedicated targets stay empty across project changes", () => {
  const sessions = [{ id: "sess-b" }];
  assert.equal(sessionIdAfterProjectChange("sess-a", "new-session-per-run", sessions), "");
  assert.equal(sessionIdAfterProjectChange("sess-a", "dedicated-session", sessions), "");
});

test("existing-session submit requires the session to belong to the selected project", () => {
  const sessionsB = [{ id: "sess-b" }];
  assert.equal(existingSessionTargetValid("existing-session", "sess-a", sessionsB), false);
  assert.equal(existingSessionTargetValid("existing-session", "", sessionsB), false);
  assert.equal(existingSessionTargetValid("existing-session", "sess-b", sessionsB), true);
  assert.equal(
    canSubmitPlannerEditor({
      projectId: "b",
      prompt: "hi",
      cadenceOk: true,
      targetMode: "existing-session",
      sessionId: "sess-a",
      sessionsInProject: sessionsB,
    }),
    false,
  );
  assert.equal(
    canSubmitPlannerEditor({
      projectId: "b",
      prompt: "hi",
      cadenceOk: true,
      targetMode: "existing-session",
      sessionId: "sess-b",
      sessionsInProject: sessionsB,
    }),
    true,
  );
});

test("changing project while targeting a new session per run stays valid", () => {
  assert.equal(
    canSubmitPlannerEditor({
      projectId: "b",
      prompt: "hi",
      cadenceOk: true,
      targetMode: "new-session-per-run",
      sessionId: "",
      sessionsInProject: [],
    }),
    true,
  );
});

test("completed Once is not treated as an active ON switch", () => {
  const leftover = task({
    id: "once",
    kind: "at",
    at: 1,
    cadence: { kind: "at", at: 1 },
    enabled: true,
    nextRunAt: null,
  });
  const fired = task({
    id: "fired",
    kind: "at",
    at: 1,
    cadence: { kind: "at", at: 1 },
    enabled: false,
    nextRunAt: null,
    runs: 1,
  });
  const pausedOnce = task({
    id: "paused-once",
    kind: "at",
    cadence: { kind: "at", at: 1 },
    enabled: false,
    nextRunAt: null,
    runs: 0,
  });
  const paused = task({ id: "paused", kind: "cron", enabled: false, nextRunAt: null });
  const legacy = task({
    id: "legacy",
    kind: "cron",
    cadence: { kind: "cron", expression: "0 3 * * 1", timeZone: "UTC" },
    enabled: true,
    nextRunAt: null,
  });
  assert.equal(isCompletedOnce(leftover), true);
  assert.equal(plannerRowShowsActiveSwitch(leftover), false);
  assert.equal(isCompletedOnce(fired), true);
  assert.equal(plannerRowShowsActiveSwitch(fired), false);
  assert.equal(isCompletedOnce(pausedOnce), false);
  assert.equal(plannerRowShowsActiveSwitch(pausedOnce), true);
  assert.equal(isCompletedOnce(paused), false);
  assert.equal(plannerRowShowsActiveSwitch(paused), true);
  assert.equal(isCompletedOnce(legacy), false);
  assert.equal(plannerRowShowsActiveSwitch(legacy), true);
});

test("duplicate preserves enabled and modern target modes", () => {
  const pausedWeekly = task({
    id: "paused",
    enabled: false,
    kind: "cron",
    cadence: { kind: "cron", expression: "0 15 * * 2", timeZone: "UTC" },
    title: "Standup",
    target: { mode: "new-session-per-run" },
    overlapPolicy: "queue",
  });
  const duplicated = duplicatePlannerTaskInput(pausedWeekly);
  assert.equal(duplicated?.enabled, false);
  assert.equal(duplicated?.projectId, "p1");
  assert.equal(duplicated?.prompt, "Prompt");
  assert.equal(duplicated?.title, "Standup");
  assert.deepEqual(duplicated?.target, { mode: "new-session-per-run" });
  assert.equal(duplicated?.overlapPolicy, "queue");
  assert.deepEqual(duplicated?.cadence, pausedWeekly.cadence);

  const dedicated = duplicatePlannerTaskInput(task({
    id: "dedicated",
    kind: "at",
    cadence: { kind: "at", at: 9 },
    target: { mode: "dedicated-session" },
  }));
  assert.deepEqual(dedicated?.target, { mode: "dedicated-session" });

  const existing = duplicatePlannerTaskInput(task({
    id: "existing",
    kind: "at",
    cadence: { kind: "at", at: 9 },
    target: { mode: "existing-session", sessionId: "sess-1" },
  }));
  assert.deepEqual(existing?.target, { mode: "existing-session", sessionId: "sess-1" });
});

test("duplicate preserves a legacy sessionId as an existing-session target", () => {
  const legacy = task({
    id: "legacy",
    kind: "at",
    at: 12,
    sessionId: "old-session",
    enabled: true,
  });
  const duplicated = duplicatePlannerTaskInput(legacy);
  assert.deepEqual(duplicated?.target, { mode: "existing-session", sessionId: "old-session" });
  assert.equal(duplicated?.enabled, true);
});
