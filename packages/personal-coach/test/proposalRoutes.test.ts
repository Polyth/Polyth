import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import { createCoachStore } from "../src/index.ts";
import { createCoachProposalReviewStore } from "../src/proposals.ts";
import { personalCoachProposalRoutes } from "../src/proposalRoutes.ts";

const ctx: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/space-a",
};

async function invoke(route: RouteHandler, target: string, method: string) {
  let status = 0;
  let value: unknown;
  const url = new URL(`http://local${target}`);
  const handled = await route({
    req: {} as never,
    res: {} as never,
    path: url.pathname,
    method,
    url,
    ingress: { kind: "internal", serviceId: "test" },
    principal: { kind: "internal-service", serviceId: "test" },
    space: ctx,
    requireCapability: () => {},
    body: async () => ({}),
    json: (code, body) => { status = code; value = body; },
  });
  assert.equal(handled, true);
  return { status, value };
}

test("proposal review route materializes once and terminal decisions cannot flip", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-proposal-routes-"));
  const file = join(root, "coach.db");
  const coach = createCoachStore(file);
  const review = createCoachProposalReviewStore(file);
  const proposal = coach.createProposal({
    type: "commitment",
    payload: { title: "Practice Spanish for 30 minutes" },
    reason: "Keep the next step concrete",
  });
  const route = personalCoachProposalRoutes({ proposalReviewForSpace: () => review });

  const loaded = await invoke(route, `/api/personal-coach/proposals/${proposal.id}`, "GET");
  assert.equal((loaded.value as { status: string }).status, "pending");

  const accepted = await invoke(route, `/api/personal-coach/proposals/${proposal.id}/accept`, "POST");
  const decision = accepted.value as { proposal: { status: string }; application: { id: string; type: string } };
  assert.equal(decision.proposal.status, "accepted");
  assert.equal(decision.application.type, "commitment");
  assert.equal(coach.getCommitment(decision.application.id)?.title, "Practice Spanish for 30 minutes");
  const revision = coach.revision();

  const repeated = await invoke(route, `/api/personal-coach/proposals/${proposal.id}/accept`, "POST");
  assert.equal((repeated.value as typeof decision).application.id, decision.application.id);
  assert.equal(coach.revision(), revision, "repeated acceptance must not write again");

  await assert.rejects(
    () => invoke(route, `/api/personal-coach/proposals/${proposal.id}/reject`, "POST"),
    (cause: Error & { code?: string }) => cause.code === "conflict",
  );
  review.close();
  coach.close();
});

test("proposal and plan listing are bounded and status is validated", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-proposal-list-"));
  const file = join(root, "coach.db");
  const coach = createCoachStore(file);
  const review = createCoachProposalReviewStore(file);
  const first = coach.createProposal({
    type: "plan-change",
    payload: { summary: "Use mornings", changes: { preferredMinuteOfDay: 540 } },
  });
  coach.createProposal({ type: "goal", payload: { title: "Two" } });
  const route = personalCoachProposalRoutes({ proposalReviewForSpace: () => review });

  const listed = await invoke(route, "/api/personal-coach/proposals?status=pending", "GET");
  assert.equal((listed.value as { proposals: unknown[] }).proposals.length, 2);
  await invoke(route, `/api/personal-coach/proposals/${first.id}/accept`, "POST");
  const plans = await invoke(route, "/api/personal-coach/plans", "GET");
  const plan = (plans.value as { plans: Array<{ id: string }> }).plans[0]!;
  assert.ok(plan.id);
  const detail = await invoke(route, `/api/personal-coach/plans/${plan.id}`, "GET");
  assert.equal((detail.value as { currentRevision: number }).currentRevision, 1);

  await assert.rejects(
    () => invoke(route, "/api/personal-coach/proposals?status=wat", "GET"),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  review.close();
  coach.close();
});
