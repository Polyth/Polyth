import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import { createCoachStore, type CoachStore } from "../src/index.ts";
import { personalCoachRoutes } from "../src/routes.ts";

const space = (spaceId: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: `/tmp/${spaceId}`,
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "polyth-coach-routes-"));
  const stores = new Map<string, CoachStore>();
  const forSpace = (ctx: SpaceContext): CoachStore => {
    let store = stores.get(ctx.spaceId);
    if (!store) {
      store = createCoachStore(join(root, ctx.spaceId, "coach.db"));
      stores.set(ctx.spaceId, store);
    }
    return store;
  };
  const route = personalCoachRoutes({ forSpace });
  return {
    route,
    stores,
    close: () => { for (const store of stores.values()) store.close(); },
  };
}

async function invoke(
  route: RouteHandler,
  ctx: SpaceContext,
  target: string,
  method: string,
  input: Record<string, unknown> = {},
): Promise<{ status: number; value: unknown }> {
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
    body: async () => input,
    json: (code, body) => { status = code; value = body; },
  });
  assert.equal(handled, true);
  return { status, value };
}

test("routes scope all state through the gateway-provided Space context", async () => {
  const h = harness();
  const a = space("space-a");
  const b = space("space-b");

  const created = await invoke(h.route, a, "/api/personal-coach/goals", "POST", {
    title: "Private A goal",
    priority: 3,
  });
  assert.equal(created.status, 200);

  const aHome = await invoke(h.route, a, "/api/personal-coach/home", "GET");
  const bHome = await invoke(h.route, b, "/api/personal-coach/home", "GET");
  assert.equal((aHome.value as { activeGoals: unknown[] }).activeGoals.length, 1);
  assert.equal((bHome.value as { activeGoals: unknown[] }).activeGoals.length, 0);
  h.close();
});

test("goal and commitment routes support the deterministic execution loop", async () => {
  const h = harness();
  const ctx = space("space");
  const goalResponse = await invoke(h.route, ctx, "/api/personal-coach/goals", "POST", {
    title: "Ship Coach",
  });
  const goal = goalResponse.value as { id: string };

  const commitmentResponse = await invoke(h.route, ctx, "/api/personal-coach/commitments", "POST", {
    goalId: goal.id,
    title: "Finish API",
    plannedFor: Date.now(),
    estimateMinutes: 30,
  });
  const commitment = commitmentResponse.value as { id: string };
  assert.ok(commitment.id);

  const done = await invoke(
    h.route,
    ctx,
    `/api/personal-coach/commitments/${commitment.id}/complete`,
    "POST",
  );
  assert.equal((done.value as { status: string }).status, "done");

  const listed = await invoke(h.route, ctx, "/api/personal-coach/commitments?status=done", "GET");
  assert.equal((listed.value as { commitments: unknown[] }).commitments.length, 1);

  const activity = await invoke(h.route, ctx, "/api/personal-coach/activity?entityType=commitment", "GET");
  const eventTypes = (activity.value as { events: Array<{ eventType: string }> }).events.map((event) => event.eventType);
  assert.ok(eventTypes.includes("commitment.completed"));
  h.close();
});

test("settings reject an invalid time zone before it reaches persistent state", async () => {
  const h = harness();
  const ctx = space("space");
  await assert.rejects(
    () => invoke(h.route, ctx, "/api/personal-coach/settings", "PUT", { timeZone: "Mars/Olympus" }),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  assert.equal(h.stores.get(ctx.spaceId)?.profile().timeZone, "UTC");

  const updated = await invoke(h.route, ctx, "/api/personal-coach/settings", "PUT", {
    timeZone: "Europe/Kyiv",
    tone: "direct",
    challengeAssumptions: true,
  });
  assert.equal((updated.value as { timeZone: string }).timeZone, "Europe/Kyiv");
  h.close();
});

test("routine and check-in routes stay model-free", async () => {
  const h = harness();
  const ctx = space("space");
  const routine = await invoke(h.route, ctx, "/api/personal-coach/routines", "POST", {
    title: "Spanish",
    cadence: { kind: "weekly", days: [1, 3, 5] },
    preferredMinuteOfDay: 1200,
  });
  assert.deepEqual((routine.value as { cadence: unknown }).cadence, { kind: "weekly", days: [1, 3, 5] });

  const checkIn = await invoke(h.route, ctx, "/api/personal-coach/checkins", "POST", {
    energy: 4,
    focus: 3,
  });
  assert.equal((checkIn.value as { energy: number }).energy, 4);
  h.close();
});

test("unrelated routes are not claimed", async () => {
  const h = harness();
  const handled = await h.route({
    req: {} as never,
    res: {} as never,
    path: "/api/other",
    method: "GET",
    url: new URL("http://local/api/other"),
    ingress: { kind: "internal", serviceId: "test" },
    principal: { kind: "internal-service", serviceId: "test" },
    space: space("space"),
    requireCapability: () => {},
    body: async () => ({}),
    json: () => assert.fail("unrelated route must not respond"),
  });
  assert.equal(handled, false);
  h.close();
});
