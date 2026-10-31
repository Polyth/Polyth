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

test("direct commitment creation cannot forge agent/import provenance", async () => {
  const h = harness();
  const ctx = space("space");
  const response = await invoke(h.route, ctx, "/api/personal-coach/commitments", "POST", {
    title: "Client-created commitment",
    source: "agent",
    sourceSessionId: "forged-session",
  });
  assert.equal((response.value as { source: string }).source, "user");
  assert.equal((response.value as { sourceSessionId?: string }).sourceSessionId, undefined);
  h.close();
});

test("settings reject invalid zones and do not expose onboardingState as a client mutation", async () => {
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
    onboardingState: "complete",
  });
  assert.equal((updated.value as { timeZone: string }).timeZone, "Europe/Kyiv");
  assert.equal((updated.value as { onboardingState: string }).onboardingState, "new");
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

test("a goal next action can be created unscheduled and later moved to today", async () => {
  const h = harness();
  const ctx = space("unscheduled");
  const goal = (await invoke(h.route, ctx, "/api/personal-coach/goals", "POST", { title: "Learn Rust" })).value as { id: string };
  const action = (await invoke(h.route, ctx, "/api/personal-coach/commitments", "POST", {
    goalId: goal.id,
    title: "Read chapter 1",
  })).value as { id: string; plannedFor?: number };
  // "Next action toward a goal" is not "a commitment for today": creating one
  // must not silently stamp it with the current time.
  assert.equal(action.plannedFor, undefined);

  const home = (await invoke(h.route, ctx, "/api/personal-coach/home", "GET")).value as {
    today: { total: number }; upcoming: { total: number; next?: { id: string } };
  };
  assert.equal(home.today.total, 0);
  assert.equal(home.upcoming.next?.id, action.id);

  // Moving it to today is an explicit user choice.
  await invoke(h.route, ctx, `/api/personal-coach/commitments/${action.id}/reschedule`, "POST", { plannedFor: Date.now() });
  const after = (await invoke(h.route, ctx, "/api/personal-coach/home", "GET")).value as { today: { total: number; focus?: { id: string } } };
  assert.equal(after.today.total, 1);
  assert.equal(after.today.focus?.id, action.id);
  h.close();
});

test("primary goal is a single explicit choice that drives server ordering", async () => {
  const h = harness();
  const ctx = space("primary");
  const first = (await invoke(h.route, ctx, "/api/personal-coach/goals", "POST", { title: "First" })).value as { id: string };
  const second = (await invoke(h.route, ctx, "/api/personal-coach/goals", "POST", { title: "Second" })).value as { id: string };

  await invoke(h.route, ctx, `/api/personal-coach/goals/${first.id}/primary`, "POST");
  let goals = (await invoke(h.route, ctx, "/api/personal-coach/goals?status=active", "GET")).value as { goals: Array<{ id: string; priority: number }> };
  assert.equal(goals.goals[0]?.id, first.id);

  await invoke(h.route, ctx, `/api/personal-coach/goals/${second.id}/primary`, "POST");
  goals = (await invoke(h.route, ctx, "/api/personal-coach/goals?status=active", "GET")).value as { goals: Array<{ id: string; priority: number }> };
  assert.equal(goals.goals[0]?.id, second.id, "the new primary leads the list");
  assert.equal(goals.goals.filter((goal) => goal.priority === 3).length, 1, "exactly one goal is primary");

  await invoke(h.route, ctx, "/api/personal-coach/goals/primary", "DELETE");
  goals = (await invoke(h.route, ctx, "/api/personal-coach/goals?status=active", "GET")).value as { goals: Array<{ id: string; priority: number }> };
  assert.equal(goals.goals.some((goal) => goal.priority === 3), false);
  h.close();
});

test("a due routine can be completed, skipped and reopened for one local day", async () => {
  const h = harness();
  const ctx = space("routines");
  const routine = (await invoke(h.route, ctx, "/api/personal-coach/routines", "POST", {
    title: "Morning workout",
    cadence: { kind: "daily" },
    preferredMinuteOfDay: 360,
  })).value as { id: string };

  const dueStatus = async (): Promise<string | undefined> => {
    const home = (await invoke(h.route, ctx, "/api/personal-coach/home", "GET")).value as {
      today: { routines: Array<{ routine: { id: string }; status?: string }> };
    };
    return home.today.routines.find((due) => due.routine.id === routine.id)?.status;
  };
  assert.equal(await dueStatus(), undefined);

  await invoke(h.route, ctx, `/api/personal-coach/routines/${routine.id}/done`, "POST");
  assert.equal(await dueStatus(), "done");

  await invoke(h.route, ctx, `/api/personal-coach/routines/${routine.id}/skip`, "POST", { reason: "Travelling" });
  assert.equal(await dueStatus(), "skipped");

  const history = (await invoke(h.route, ctx, "/api/personal-coach/routine-occurrences", "GET")).value as {
    occurrences: Array<{ status: string; reason?: string }>;
  };
  assert.equal(history.occurrences.length, 1, "one row per routine-day, never an append-only pile");
  assert.equal(history.occurrences[0]?.reason, "Travelling");

  await invoke(h.route, ctx, `/api/personal-coach/routines/${routine.id}/reopen`, "POST");
  assert.equal(await dueStatus(), undefined);
  h.close();
});

test("routine occurrences are Space-scoped and reject a malformed day", async () => {
  const h = harness();
  const mine = space("tenant-a");
  const foreign = space("tenant-b");
  const routine = (await invoke(h.route, mine, "/api/personal-coach/routines", "POST", {
    title: "Evening review",
    cadence: { kind: "daily" },
  })).value as { id: string };

  // A known-valid id from another Space must not resolve here, and the failure
  // must not confirm that it exists somewhere else.
  await assert.rejects(
    invoke(h.route, foreign, `/api/personal-coach/routines/${routine.id}/done`, "POST"),
    (error: { code?: string }) => error.code === "not-found",
  );
  await assert.rejects(
    invoke(h.route, mine, `/api/personal-coach/routines/${routine.id}/done`, "POST", { date: "yesterday" }),
    (error: { code?: string }) => error.code === "invalid-input",
  );
  h.close();
});
