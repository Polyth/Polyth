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
import {
  configureCoachReminders,
  type CoachScheduleService,
  type CoachScheduleTask,
} from "../src/onboarding.ts";
import { personalCoachResetRoute } from "../src/resetRoute.ts";
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

async function invoke(route: RouteHandler, ctx: SpaceContext): Promise<{ status: number; value: unknown }> {
  let status = 0;
  let value: unknown;
  const handled = await route({
    req: {} as never,
    res: {} as never,
    path: "/api/personal-coach/reset",
    method: "POST",
    url: new URL("http://local/api/personal-coach/reset"),
    ingress: { kind: "internal", serviceId: "test" },
    principal: { kind: "internal-service", serviceId: "test" },
    space: ctx,
    requireCapability: () => {},
    body: async () => ({}),
    json: (code, response) => { status = code; value = response; },
  });
  assert.equal(handled, true);
  return { status, value };
}

test("reset removes Coach-owned schedules before clearing Space-scoped state", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-reset-route-"));
  const ctx = space(root);
  const anchor: Project = {
    id: "__polyth_pkg_reset0123456789abcdef",
    path: join(root, "packages", "personal-coach", "workspace"),
    name: "personal-coach workspace",
    spaceId: ctx.spaceId,
    createdAt: 1,
  };
  const projects = {
    async ensurePackageWorkspace(input: { spaceId: string; packageId: string; path: string }) {
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
  const store = coach.forSpace(ctx);
  store.updateProfile({
    timeZone: "Europe/Kyiv",
    tone: "direct",
    onboardingState: "complete",
  });
  store.createGoal({ title: "Private goal" });
  const schedule = fakeSchedule();
  configureCoachReminders(schedule.service, anchor.id, {
    timeZone: "Europe/Kyiv",
    dailyCheckIn: { enabled: true, minuteOfDay: 510 },
    weeklyReview: { enabled: true, day: 0, minuteOfDay: 1080 },
  });
  // A non-Coach task on the same internal project is not owned by Reset.
  schedule.service.create({
    projectId: anchor.id,
    prompt: "Other package/system work",
    cadence: { kind: "cron", expression: "0 12 * * *", timeZone: "Europe/Kyiv" },
    target: { mode: "new-session-per-run" },
    overlapPolicy: "skip",
    title: "Other scheduled work",
    enabled: true,
  });

  const route = personalCoachResetRoute({
    pluginId: "personal-coach",
    projects,
    spaceStorage: () => storage,
  }, { coach, schedule: () => schedule.service });
  const response = await invoke(route, ctx);

  assert.equal(response.status, 200);
  assert.equal(store.listGoals().length, 0);
  assert.equal(store.profile().onboardingState, "new");
  assert.equal(store.profile().tone, "direct");
  assert.equal(store.profile().timeZone, "Europe/Kyiv");
  assert.deepEqual(schedule.tasks.map((task) => task.title), ["Other scheduled work"]);
  coach.close();
});

test("reset works without Schedule and does not require a runtime workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-reset-route-"));
  const ctx = space(root);
  let workspaceCreated = false;
  const projects = {
    async ensurePackageWorkspace() {
      workspaceCreated = true;
      throw new Error("should not create workspace");
    },
  } as unknown as ProjectService;
  const storage: SpaceStorage = {
    root,
    packageDir(packageId) { return join(root, "packages", packageId); },
    path(relative) { return join(root, relative); },
  };
  const coach = createPersonalCoachService({ storageFor: () => storage, projects });
  coach.forSpace(ctx).createGoal({ title: "Goal" });
  const route = personalCoachResetRoute({
    pluginId: "personal-coach",
    projects,
    spaceStorage: () => storage,
  }, { coach, schedule: () => undefined });

  await invoke(route, ctx);
  assert.equal(workspaceCreated, false);
  assert.equal(coach.forSpace(ctx).listGoals().length, 0);
  coach.close();
});
