import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoachStore } from "../src/index.ts";
import {
  TODAY_VISIBLE,
  buildCoachHome,
  localDateAt,
  localDayWindow,
  startOfLocalDay,
} from "../src/home.ts";

const fresh = (now: () => number) =>
  createCoachStore(join(mkdtempSync(join(tmpdir(), "polyth-coach-home-")), "coach.db"), { now });

test("local date follows the Coach timezone at a UTC day boundary", () => {
  const instant = Date.parse("2026-09-10T21:30:00Z");
  assert.equal(localDateAt(instant, "UTC").key, "2026-09-10");
  assert.equal(localDateAt(instant, "Europe/Kyiv").key, "2026-09-11");
  assert.equal(localDateAt(instant, "Europe/Kyiv").weekDay, 5);
});

test("the local day window is exact across a DST transition", () => {
  // Europe/Kyiv leaves DST on 2026-10-25: that local day is 25 hours long.
  const dstDay = localDateAt(Date.parse("2026-10-25T09:00:00Z"), "Europe/Kyiv");
  const window = localDayWindow(dstDay, "Europe/Kyiv");
  assert.equal(new Date(window.start).toISOString(), "2026-10-24T21:00:00.000Z");
  assert.equal(new Date(window.end).toISOString(), "2026-10-25T22:00:00.000Z");
  assert.equal(window.end - window.start, 25 * 3_600_000);

  // An ordinary day is 24 hours, and midnight round-trips to the same key.
  const plain = localDateAt(Date.parse("2026-09-11T09:00:00Z"), "Europe/Kyiv");
  const start = startOfLocalDay(plain, "Europe/Kyiv");
  assert.equal(localDateAt(start, "Europe/Kyiv").key, "2026-09-11");
  assert.equal(localDateAt(start - 1, "Europe/Kyiv").key, "2026-09-10");
});

test("an empty day stays empty and the next future action is only Next up", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  const store = fresh(() => now);
  const future = store.createCommitment({
    title: "Thursday next week",
    plannedFor: Date.parse("2026-09-17T10:00:00Z"),
  });

  const home = buildCoachHome(store, { now });
  // The conceptual bug this replaces: `today.focus ?? nextAction` rendered a
  // future commitment as today's primary action.
  assert.equal(home.today.focus, undefined);
  assert.deepEqual(home.today.actions, []);
  assert.equal(home.today.total, 0);
  assert.equal(home.upcoming.next?.id, future.id);
  assert.equal(home.upcoming.total, 1);
  assert.equal(home.attention.overdueTotal, 0);
  store.close();
});

test("today's own action becomes the focus, primary goal first", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  const store = fresh(() => now);
  const background = store.createGoal({ title: "Background" });
  const primary = store.createGoal({ title: "Primary" });
  store.setPrimaryGoal(primary.id);
  const when = Date.parse("2026-09-10T15:00:00Z");

  store.createCommitment({ goalId: background.id, title: "Background A", plannedFor: when });
  const important = store.createCommitment({ goalId: primary.id, title: "Important", plannedFor: when + 2 });

  const home = buildCoachHome(store, { now });
  assert.equal(home.date, "2026-09-10");
  assert.equal(home.today.focus?.id, important.id);
  assert.deepEqual(home.today.actions.map((item) => item.title), ["Important", "Background A"]);
  assert.equal(home.today.total, 2);
  assert.equal(home.attention.overloaded, false);
  assert.equal(home.upcoming.next, undefined);
  store.close();
});

test("overdue work is attention, never silently rescheduled into today", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  const store = fresh(() => now);
  const overdue = store.createCommitment({
    title: "Resolve yesterday",
    plannedFor: Date.parse("2026-09-09T10:00:00Z"),
  });
  const future = store.createCommitment({
    title: "Tomorrow",
    plannedFor: Date.parse("2026-09-11T10:00:00Z"),
  });

  const home = buildCoachHome(store, { now });
  assert.deepEqual(home.today.actions, []);
  assert.equal(home.today.focus, undefined);
  assert.deepEqual(home.attention.overdue.map((item) => item.id), [overdue.id]);
  assert.equal(home.attention.overdueTotal, 1);
  assert.equal(home.upcoming.next?.id, future.id);
  store.close();
});

