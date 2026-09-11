import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { buildCoachHome } from "../src/home.ts";
import { personalCoachInsightRoutes } from "../src/insightRoutes.ts";
import { registerCoachInsightCapabilities } from "../src/insights.ts";
import { createCoachStore } from "../src/index.ts";

const projectId = "__polyth_pkg_insights0123456789";
const toolContext = {
  sessionId: "coach-session",
  spaceId: "space-a",
  projectId,
  cwd: "/tmp/coach",
};
const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/space-a",
};

const fresh = (now: () => number = Date.now) =>
  createCoachStore(join(mkdtempSync(join(tmpdir(), "polyth-coach-insights-")), "coach.db"), { now });

async function invoke(route: RouteHandler, target: string, method: string) {
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
    space,
    requireCapability: () => {},
    body: async () => ({}),
    json: (_status, body) => { value = body; },
  });
  assert.equal(handled, true);
  return value;
}

test("weekly review becomes due after seven local days and a weekly reflection resets it", () => {
  let clock = Date.parse("2026-09-01T12:00:00Z");
  const store = fresh(() => clock);
  store.updateProfile({ timeZone: "Europe/Kyiv", onboardingState: "complete" });
  assert.equal(buildCoachHome(store, { now: clock }).reviewDue, false);

  clock = Date.parse("2026-09-08T12:00:00Z");
  assert.equal(buildCoachHome(store, { now: clock }).reviewDue, true);
  store.recordReflection({ kind: "weekly", text: "We kept the plan small and shipped the important item." });
  assert.equal(buildCoachHome(store, { now: clock }).reviewDue, false);
  store.close();
});

test("editing coaching preferences never postpones the first weekly review", () => {
  let clock = Date.parse("2026-09-01T12:00:00Z");
  const store = fresh(() => clock);
  store.updateProfile({ timeZone: "Europe/Kyiv", onboardingState: "complete" });
  const completedAt = store.profile().onboardingCompletedAt;
  assert.equal(completedAt, clock, "the completion instant is stamped on the transition");

  // Six days later the user changes tone, initiative, timezone and the
  // challenge preference. Under the old `profile.updatedAt` anchor each of
  // these pushed the first review a further week away.
  clock = Date.parse("2026-09-07T12:00:00Z");
  store.updateProfile({ tone: "direct" });
  store.updateProfile({ initiative: "proactive" });
  store.updateProfile({ challengeAssumptions: true });
  store.updateProfile({ timeZone: "Europe/Warsaw" });
  assert.equal(store.profile().onboardingCompletedAt, completedAt, "the anchor is stamped once");

  clock = Date.parse("2026-09-08T12:00:00Z");
  assert.equal(buildCoachHome(store, { now: clock }).reviewDue, true);
  store.close();
});

test("insight tool requires recent durable evidence and weekly review tool persists the review", async () => {
  const store = fresh();
  const reflection = store.recordReflection({ text: "Morning focus worked twice this week." });
  const event = store.listEvents({ entityType: "reflection", entityId: reflection.id })[0]!;
  const emitted: string[] = [];
  const registry = createCapabilityContributionRegistry();
  const set = registerCoachInsightCapabilities({
    registry,
    space: { spaceId: "space-a" },
    projectId,
    store,
    onInsightCreated: (insight) => { emitted.push(insight.id); },
  });
  const resolved = registry.resolve(toolContext);
  const insightTool = resolved.find((item) => item.kind === "tool" && item.name === "coach_propose_insight")!;
  const reviewTool = resolved.find((item) => item.kind === "tool" && item.name === "coach_record_weekly_review")!;

  await assert.rejects(
    () => registry.executor(insightTool.id)!({
      statement: "Fabricated pattern",
      confidence: "high",
      evidence: [999_999],
    }, toolContext),
    (cause: Error & { code?: string }) => cause.code === "invalid-input",
  );
  assert.equal(store.listInsights().length, 0);

  const result = await registry.executor(insightTool.id)!({
    statement: "Morning focus may be easier to sustain.",
    confidence: "low",
    evidence: [event.seq],
  }, toolContext);
  const insight = JSON.parse(result.output) as { id: string; status: string };
  assert.equal(insight.status, "candidate");
  assert.deepEqual(emitted, [insight.id]);

  await registry.executor(reviewTool.id)!({ summary: "Morning sessions worked; keep the next week small." }, toolContext);
  assert.equal(store.listReflections(1)[0]?.kind, "weekly");
  await set.dispose();
  store.close();
});

test("insight review is user-correctable and terminal transitions do not flip", async () => {
  const store = fresh();
  const reflection = store.recordReflection({ text: "A concrete observation." });
  const evidence = store.listEvents({ entityType: "reflection", entityId: reflection.id })[0]!;
  const insight = store.createInsight({
    statement: "This might be a pattern.",
    confidence: "medium",
    evidence: [{ eventSeq: evidence.seq }],
  });
  const route = personalCoachInsightRoutes({ forSpace: () => store });

  const accepted = await invoke(route, `/api/personal-coach/insights/${insight.id}/accept`, "POST") as { status: string };
  assert.equal(accepted.status, "accepted");
  await assert.rejects(
    () => invoke(route, `/api/personal-coach/insights/${insight.id}/reject`, "POST"),
    (cause: Error & { code?: string }) => cause.code === "conflict",
  );
  const forgotten = await invoke(route, `/api/personal-coach/insights/${insight.id}/forget`, "POST") as { status: string };
  assert.equal(forgotten.status, "expired", "forget remains available after earlier acceptance");
  store.close();
});
