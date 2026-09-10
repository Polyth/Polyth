import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createCoachStore } from "../src/index.ts";
import {
  registerCoachOnboardingCapabilities,
  type CoachScheduleService,
  type CoachScheduleTask,
} from "../src/onboarding.ts";

const projectId = "__polyth_pkg_onboarding0123456789";
const context = {
  sessionId: "coach-session",
  spaceId: "space-a",
  projectId,
  cwd: "/tmp/coach",
};
const fresh = () => createCoachStore(join(mkdtempSync(join(tmpdir(), "polyth-coach-onboarding-")), "coach.db"));

function fakeSchedule() {
  let next = 1;
  const tasks: Array<CoachScheduleTask & Record<string, unknown>> = [];
  const service: CoachScheduleService = {
    list: (id) => tasks.filter((task) => id === undefined || task.projectId === id),
    create(input) {
      const task = { id: `task-${next++}`, ...input };
      tasks.push(task);
      return task;
    },
    update(id, patch) {
      const task = tasks.find((item) => item.id === id);
      if (!task) throw Object.assign(new Error("missing task"), { code: "not-found" });
      Object.assign(task, patch);
      return task;
    },
    remove(id) {
      const index = tasks.findIndex((item) => item.id === id);
      if (index < 0) return false;
      tasks.splice(index, 1);
      return true;
    },
    preview: () => ({ runs: [1, 2] }),
  };
  return { service, tasks };
}

function finishTool(store: ReturnType<typeof fresh>, schedule: () => CoachScheduleService | undefined) {
  const registry = createCapabilityContributionRegistry();
  const set = registerCoachOnboardingCapabilities({
    registry,
    space: { spaceId: "space-a" },
    projectId,
    store,
    schedule,
  });
  const descriptor = registry.resolve(context).find(
    (item) => item.kind === "tool" && item.name === "coach_finish_onboarding",
  )!;
  return { set, execute: registry.executor(descriptor.id)! };
}

test("finish onboarding requires explicit reminder choices and stores confirmed preferences", async () => {
  const store = fresh();
  const { set, execute } = finishTool(store, () => undefined);
  await assert.rejects(
    () => execute({ timeZone: "Europe/Kyiv" }, context),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  assert.equal(store.profile().onboardingState, "new");

  await execute({
    timeZone: "Europe/Kyiv",
    tone: "direct",
    initiative: "balanced",
    challengeAssumptions: true,
    dailyCheckIn: false,
    weeklyReview: false,
  }, context);
  assert.deepEqual(store.profile(), {
    ...store.profile(),
    tone: "direct",
    initiative: "balanced",
    challengeAssumptions: true,
    timeZone: "Europe/Kyiv",
    onboardingState: "complete",
  });
  await set.dispose();
  store.close();
});

test("explicit reminder opt-in creates timezone-aware new-session schedule tasks without duplicates", async () => {
  const store = fresh();
  const schedule = fakeSchedule();
  const { set, execute } = finishTool(store, () => schedule.service);
  const input = {
    timeZone: "Europe/Kyiv",
    dailyCheckIn: true,
    dailyMinuteOfDay: 8 * 60 + 30,
    weeklyReview: true,
    weeklyDay: 0,
    weeklyMinuteOfDay: 18 * 60,
  };
  await execute(input, context);
  assert.equal(schedule.tasks.length, 2);
  const daily = schedule.tasks.find((task) => task.title === "Coach · Daily check-in")!;
  const weekly = schedule.tasks.find((task) => task.title === "Coach · Weekly review")!;
  assert.deepEqual(daily.cadence, { kind: "cron", expression: "30 8 * * *", timeZone: "Europe/Kyiv" });
  assert.deepEqual(weekly.cadence, { kind: "cron", expression: "0 18 * * 0", timeZone: "Europe/Kyiv" });
  assert.deepEqual(daily.target, { mode: "new-session-per-run" });
  assert.equal(daily.projectId, projectId);

  await execute(input, context);
  assert.equal(schedule.tasks.length, 2, "retry updates the same two tasks");
  await set.dispose();
  store.close();
});

test("missing Schedule package leaves onboarding incomplete when the user opted in", async () => {
  const store = fresh();
  const { set, execute } = finishTool(store, () => undefined);
  await assert.rejects(
    () => execute({
      timeZone: "Europe/Kyiv",
      dailyCheckIn: true,
      dailyMinuteOfDay: 480,
      weeklyReview: false,
    }, context),
    (cause: Error & { code?: string }) => cause.code === "unavailable",
  );
  assert.equal(store.profile().onboardingState, "new");
  await set.dispose();
  store.close();
});

test("onboarding tools are isolated to the Coach project and Space", async () => {
  const store = fresh();
  const registry = createCapabilityContributionRegistry();
  const set = registerCoachOnboardingCapabilities({
    registry,
    space: { spaceId: "space-a" },
    projectId,
    store,
    schedule: () => undefined,
  });
  assert.ok(registry.resolve(context).some((item) => item.kind === "tool" && item.name === "coach_finish_onboarding"));
  assert.equal(registry.resolve({ ...context, projectId: "normal-project" }).length, 0);
  assert.equal(registry.resolve({ ...context, spaceId: "space-b" }).length, 0);
  await set.dispose();
  store.close();
});
