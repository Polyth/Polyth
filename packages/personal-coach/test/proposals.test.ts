import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoachStore } from "../src/index.ts";
import { createCoachProposalReviewStore } from "../src/proposals.ts";

const freshFile = () => join(mkdtempSync(join(tmpdir(), "polyth-coach-review-")), "coach.db");

test("accepted commitment proposal materializes atomically and is idempotent", () => {
  let time = 10_000;
  const file = freshFile();
  const coach = createCoachStore(file, { now: () => ++time });
  const review = createCoachProposalReviewStore(file, { now: () => ++time });
  const goal = coach.createGoal({ title: "Spanish B1" });
  const proposal = coach.createProposal({
    type: "commitment",
    payload: {
      goalId: goal.id,
      title: "Practice listening for 30 minutes",
      plannedFor: 50_000,
      estimateMinutes: 30,
    },
    sourceSessionId: "coach-session",
  });

  const decision = review.accept(proposal.id);
  assert.equal(decision.proposal.status, "accepted");
  assert.equal(decision.application?.type, "commitment");
  const commitmentId = decision.application!.id;
  assert.equal(coach.getCommitment(commitmentId)?.title, "Practice listening for 30 minutes");
  assert.equal(coach.getCommitment(commitmentId)?.source, "agent");
  assert.equal(coach.getCommitment(commitmentId)?.sourceSessionId, "coach-session");
  const revision = coach.revision();

  const repeated = review.accept(proposal.id);
  assert.equal(repeated.application?.id, commitmentId);
  assert.equal(coach.revision(), revision);
  assert.equal(coach.listCommitments().filter((item) => item.id === commitmentId).length, 1);
  review.close();
  coach.close();
});

test("invalid proposal payload rolls back status, domain rows, audit, and revision", () => {
  const file = freshFile();
  const coach = createCoachStore(file);
  const review = createCoachProposalReviewStore(file);
  const proposal = coach.createProposal({ type: "goal", payload: { title: "" } });
  const beforeRevision = coach.revision();
  const beforeGoals = coach.listGoals().length;
  const beforeEvents = coach.listEvents().length;

  assert.throws(
    () => review.accept(proposal.id),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  assert.equal(review.getProposal(proposal.id)?.status, "pending");
  assert.equal(coach.listGoals().length, beforeGoals);
  assert.equal(coach.listEvents().length, beforeEvents);
  assert.equal(coach.revision(), beforeRevision);
  review.close();
  coach.close();
});

test("plan-change proposals create append-only versioned plan revisions", () => {
  let time = 20_000;
  const file = freshFile();
  const coach = createCoachStore(file, { now: () => ++time });
  const review = createCoachProposalReviewStore(file, { now: () => ++time });
  const first = coach.createProposal({
    type: "plan-change",
    payload: {
      summary: "Start with three focused sessions per week",
      title: "Spanish study plan",
      changes: { sessionsPerWeek: 3, minutes: 45 },
    },
  });
  const firstDecision = review.accept(first.id);
  assert.equal(firstDecision.application?.type, "plan");
  const planId = firstDecision.application!.id;

  const second = coach.createProposal({
    type: "plan-change",
    payload: {
      planId,
      summary: "Move practice to mornings",
      changes: { preferredMinuteOfDay: 540 },
    },
  });
  const secondDecision = review.accept(second.id);
  assert.equal(secondDecision.application?.id, planId);
  const plan = review.getPlan(planId)!;
  assert.equal(plan.currentRevision, 2);
  assert.deepEqual(plan.revisions.map((item) => item.revision), [1, 2]);
  assert.deepEqual(plan.revisions[1]!.patch, { preferredMinuteOfDay: 540 });
  assert.equal(plan.revisions[1]!.sourceProposalId, second.id);
  review.close();
  coach.close();
});
