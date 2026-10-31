import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import type { ProjectService, SpaceContext, SpaceRole, SpaceStorage, ToolExecutionContext } from "@polyth/contracts";
import { registerCoachCapabilities } from "../src/capabilities.ts";
import { createCoachStore } from "../src/index.ts";
import { configureCoachReminders, readCoachReminders, pauseUnownedCoachSchedules, type CoachScheduleService, type CoachScheduleTask } from "../src/onboarding.ts";
import { createPersonalCoachService } from "../src/service.ts";
import { fakePeople, personFile } from "./fakePeople.ts";

const person = (root: string, userId: string, spaceId = "space-a", role: SpaceRole = "member"): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId,
  role,
  deployment: "local-trusted",
  storageDir: root,
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-people-"));
  const storage: SpaceStorage = {
    root,
    packageDir(packageId) {
      const dir = join(root, "packages", packageId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    path: (relative) => join(root, relative),
  };
  const coach = createPersonalCoachService({
    storageFor: () => storage,
    projects: {} as ProjectService,
    people: () => fakePeople(root),
  });
  return { root, storage, coach };
}

test("two people in one Space keep separate Coach data", () => {
  const { root, coach } = harness();
  coach.forSpace(person(root, "alice")).createGoal({ title: "Alice private goal" });
  assert.equal(coach.forSpace(person(root, "bob")).listGoals().length, 0);
  coach.forSpace(person(root, "bob")).createGoal({ title: "Bob goal" });
  assert.deepEqual(coach.forSpace(person(root, "alice")).listGoals().map((g) => g.title), ["Alice private goal"]);
  assert.ok(existsSync(personFile(root, "alice", "space-a")));
  assert.ok(existsSync(personFile(root, "bob", "space-a")));
  coach.close();
});

test("the same person has separate data in each Space", () => {
  const { root, coach } = harness();
  coach.forSpace(person(root, "alice", "space-a")).createGoal({ title: "Work goal" });
  assert.equal(coach.forSpace(person(root, "alice", "space-b")).listGoals().length, 0);
  coach.close();
});

test("system work and malformed ids are refused", () => {
  const { root, coach } = harness();
  for (const userId of ["system:schedule", "", "../alice"]) {
    assert.throws(() => coach.forSpace(person(root, userId)), (cause: Error) => cause.message.length > 0);
  }
  assert.throws(
    () => coach.forSpace({ ...person(root, "alice"), authority: { kind: "system" } } as SpaceContext),
    (cause: Error & { code?: string }) => cause.code === "forbidden",
  );
  assert.throws(
    () => coach.forSpace(person(root, "alice", "../space-b")),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  coach.close();
});

test("a host without person storage fails closed", () => {
  const { root, storage } = harness();
  const coach = createPersonalCoachService({ storageFor: () => storage, projects: {} as ProjectService, people: () => undefined });
  assert.throws(() => coach.forSpace(person(root, "alice")), (cause: Error & { code?: string }) => cause.code === "unavailable");
});

function seedLegacy(storage: SpaceStorage, title: string): string {
  const file = join(storage.packageDir("personal-coach"), "coach.db");
  const store = createCoachStore(file);
  store.createGoal({ title });
  store.close();
  return file;
}

test("the legacy Space database moves to the first owner access; others start empty", () => {
  const { root, storage, coach } = harness();
  const legacy = seedLegacy(storage, "Legacy goal");
  // A member opening first neither sees nor takes the legacy data.
  assert.equal(coach.forSpace(person(root, "bob", "space-a", "member")).listGoals().length, 0);
  assert.equal(coach.forSpace(person(root, "carol", "space-a", "admin")).listGoals().length, 0);
  assert.ok(existsSync(legacy), "legacy database stays put until the owner arrives");
  const owner = coach.forSpace(person(root, "alice", "space-a", "owner"));
  assert.deepEqual(owner.listGoals().map((g) => g.title), ["Legacy goal"]);
  assert.equal(existsSync(legacy), false);
  // Idempotent and still private.
  assert.deepEqual(coach.forSpace(person(root, "alice", "space-a", "owner")).listGoals().map((g) => g.title), ["Legacy goal"]);
  assert.equal(coach.forSpace(person(root, "bob")).listGoals().length, 0);
  coach.close();
});

test("a legacy database is never moved into another Space's owner or over an existing database", () => {
  const { root, storage, coach } = harness();
  const legacy = seedLegacy(storage, "Legacy goal");
  // Owner already has data for this Space: legacy is left alone, not overwritten.
  mkdirSync(join(root, "people", "alice", "packages", "personal-coach", "spaces", "space-a"), { recursive: true });
  createCoachStore(personFile(root, "alice", "space-a")).close();
  assert.equal(coach.forSpace(person(root, "alice", "space-a", "owner")).listGoals().length, 0);
  assert.ok(existsSync(legacy));
  coach.close();
});

test("agent tools open the acting person's store and refuse system work", async () => {
  const { root, coach } = harness();
  const registry = createCapabilityContributionRegistry();
  const projectId = "__polyth_pkg_0123456789abcdef0123456789abcdef";
  const members = new Map([["alice", person(root, "alice")], ["bob", person(root, "bob")]]);
  registerCoachCapabilities({
    registry,
    space: { spaceId: "space-a" },
    projectId,
    storeFor: (ctx: ToolExecutionContext) => {
      const found = ctx.actorUserId ? members.get(ctx.actorUserId) : undefined;
      if (!found) throw Object.assign(new Error("no acting person"), { code: "forbidden" });
      return coach.forSpace(found);
    },
  });
  coach.forSpace(members.get("alice")!).createGoal({ title: "Alice goal" });
  const base = { sessionId: "s", spaceId: "space-a", projectId, cwd: "/tmp" };
  const list = registry.resolve(base).find((item) => item.kind === "tool" && item.name === "coach_list_goals")!;
  const run = registry.executor(list.id)!;
  const alice = JSON.parse((await run({}, { ...base, actorUserId: "alice" })).output) as { goals: Array<{ title: string }> };
  const bob = JSON.parse((await run({}, { ...base, actorUserId: "bob" })).output) as { goals: unknown[] };
  assert.deepEqual(alice.goals.map((g) => g.title), ["Alice goal"]);
  assert.equal(bob.goals.length, 0);
  await assert.rejects(() => run({}, base), (cause: Error & { code?: string }) => cause.code === "forbidden");
  coach.close();
});

function memorySchedule() {
  let next = 1;
  const tasks: Array<CoachScheduleTask & Record<string, unknown>> = [];
  const service: CoachScheduleService = {
    list: (projectId) => tasks.filter((task) => projectId === undefined || task.projectId === projectId),
    create(input) { const task = { id: `t${next++}`, ...input }; tasks.push(task); return task; },
    update(id, patch) { const task = tasks.find((t) => t.id === id)!; Object.assign(task, patch); return task; },
    setEnabled(id, enabled) { const task = tasks.find((t) => t.id === id)!; task.enabled = enabled; return task; },
    remove(id) { const i = tasks.findIndex((t) => t.id === id); if (i < 0) return false; tasks.splice(i, 1); return true; },
    preview: () => ({}),
  };
  return { service, tasks };
}

test("reminders are scoped to the person; legacy unowned tasks are replaced or paused", () => {
  const { service, tasks } = memorySchedule();
  const settings = {
    timeZone: "Europe/Kyiv",
    dailyCheckIn: { enabled: true, minuteOfDay: 480 },
    weeklyReview: { enabled: false, day: 0, minuteOfDay: 1080 },
  };
  service.create({ projectId: "p", ownerUserId: "", prompt: "old", cadence: { kind: "cron", expression: "0 8 * * *", timeZone: "UTC" }, target: { mode: "new-session-per-run" }, overlapPolicy: "skip", title: "Coach · Daily check-in", enabled: true });
  delete tasks[0]!.ownerUserId;
  assert.equal(pauseUnownedCoachSchedules(service, "p"), 1);
  assert.equal(tasks[0]!.enabled, false);
  configureCoachReminders(service, "p", "alice", settings);
  assert.equal(tasks.filter((t) => t.ownerUserId === "alice").length, 1);
  assert.equal(tasks.some((t) => !t.ownerUserId), false, "legacy task was replaced");
  assert.equal(readCoachReminders(service, "p", "alice", "Europe/Kyiv").dailyCheckIn.enabled, true);
  assert.equal(readCoachReminders(service, "p", "bob", "Europe/Kyiv").dailyCheckIn.enabled, false);
  configureCoachReminders(service, "p", "bob", { ...settings, dailyCheckIn: { enabled: false, minuteOfDay: 480 } });
  assert.equal(tasks.filter((t) => t.ownerUserId === "alice").length, 1, "bob cannot remove alice's reminder");
});
