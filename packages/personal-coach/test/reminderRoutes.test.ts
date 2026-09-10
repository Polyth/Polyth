import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Project,
  ProjectService,
  RouteHandler,
  SpaceContext,
  SpaceStorage,
} from "@polyth/contracts";
import type {
  CoachScheduleService,
  CoachScheduleTask,
} from "../src/onboarding.ts";
import { personalCoachReminderRoutes } from "../src/reminderRoutes.ts";
import { createPersonalCoachService } from "../src/service.ts";

const space = (root: string): SpaceContext => ({
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: root,
});

function fakeSchedule() {
  let next = 1;
  const tasks: Array<CoachScheduleTask & Record<string, unknown>> = [];
  const service: CoachScheduleService = {
    list: (projectId) => tasks.filter((task) => projectId === undefined || task.projectId === projectId),
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
    setEnabled(id, enabled) {
      const task = tasks.find((item) => item.id === id);
      if (!task) throw Object.assign(new Error("missing task"), { code: "not-found" });
      task.enabled = enabled;
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

function harness(schedule: CoachScheduleService | undefined) {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-reminders-"));
  const ctx = space(root);
  const anchor: Project = {
    id: "__polyth_pkg_reminders0123456789abcdef",
    path: join(root, "packages", "personal-coach", "workspace"),
    name: "personal-coach workspace",
    spaceId: ctx.spaceId,
    createdAt: 1,
  };
  let workspaceCalls = 0;
  const projects = {
    async ensurePackageWorkspace(input: { spaceId: string; packageId: string; path: string }) {
      workspaceCalls++;
      assert.equal(input.spaceId, ctx.spaceId);
      assert.equal(input.packageId, "personal-coach");
      assert.equal(input.path, anchor.path);
      return anchor;
    },
    async get(id: string) { return id === anchor.id ? anchor : undefined; },
  } as unknown as ProjectService;
  const storage: SpaceStorage = {
    root,
    packageDir(packageId) { return join(root, "packages", packageId); },
    path(relative) { return join(root, relative); },
  };
  const coach = createPersonalCoachService({ storageFor: () => storage, projects });
  const prepared: string[] = [];
  const route = personalCoachReminderRoutes({
    pluginId: "personal-coach",
    projects,
    spaceStorage: () => storage,
  }, {
    coach,
    schedule: () => schedule,
    ensureCapabilities: async (_space, projectId) => { prepared.push(projectId); },
  });
  return { root, ctx, anchor, coach, prepared, route, workspaceCalls: () => workspaceCalls };
}

async function invoke(
  route: RouteHandler,
  ctx: SpaceContext,
  method: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; value: unknown }> {
  let status = 0;
  let value: unknown;
  const handled = await route({
    req: {} as never,
    res: {} as never,
    path: "/api/personal-coach/reminders",
    method,
    url: new URL("http://local/api/personal-coach/reminders"),
    ingress: { kind: "internal", serviceId: "test" },
    principal: { kind: "internal-service", serviceId: "test" },
    space: ctx,
    requireCapability: () => {},
    body: async () => body,
    json: (code, response) => { status = code; value = response; },
  });
  assert.equal(handled, true);
  return { status, value };
}

test("reminder settings round-trip through the existing Schedule service", async () => {
  const schedule = fakeSchedule();
  const h = harness(schedule.service);
  h.coach.forSpace(h.ctx).updateProfile({ timeZone: "Europe/Kyiv", onboardingState: "complete" });

  const initial = await invoke(h.route, h.ctx, "GET");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.value, {
    available: true,
    settings: {
      dailyCheckIn: { enabled: false, minuteOfDay: 480 },
      weeklyReview: { enabled: false, day: 0, minuteOfDay: 1080 },
      timeZone: "Europe/Kyiv",
    },
  });

  const saved = await invoke(h.route, h.ctx, "PUT", {
    dailyCheckIn: true,
    dailyMinuteOfDay: 8 * 60 + 30,
    weeklyReview: true,
    weeklyDay: 0,
    weeklyMinuteOfDay: 18 * 60,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(h.prepared, [h.anchor.id]);
  assert.equal(schedule.tasks.length, 2);
  const daily = schedule.tasks.find((task) => task.title === "Coach · Daily check-in")!;
  const weekly = schedule.tasks.find((task) => task.title === "Coach · Weekly review")!;
  assert.deepEqual(daily.cadence, { kind: "cron", expression: "30 8 * * *", timeZone: "Europe/Kyiv" });
  assert.deepEqual(weekly.cadence, { kind: "cron", expression: "0 18 * * 0", timeZone: "Europe/Kyiv" });

  const reread = await invoke(h.route, h.ctx, "GET");
  assert.deepEqual((reread.value as { settings: unknown }).settings, {
    dailyCheckIn: { enabled: true, minuteOfDay: 510 },
    weeklyReview: { enabled: true, day: 0, minuteOfDay: 1080 },
    timeZone: "Europe/Kyiv",
  });
  h.coach.close();
});

test("reminder mutation requires completed onboarding and validates before scheduling", async () => {
  const schedule = fakeSchedule();
  const h = harness(schedule.service);
  await assert.rejects(
    () => invoke(h.route, h.ctx, "PUT", {
      dailyCheckIn: true,
      dailyMinuteOfDay: 480,
      weeklyReview: false,
      weeklyDay: 0,
      weeklyMinuteOfDay: 1080,
    }),
    (cause: Error & { code?: string }) => cause.code === "conflict",
  );
  assert.equal(schedule.tasks.length, 0);

  h.coach.forSpace(h.ctx).updateProfile({ onboardingState: "complete" });
  await assert.rejects(
    () => invoke(h.route, h.ctx, "PUT", {
      dailyCheckIn: true,
      dailyMinuteOfDay: 2000,
      weeklyReview: false,
      weeklyDay: 0,
      weeklyMinuteOfDay: 1080,
    }),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  assert.equal(schedule.tasks.length, 0);
  assert.equal(h.prepared.length, 0, "invalid input must fail before runtime capability preparation");
  h.coach.close();
});

test("missing Schedule reports unavailable without creating a package workspace", async () => {
  const h = harness(undefined);
  h.coach.forSpace(h.ctx).updateProfile({ onboardingState: "complete" });
  const response = await invoke(h.route, h.ctx, "GET");
  assert.deepEqual(response.value, { available: false });
  assert.equal(h.workspaceCalls(), 0);
  h.coach.close();
});
