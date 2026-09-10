import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createCoachStore } from "../src/index.ts";
import { registerCoachPlanCapabilities } from "../src/planCapabilities.ts";
import { createCoachProposalReviewStore } from "../src/proposals.ts";

const projectId = "__polyth_pkg_plan0123456789abcdef";
const context = {
  sessionId: "coach-session",
  spaceId: "space-a",
  projectId,
  cwd: "/tmp/coach",
};

function fresh() {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-coach-plan-cap-")), "coach.db");
  const store = createCoachStore(file);
  const plans = createCoachProposalReviewStore(file);
  return { store, plans };
}

test("plan capabilities read version history and propose revisions without mutating immediately", async () => {
  const { store, plans } = fresh();
  const initial = store.createProposal({
    type: "plan-change",
    payload: {
      title: "Spanish plan",
      summary: "Start with four short sessions",
      changes: { sessionsPerWeek: 4, minutes: 30 },
    },
    sourceSessionId: "coach-session",
  });
  const firstDecision = plans.accept(initial.id);
  assert.equal(firstDecision.application?.type, "plan");
  const planId = firstDecision.application!.id;

  const registry = createCapabilityContributionRegistry();
  const published: string[] = [];
  const set = registerCoachPlanCapabilities({
    registry,
    space: { spaceId: "space-a" },
    projectId,
    store,
    plans,
    onProposalCreated: async (proposal, ctx) => {
      assert.equal(ctx.sessionId, "coach-session");
      published.push(proposal.id);
    },
  });

  const resolved = registry.resolve(context);
  const list = resolved.find((item) => item.kind === "tool" && item.name === "coach_list_plans")!;
  const revise = resolved.find((item) => item.kind === "tool" && item.name === "coach_propose_plan_revision")!;
  assert.ok(list);
  assert.ok(revise);
  assert.equal(registry.resolve({ ...context, projectId: "ordinary-project" }).length, 0);
  assert.equal(registry.resolve({ ...context, spaceId: "space-b" }).length, 0);

  const listed = JSON.parse((await registry.executor(list.id)!({ planId }, context)).output) as {
    id: string;
    currentRevision: number;
    revisions: Array<{ revision: number }>;
  };
  assert.equal(listed.id, planId);
  assert.equal(listed.currentRevision, 1);
  assert.deepEqual(listed.revisions.map((item) => item.revision), [1]);

  const result = await registry.executor(revise.id)!({
    planId,
    summary: "Move practice earlier",
    changes: { preferredMinuteOfDay: 540 },
    reason: "Evening practice was repeatedly moved",
  }, context);
  const proposal = JSON.parse(result.output) as {
    id: string;
    status: string;
    payload: { planId: string };
  };
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.payload.planId, planId);
  assert.deepEqual(published, [proposal.id]);
  assert.equal(plans.getPlan(planId)?.currentRevision, 1, "proposal must not revise before user acceptance");

  const accepted = plans.accept(proposal.id);
  assert.equal(accepted.application?.id, planId);
  assert.equal(plans.getPlan(planId)?.currentRevision, 2);
  assert.deepEqual(plans.getPlan(planId)?.revisions.map((item) => item.revision), [1, 2]);

  await set.dispose();
  plans.close();
  store.close();
});

test("plan revision rejects unknown plans before creating a proposal", async () => {
  const { store, plans } = fresh();
  const registry = createCapabilityContributionRegistry();
  const set = registerCoachPlanCapabilities({
    registry,
    space: { spaceId: "space-a" },
    projectId,
    store,
    plans,
  });
  const revise = registry.resolve(context).find(
    (item) => item.kind === "tool" && item.name === "coach_propose_plan_revision",
  )!;

  await assert.rejects(
    () => registry.executor(revise.id)!({
      planId: "missing",
      summary: "Change it",
      changes: { anything: true },
    }, context),
    (cause: Error & { code?: string }) => cause.code === "not-found",
  );
  assert.equal(store.listProposals("pending").length, 0);

  await set.dispose();
  plans.close();
  store.close();
});
