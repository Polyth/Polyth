import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoachStore } from "../src/index.ts";

const freshFile = () => join(mkdtempSync(join(tmpdir(), "polyth-coach-")), "coach.db");

test("profile defaults are lightweight and updates persist with revision/event", () => {
  const file = freshFile();
  const store = createCoachStore(file, { now: () => 1000 });
  assert.deepEqual(store.profile(), {
    tone: "balanced",
    initiative: "balanced",
    timeZone: "UTC",
    challengeAssumptions: false,
    onboardingState: "new",
    updatedAt: 0,
  });
  assert.equal(store.revision(), 0);

  const profile = store.updateProfile({ tone: "direct", timeZone: "Europe/Kyiv", onboardingState: "started" });
  assert.equal(profile.tone, "direct");
  assert.equal(profile.timeZone, "Europe/Kyiv");
  assert.equal(store.revision(), 1);
  assert.equal(store.listEvents()[0]!.eventType, "profile.updated");
  store.close();

  const reopened = createCoachStore(file);
  assert.equal(reopened.profile().tone, "direct");
  assert.equal(reopened.profile().timeZone, "Europe/Kyiv");
  assert.equal(reopened.revision(), 1);
  reopened.close();
});

test("areas, goals, and milestones preserve relationships", () => {
  let t = 100;
  const store = createCoachStore(freshFile(), { now: () => ++t });
  const area = store.createArea({ title: "Learning" });
  const goal = store.createGoal({
    areaId: area.id,
    title: "Reach Spanish B1",
    desiredOutcome: "Comfortably understand B1 conversations",
    priority: 3,
  });
  const milestone = store.createMilestone({ goalId: goal.id, title: "Finish B1 listening course" });

  assert.equal(store.listGoals("active")[0]!.areaId, area.id);
  assert.equal(store.listMilestones(goal.id)[0]!.id, milestone.id);
  assert.equal(store.updateMilestone(milestone.id, { status: "done" }).status, "done");
  assert.equal(store.updateGoal(goal.id, { status: "paused", areaId: null }).areaId, undefined);

  assert.throws(
    () => store.createGoal({ areaId: "foreign", title: "Nope" }),
    (cause: Error & { code?: string }) => cause.code === "not-found",
  );
  assert.throws(
    () => store.createMilestone({ goalId: "foreign", title: "Nope" }),
    (cause: Error & { code?: string }) => cause.code === "not-found",
  );
  store.close();
});

test("commitment lifecycle is deterministic, idempotent, and audited", () => {
  let t = 1000;
  const store = createCoachStore(freshFile(), { now: () => ++t });
  const goal = store.createGoal({ title: "Ship Coach" });
  const commitment = store.createCommitment({
    goalId: goal.id,
    title: "Finish storage layer",
    plannedFor: 10_000,
    estimateMinutes: 45,
  });
  const afterCreateRevision = store.revision();

  const moved = store.rescheduleCommitment(commitment.id, 20_000, "Need to finish API first");
  assert.equal(moved.plannedFor, 20_000);
  assert.equal(moved.lastReason, "Need to finish API first");

  const done = store.completeCommitment(commitment.id);
  assert.equal(done.status, "done");
  assert.ok(done.completedAt);
  const afterDoneRevision = store.revision();
  assert.equal(store.completeCommitment(commitment.id).status, "done");
  assert.equal(store.revision(), afterDoneRevision, "idempotent completion emits no duplicate event");
  assert.ok(afterDoneRevision > afterCreateRevision);

  assert.throws(
    () => store.rescheduleCommitment(commitment.id, 30_000),
    (cause: Error & { code?: string }) => cause.code === "conflict",
  );

  const events = store.listEvents({ entityType: "commitment", entityId: commitment.id });
  assert.deepEqual(events.map((event) => event.eventType), [
    "commitment.completed",
    "commitment.rescheduled",
    "commitment.created",
  ]);
  store.close();
});

test("skipped commitments can be deliberately rescheduled but cancelled ones cannot", () => {
  const store = createCoachStore(freshFile());
  const commitment = store.createCommitment({ title: "Practice Spanish" });
  assert.equal(store.skipCommitment(commitment.id, "No time").status, "skipped");
  assert.equal(store.rescheduleCommitment(commitment.id, 50_000).status, "open");
  assert.equal(store.cancelCommitment(commitment.id, "No longer relevant").status, "cancelled");
  assert.throws(() => store.completeCommitment(commitment.id), /cancelled commitment/);
  store.close();
});

test("routines stay definitions rather than materialized occurrences", () => {
  const store = createCoachStore(freshFile());
  const routine = store.createRoutine({
    title: "Spanish listening",
    cadence: { kind: "weekly", days: [4, 1, 1, 6] },
    preferredMinuteOfDay: 20 * 60,
  });
  assert.deepEqual(routine.cadence, { kind: "weekly", days: [1, 4, 6] });
  assert.equal(routine.preferredMinuteOfDay, 1200);
  assert.equal(store.updateRoutine(routine.id, { status: "paused" }).status, "paused");
  assert.throws(
    () => store.createRoutine({ title: "Bad", cadence: { kind: "weekly", days: [] } }),
    /at least one day/,
  );
  store.close();
});

test("check-ins, reflections, insights and proposals are bounded durable records", () => {
  let t = 5000;
  const store = createCoachStore(freshFile(), { now: () => ++t });
  const checkIn = store.recordCheckIn({ energy: 4, focus: 3, note: "Good morning" });
  const reflection = store.recordReflection({ kind: "daily", text: "Starting earlier worked." });
  assert.equal(store.listCheckIns()[0]!.id, checkIn.id);
  assert.equal(store.listReflections()[0]!.id, reflection.id);

  const evidenceSeq = store.listEvents({ entityType: "reflection", entityId: reflection.id })[0]!.seq;
  const insight = store.createInsight({
    statement: "Earlier work may be easier to complete.",
    confidence: "low",
    evidence: [{ eventSeq: evidenceSeq }],
  });
  assert.equal(insight.status, "candidate");
  assert.equal(store.setInsightStatus(insight.id, "accepted").status, "accepted");

  const proposal = store.createProposal({
    type: "plan-change",
    payload: { moveToMinuteOfDay: 540 },
    reason: "Try the work earlier",
  });
  assert.equal(proposal.status, "pending");
  assert.deepEqual(proposal.payload, { moveToMinuteOfDay: 540 });
  assert.equal(store.setProposalStatus(proposal.id, "rejected").status, "rejected");

  assert.throws(() => store.recordCheckIn({ energy: 0, focus: 3 }), /energy/);
  assert.throws(() => store.createInsight({ statement: "Guess", confidence: "low", evidence: [] }), /evidence/);
  store.close();
});

test("failed validation does not mutate revision or event history", () => {
  const store = createCoachStore(freshFile());
  const beforeRevision = store.revision();
  const beforeEvents = store.listEvents().length;
  assert.throws(() => store.createGoal({ title: "" }), /title is required/);
  assert.equal(store.revision(), beforeRevision);
  assert.equal(store.listEvents().length, beforeEvents);
  store.close();
});

test("separate Space database paths do not leak ids or state", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-spaces-"));
  const a = createCoachStore(join(root, "space-a", "packages", "personal-coach", "coach.db"));
  const b = createCoachStore(join(root, "space-b", "packages", "personal-coach", "coach.db"));
  const goal = a.createGoal({ title: "Private goal" });
  assert.equal(a.getGoal(goal.id)?.title, "Private goal");
  assert.equal(b.getGoal(goal.id), undefined);
  assert.equal(b.listGoals().length, 0);
  a.close();
  b.close();
});