test("an overloaded day caps the list and still reports the true total", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  const store = fresh(() => now);
  const when = Date.parse("2026-09-10T15:00:00Z");
  for (let i = 0; i < TODAY_VISIBLE + 4; i++) {
    store.createCommitment({ title: `Item ${i}`, plannedFor: when + i });
  }

  const home = buildCoachHome(store, { now });
  assert.equal(home.today.actions.length, TODAY_VISIBLE);
  assert.equal(home.today.total, TODAY_VISIBLE + 4);
  assert.equal(home.attention.overloaded, true);
  store.close();
});

test("an unscheduled goal action is upcoming, not late and not today", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  const store = fresh(() => now);
  const goal = store.createGoal({ title: "Learn Rust" });
  const unscheduled = store.createCommitment({ goalId: goal.id, title: "Read chapter 1" });

  const home = buildCoachHome(store, { now });
  assert.equal(home.today.total, 0);
  assert.equal(home.attention.overdueTotal, 0);
  assert.equal(home.upcoming.total, 1);
  assert.equal(home.upcoming.next?.id, unscheduled.id);
  store.close();
});

test("a due routine can be completed and the day records exactly one occurrence", () => {
  const now = Date.parse("2026-09-10T21:30:00Z"); // Sep 11 in Kyiv (Friday)
  const store = fresh(() => now);
  store.updateProfile({ timeZone: "Europe/Kyiv" });
  const friday = store.createRoutine({ title: "Friday review", cadence: { kind: "weekly", days: [5] } });
  store.createRoutine({ title: "Thursday only", cadence: { kind: "weekly", days: [4] } });

  let home = buildCoachHome(store, { now });
  assert.equal(home.date, "2026-09-11");
  assert.deepEqual(home.today.routines.map((due) => due.routine.id), [friday.id]);
  assert.equal(home.today.routines[0]?.status, undefined, "a due routine starts unresolved");

  store.setRoutineOccurrence({ routineId: friday.id, dateKey: "2026-09-11", status: "done" });
  store.setRoutineOccurrence({ routineId: friday.id, dateKey: "2026-09-11", status: "skipped", reason: "Travelling" });
  home = buildCoachHome(store, { now });
  assert.equal(home.today.routines[0]?.status, "skipped", "re-resolving replaces the day");
  assert.equal(store.listRoutineOccurrences({ routineId: friday.id }).length, 1);

  store.clearRoutineOccurrence(friday.id, "2026-09-11");
  assert.equal(buildCoachHome(store, { now }).today.routines[0]?.status, undefined);
  store.close();
});

test("check-in is absent until recorded and never defaults to a value", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  const store = fresh(() => now);
  assert.equal(buildCoachHome(store, { now }).checkIn, undefined);
  const recorded = store.recordCheckIn({ energy: 4, focus: 5 });
  assert.equal(buildCoachHome(store, { now }).checkIn?.id, recorded.id);
  store.close();
});

test("Home exposes bounded goals, pending suggestion count and one accepted insight", () => {
  let now = 10_000;
  const store = fresh(() => ++now);
  for (let i = 0; i < 5; i++) store.createGoal({ title: `Goal ${i}` });
  const reflection = store.recordReflection({ text: "Earlier work was easier." });
  const evidence = store.listEvents({ entityType: "reflection", entityId: reflection.id })[0]!;
  const insight = store.createInsight({
    statement: "Earlier work may be easier to finish.",
    confidence: "low",
    evidence: [{ eventSeq: evidence.seq }],
  });
  store.setInsightStatus(insight.id, "accepted");
  store.createProposal({ type: "goal", payload: { title: "Proposed" } });

  const home = buildCoachHome(store, { now });
  assert.equal(home.activeGoals.length, 3);
  assert.equal(home.activeGoalTotal, 5);
  assert.equal(home.insight?.id, insight.id);
  assert.equal(home.suggestionCount, 1);
  assert.equal(home.reviewDue, false);
  store.close();
});
