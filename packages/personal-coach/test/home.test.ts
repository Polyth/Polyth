import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoachStore } from "../src/index.ts";
import { buildCoachHome, localDateAt } from "../src/home.ts";

const fresh = (now: () => number) =>
  createCoachStore(join(mkdtempSync(join(tmpdir(), "polyth-coach-home-")), "coach.db"), { now });

test("local date follows the Coach timezone at a UTC day boundary", () => {
  const instant = Date.parse("2026-09-10T21:30:00Z");
  assert.equal(localDateAt(instant, "UTC").key, "2026-09-10");
  assert.equal(localDateAt(instant, "Europe/Kyiv").key, "2026-09-11");
  assert.equal(localDateAt(instant, "Europe/Kyiv").weekDay, 5);
});

test("Home keeps Today bounded and prioritizes the most important goal", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  const store = fresh(() => now);
  const low = store.createGoal({ title: "Low priority", priority: 1 });
  const high = store.createGoal({ title: "High priority", priority: 3 });
  const when = Date.parse("2026-09-10T15:00:00Z");

  store.createCommitment({ goalId: low.id, title: "Low A", plannedFor: when });
  store.createCommitment({ goalId: low.id, title: "Low B", plannedFor: when + 1 });
  const important = store.createCommitment({ goalId: high.id, title: "Important", plannedFor: when + 2 });
  store.createCommitment({ goalId: low.id, title: "Low C", plannedFor: when + 3 });

  const home = buildCoachHome(store, { now });
  assert.equal(home.date, "2026-09-10");
  assert.equal(home.today.commitments.length, 3);
  assert.equal(home.today.overflowCount, 1);
  assert.equal(home.today.mainFocus?.id, important.id);
  assert.equal(home.nextAction?.id, important.id);
  assert.deepEqual(home.attention, { kind: "overloaded", count: 4 });
  store.close();
});

test("Home surfaces overdue attention before future work", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  const store = fresh(() => now);
  const overdue = store.createCommitment({
    title: "Resolve yesterday",
    plannedFor: Date.parse("2026-09-09T10:00:00Z"),
  });
  store.createCommitment({
    title: "Tomorrow",
    plannedFor: Date.parse("2026-09-11T10:00:00Z"),
  });

  const home = buildCoachHome(store, { now });
  assert.equal(home.today.commitments.length, 0);
  assert.equal(home.today.overdueCount, 1);
  assert.equal(home.nextAction?.id, overdue.id);
  assert.deepEqual(home.attention, { kind: "overdue", count: 1 });
  store.close();
});

test("Home computes weekly routines and today's check-in without materializing occurrences", () => {
  const now = Date.parse("2026-09-10T21:30:00Z"); // Sep 11 in Kyiv (Friday)
  const store = fresh(() => now);
  store.updateProfile({ timeZone: "Europe/Kyiv" });
  const friday = store.createRoutine({
    title: "Friday review",
    cadence: { kind: "weekly", days: [5] },
  });
  store.createRoutine({
    title: "Thursday only",
    cadence: { kind: "weekly", days: [4] },
  });
  const checkIn = store.recordCheckIn({ energy: 4, focus: 5 });

  const home = buildCoachHome(store, { now });
  assert.equal(home.date, "2026-09-11");
  assert.deepEqual(home.today.dueRoutines.map((routine) => routine.id), [friday.id]);
  assert.equal(home.lastCheckIn?.id, checkIn.id);
  store.close();
});

test("Home exposes at most three active goals and one accepted insight", () => {
  let now = 10_000;
  const store = fresh(() => ++now);
  for (let i = 0; i < 5; i++) store.createGoal({ title: `Goal ${i}`, priority: 2 });
  const reflection = store.recordReflection({ text: "Earlier work was easier." });
  const evidence = store.listEvents({ entityType: "reflection", entityId: reflection.id })[0]!;
  const insight = store.createInsight({
    statement: "Earlier work may be easier to finish.",
    confidence: "low",
    evidence: [{ eventSeq: evidence.seq }],
  });
  store.setInsightStatus(insight.id, "accepted");

  const home = buildCoachHome(store, { now });
  assert.equal(home.activeGoals.length, 3);
  assert.equal(home.insight?.id, insight.id);
  assert.equal(home.reviewDue, false);
  store.close();
});
