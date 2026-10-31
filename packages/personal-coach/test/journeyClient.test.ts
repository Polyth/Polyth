import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoachClient } from "../widgets/client.ts";
import type { CoachHomeDto } from "../widgets/api.ts";
import type { CoachJourneyApi, CoachSessionReply } from "../widgets/journeyApi.ts";

const home = (): CoachHomeDto => ({
  revision: 1, date: "2026-09-10",
  profile: { tone: "balanced", initiative: "balanced", timeZone: "Europe/Kyiv", challengeAssumptions: false, onboardingState: "new", updatedAt: 1 },
  today: { actions: [], total: 0, routines: [] },
  attention: { overdue: [], overdueTotal: 0, overloaded: false },
  upcoming: { items: [], total: 0 },
  activeGoals: [], activeGoalTotal: 0, suggestionCount: 0, reviewDue: false,
});
const friendlyError = (action: string, cause: unknown) => `${action}: ${cause instanceof Error ? cause.message : String(cause)}`;
function api(overrides: Partial<CoachJourneyApi> = {}): CoachJourneyApi {
  return {
    home: async () => home(), createSession: async () => ({ sessionId: "session" }),
    ...overrides,
  } as CoachJourneyApi;
}

test("objective and browser time zone reach the canonical launcher, then navigation occurs once", async () => {
  let sent: unknown, opened = "";
  const client = createCoachClient({ api: api({ createSession: async (title, options) => { sent = { title, options }; return { sessionId: "coach" }; } }), openSession: async (id) => { opened = id; }, friendlyError });
  assert.equal(await client.start("Ship Polyth", "Europe/Kyiv"), true);
  assert.deepEqual(sent, { title: undefined, options: { resume: true, text: "Ship Polyth", timeZone: "Europe/Kyiv" } });
  assert.equal(opened, "coach");
  assert.equal(client.getSnapshot().busy.size, 0);
});

test("duplicate starts share the busy boundary instead of creating extra sessions", async () => {
  let release!: (value: CoachSessionReply) => void, calls = 0;
  const pending = new Promise<CoachSessionReply>((resolve) => { release = resolve; });
  const client = createCoachClient({ api: api({ createSession: async () => { calls++; return pending; } }), openSession: async () => {}, friendlyError });
  const first = client.start("Goal", "UTC");
  assert.equal(await client.start("Goal", "UTC"), false);
  release({ sessionId: "coach" }); await first;
  assert.equal(calls, 1);
});

test("uncertain first admission stays visible in Coach without hiding its recovery error", async () => {
  let opens = 0;
  const client = createCoachClient({ api: api({ createSession: async () => ({ sessionId: "coach", startError: "Check before resending" }) }), openSession: async () => { opens++; }, friendlyError });
  assert.equal(await client.start("Goal", "UTC"), false);
  assert.equal(opens, 0);
  assert.equal(client.getSnapshot().sessionId, "coach");
  assert.match(client.getSnapshot().error ?? "", /Check before resending/);
  assert.equal(client.getSnapshot().busy.size, 0);
});

test("provider/open errors release controls and never discard the last loaded Home", async () => {
  const client = createCoachClient({ api: api({ createSession: async () => { throw new Error("offline"); } }), openSession: async () => {}, friendlyError });
  await client.ensureLoaded();
  assert.equal(await client.start("Keep this draft", "UTC"), false);
  assert.equal(client.getSnapshot().home?.date, "2026-09-10");
  assert.match(client.getSnapshot().error ?? "", /offline/);
  assert.equal(client.getSnapshot().busy.size, 0);
});

test("a slow start cannot steal a newer navigation", async () => {
  let page = "coach", opens = 0, release!: (value: CoachSessionReply) => void;
  const pending = new Promise<CoachSessionReply>((resolve) => { release = resolve; });
  const client = createCoachClient({ api: api({ createSession: async () => pending }), openSession: async () => { opens++; }, friendlyError, navigationToken: () => page });
  const first = client.start("Goal", "UTC"); page = "other-session";
  release({ sessionId: "coach" }); await first;
  assert.equal(opens, 0);
});

test("disabled/disposed packages cannot navigate or republish late results", async () => {
  let opens = 0, release!: (value: CoachSessionReply) => void;
  const pending = new Promise<CoachSessionReply>((resolve) => { release = resolve; });
  const client = createCoachClient({ api: api({ createSession: async () => pending }), openSession: async () => { opens++; }, friendlyError });
  const first = client.start("Goal", "UTC"); client.dispose();
  release({ sessionId: "coach" }); assert.equal(await first, false);
  assert.equal(opens, 0);
});

test("an older Home request cannot satisfy a post-mutation refresh", async () => {
  let calls = 0, release!: (value: CoachHomeDto) => void;
  const stale = new Promise<CoachHomeDto>((resolve) => { release = resolve; });
  const client = createCoachClient({ api: api({
    home: async () => { calls++; return calls === 1 ? stale : { ...home(), revision: 2 }; },
    rescheduleCommitment: async () => ({ id: "c", title: "Step", status: "open" }),
  }), openSession: async () => {}, friendlyError });
  const initial = client.refresh();
  const move = client.reschedule("c", Date.now() + 3600000);
  release(home()); await initial; assert.equal(await move, true);
  assert.equal(calls, 2);
  assert.equal(client.getSnapshot().home?.revision, 2);
});
