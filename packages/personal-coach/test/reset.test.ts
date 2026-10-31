import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoachStore } from "../src/index.ts";
import { resetCoachData } from "../src/maintenance.ts";
import { createCoachProposalReviewStore } from "../src/proposals.ts";

test("reset clears durable Coach state while preserving user preferences", () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-coach-reset-")), "coach.db");
  let now = 1000;
  const store = createCoachStore(file, { now: () => ++now });
  const reviews = createCoachProposalReviewStore(file, { now: () => ++now });
  store.updateProfile({
    tone: "direct",
    initiative: "proactive",
    timeZone: "Europe/Kyiv",
    challengeAssumptions: true,
    onboardingState: "complete",
  });
  const goal = store.createGoal({ title: "Private goal", priority: 3 });
  store.createCommitment({ goalId: goal.id, title: "Do something", plannedFor: 5000 });
  const routine = store.createRoutine({ goalId: goal.id, title: "Practice", cadence: { kind: "daily" } });
  store.setRoutineOccurrence({ routineId: routine.id, dateKey: "2026-09-10", status: "done" });
  store.setCanonicalSessionId("session-before-reset");
  const reflection = store.recordReflection({ text: "A private reflection" });
  const evidence = store.listEvents({ entityType: "reflection", entityId: reflection.id })[0]!;
  store.createInsight({ statement: "Possible private pattern", confidence: "low", evidence: [{ eventSeq: evidence.seq }] });
  const proposal = store.createProposal({
    type: "plan-change",
    payload: { title: "Plan", summary: "Start plan", changes: { sessions: 3 } },
  });
  const accepted = reviews.accept(proposal.id);
  assert.equal(accepted.application?.type, "plan");
  assert.equal(reviews.listPlans().length, 1);
  const beforeRevision = store.revision();

  const result = resetCoachData(file, { now: () => 10_000 });
  assert.equal(result.resetAt, 10_000);
  assert.ok(result.revision > beforeRevision);
  assert.equal(store.listGoals().length, 0);
  assert.equal(store.listCommitments().length, 0);
  assert.equal(store.listRoutines().length, 0);
  assert.equal(store.listReflections().length, 0);
  assert.equal(store.listInsights().length, 0);
  assert.equal(store.listProposals().length, 0);
  assert.equal(reviews.listPlans().length, 0);
  assert.equal(store.listRoutineOccurrences({}).length, 0, "routine history is Coach state and is cleared");
  // The next "Ask Coach" must start fresh: resuming a chat whose injected
  // context describes deleted goals would be worse than no chat at all.
  assert.equal(store.canonicalSessionId(), undefined);
  assert.deepEqual(store.profile(), {
    tone: "direct",
    initiative: "proactive",
    timeZone: "Europe/Kyiv",
    challengeAssumptions: true,
    onboardingState: "new",
    updatedAt: 10_000,
  });
  const events = store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventType, "coach.reset");
  assert.deepEqual(events[0]?.payload, { preservedPreferences: true });

  reviews.close();
  store.close();
});
