import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import { createCoachStore } from "../src/index.ts";
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

test("proposal review is durable, idempotent, and terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-proposal-routes-"));
  const store = createCoachStore(join(root, "coach.db"));
  const proposal = store.createProposal({
    type: "commitment",
    payload: { title: "Practice Spanish for 30 minutes" },
    reason: "Keep the next step concrete",
  });
  const route = personalCoachProposalRoutes({ forSpace: () => store });

  const loaded = await invoke(route, `/api/personal-coach/proposals/${proposal.id}`, "GET");
  assert.equal((loaded.value as { status: string }).status, "pending");

  const accepted = await invoke(route, `/api/personal-coach/proposals/${proposal.id}/accept`, "POST");
  assert.equal((accepted.value as { status: string }).status, "accepted");
  const revision = store.revision();

  const repeated = await invoke(route, `/api/personal-coach/proposals/${proposal.id}/accept`, "POST");
  assert.equal((repeated.value as { status: string }).status, "accepted");
  assert.equal(store.revision(), revision, "repeated acceptance must not write another event");

  await assert.rejects(
    () => invoke(route, `/api/personal-coach/proposals/${proposal.id}/reject`, "POST"),
    (cause: Error & { code?: string }) => cause.code === "conflict",
  );
  assert.equal(store.listEvents({ entityType: "proposal", entityId: proposal.id })[0]!.eventType, "proposal.status-changed");
  store.close();
});

test("proposal listing is bounded and validates status", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-proposal-list-"));
  const store = createCoachStore(join(root, "coach.db"));
  store.createProposal({ type: "goal", payload: { title: "One" } });
  store.createProposal({ type: "goal", payload: { title: "Two" } });
  const route = personalCoachProposalRoutes({ forSpace: () => store });

  const listed = await invoke(route, "/api/personal-coach/proposals?status=pending", "GET");
  assert.equal((listed.value as { proposals: unknown[] }).proposals.length, 2);
  await assert.rejects(
    () => invoke(route, "/api/personal-coach/proposals?status=wat", "GET"),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  store.close();
});
