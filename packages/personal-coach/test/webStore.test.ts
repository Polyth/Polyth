import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoachApi, CoachHomeDto } from "../widgets/api.ts";
import { createCoachClient } from "../widgets/store.ts";

const home = (): CoachHomeDto => ({
  revision: 1,
  date: "2026-09-10",
  profile: {
    tone: "balanced",
    initiative: "balanced",
    timeZone: "Europe/Kyiv",
    challengeAssumptions: false,
    onboardingState: "complete",
    updatedAt: 1,
  },
  today: {
    focus: { id: "c1", title: "Finish UI", status: "open" },
    actions: [
      { id: "c1", title: "Finish UI", status: "open" },
      { id: "c2", title: "Review", status: "open" },
    ],
    total: 2,
    routines: [],
  },
  attention: {
    overdue: [{ id: "o1", title: "From Monday", status: "open" }],
    overdueTotal: 1,
    overloaded: false,
  },
  upcoming: {
    next: { id: "u1", title: "Next week", status: "open" },
    items: [{ id: "u2", title: "Unscheduled", status: "open" }],
    total: 2,
  },
  activeGoals: [{ id: "g1", title: "Ship Coach", status: "active", priority: 3 }],
  activeGoalTotal: 1,
  suggestionCount: 0,
  reviewDue: false,
});

function fakeApi(overrides: Partial<CoachApi> = {}): CoachApi {
  return {
    home: async () => home(),
    settings: async () => ({ revision: 1, profile: home().profile }),
    updateSettings: async (patch) => ({ ...home().profile, ...patch }),
    resetState: async () => ({
      revision: 2,
      resetAt: 2,
      profile: { ...home().profile, onboardingState: "new", updatedAt: 2 },
    }),
    reminders: async () => ({
      available: true,
      settings: {
        dailyCheckIn: { enabled: false, minuteOfDay: 480 },
        weeklyReview: { enabled: false, day: 0, minuteOfDay: 1080 },
        timeZone: "Europe/Kyiv",
      },
    }),
    updateReminders: async (patch) => ({
      available: true,
      settings: {
        dailyCheckIn: { enabled: patch.dailyCheckIn, minuteOfDay: patch.dailyMinuteOfDay },
        weeklyReview: { enabled: patch.weeklyReview, day: patch.weeklyDay, minuteOfDay: patch.weeklyMinuteOfDay },
        timeZone: "Europe/Kyiv",
      },
    }),
    completeCommitment: async (id) => ({ id, title: "Done", status: "done" }),
    skipCommitment: async (id, reason) => ({ id, title: "Skipped", status: "skipped", ...(reason ? { lastReason: reason } : {}) }),
    recordCheckIn: async ({ energy, focus }) => ({ id: "check", energy, focus, createdAt: 1 }),
    createSession: async () => ({ sessionId: "coach-session" }),
    insight: async (id) => ({
      id,
      statement: "Possible pattern",
      confidence: "low",
      evidence: [{ eventSeq: 1 }],
      status: "candidate",
      createdAt: 1,
      updatedAt: 1,
    }),
    setInsightStatus: async (id, action) => ({
      id,
      statement: "Possible pattern",
      confidence: "low",
      evidence: [{ eventSeq: 1 }],
      status: action === "accept" ? "accepted" : action === "reject" ? "rejected" : "expired",
      createdAt: 1,
      updatedAt: 2,
    }),
    proposal: async (id) => ({
      id,
      type: "goal",
      payload: { title: "Proposal" },
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    }),
    acceptProposal: async (id) => ({
      proposal: { id, type: "goal", payload: { title: "Proposal" }, status: "accepted", createdAt: 1, updatedAt: 2 },
      application: { type: "goal", id: "g2", appliedAt: 2 },
    }),
    rejectProposal: async (id) => ({
      proposal: { id, type: "goal", payload: { title: "Proposal" }, status: "rejected", createdAt: 1, updatedAt: 2 },
    }),
    resolveRoutineDay: async () => ({}),
    ...overrides,
  };
}

const client = (api: CoachApi, opened: string[] = []) => createCoachClient({
  api,
  openSession: async (id) => { opened.push(id); },
  friendlyError: (action, cause) => `${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
});

test("multiple initial consumers share one Home request", async () => {
  let calls = 0;
  let release!: (value: CoachHomeDto) => void;
  const pending = new Promise<CoachHomeDto>((resolve) => { release = resolve; });
  const c = client(fakeApi({ home: async () => { calls++; return pending; } }));

  const a = c.ensureLoaded();
  const b = c.ensureLoaded();
  const d = c.ensureLoaded();
  assert.equal(calls, 1);
  release(home());
  await Promise.all([a, b, d]);
  assert.equal(c.getSnapshot().status, "ready");
  assert.equal(calls, 1);

  await c.ensureLoaded();
  assert.equal(calls, 1, "mounted child widgets must not refetch an already loaded projection");
});

test("completing today's focus promotes the next action, never a future one", async () => {
  let homeCalls = 0;
  const c = client(fakeApi({ home: async () => { homeCalls++; return home(); } }));
  await c.ensureLoaded();
  const complete = c.complete("c1");
  const optimistic = c.getSnapshot().home;
  assert.deepEqual(optimistic?.today.actions.map((item) => item.id), ["c2"]);
  assert.equal(optimistic?.today.focus?.id, "c2");
  assert.equal(optimistic?.today.total, 1);
  await complete;
  assert.equal(homeCalls, 2);
  assert.equal(c.getSnapshot().error, undefined);
});

test("emptying today leaves an honest empty state rather than borrowing Next up", async () => {
  const c = client(fakeApi());
  await c.ensureLoaded();
  const single = {
    ...home(),
    today: { focus: { id: "c1", title: "Finish UI", status: "open" as const }, actions: [{ id: "c1", title: "Finish UI", status: "open" as const }], total: 1, routines: [] },
  };
  const withOne = client(fakeApi({ home: async () => single }));
  await withOne.ensureLoaded();
  const complete = withOne.complete("c1");
  const optimistic = withOne.getSnapshot().home;
  assert.deepEqual(optimistic?.today.actions, []);
  assert.equal(optimistic?.today.focus, undefined);
  assert.equal(optimistic?.upcoming.next?.id, "u1", "the future item stays exactly where it was");
  await complete;
});

test("skip reason is transported without adding an LLM round trip", async () => {
  let capturedReason: string | undefined;
  const c = client(fakeApi({
    skipCommitment: async (id, reason) => {
      capturedReason = reason;
      return { id, title: "Skipped", status: "skipped", ...(reason ? { lastReason: reason } : {}) };
    },
  }));
  await c.ensureLoaded();
  await c.skip("c1", "Blocked");
  assert.equal(capturedReason, "Blocked");
});

test("a failed mutation rolls back a Today row to its exact position", async () => {
  const c = client(fakeApi({
    completeCommitment: async () => { throw new Error("offline"); },
  }));
  await c.ensureLoaded();
  await c.complete("c1");
  const after = c.getSnapshot().home;
  assert.deepEqual(after?.today.actions.map((item) => item.id), ["c1", "c2"]);
  assert.equal(after?.today.focus?.id, "c1");
  assert.equal(after?.today.total, 2);
  assert.match(c.getSnapshot().error ?? "", /offline/);
  assert.equal(c.getSnapshot().busy.has("commitment:c1"), false);
});

test("a failed mutation on an overdue row rolls that row back too", async () => {
  // The regression this covers: only `today.commitments` used to be restorable,
  // so a failed Done on an overdue or upcoming row vanished from the UI.
  const c = client(fakeApi({
    completeCommitment: async () => { throw new Error("offline"); },
  }));
  await c.ensureLoaded();
  await c.complete("o1");
  const after = c.getSnapshot().home;
  assert.deepEqual(after?.attention.overdue.map((item) => item.id), ["o1"]);
  assert.equal(after?.attention.overdueTotal, 1);
  assert.deepEqual(after?.today.actions.map((item) => item.id), ["c1", "c2"], "other buckets are untouched");
  assert.match(c.getSnapshot().error ?? "", /offline/);
});

test("a failed mutation on an upcoming row restores Next up", async () => {
  const c = client(fakeApi({
    skipCommitment: async () => { throw new Error("offline"); },
  }));
  await c.ensureLoaded();
  const pendingSkip = c.skip("u1");
  const optimistic = c.getSnapshot().home;
  assert.equal(optimistic?.upcoming.next?.id, "u2", "the next future item takes the slot");
  await pendingSkip;
  const after = c.getSnapshot().home;
  assert.equal(after?.upcoming.next?.id, "u1");
  assert.deepEqual(after?.upcoming.items.map((item) => item.id), ["u2"]);
  assert.equal(after?.upcoming.total, 2);
});

test("check-in updates the shared projection without a Home round trip", async () => {
  let homeCalls = 0;
  const c = client(fakeApi({ home: async () => { homeCalls++; return home(); } }));
  await c.ensureLoaded();
  await c.checkIn(4, 5);
  assert.equal(c.getSnapshot().home?.checkIn?.energy, 4);
  assert.equal(c.getSnapshot().home?.checkIn?.focus, 5);
  assert.equal(homeCalls, 1);
});

test("Ask Coach always resumes the one Coach conversation", async () => {
  const opened: string[] = [];
  const calls: Array<{ title?: string; options?: unknown }> = [];
  const c = client(fakeApi({
    createSession: async (title, options) => { calls.push({ title, options }); return { sessionId: "coach-session" }; },
  }), opened);
  await c.talk();
  await c.talk("Help me with goal g1.");
  // No per-topic title, so no second session competes to become "latest".
  assert.deepEqual(calls.map((call) => call.title), [undefined, undefined]);
  assert.deepEqual(calls.map((call) => call.options), [
    { resume: true },
    { resume: true, text: "Help me with goal g1." },
  ]);
  assert.deepEqual(opened, ["coach-session", "coach-session"]);
  assert.equal(c.getSnapshot().busy.has("talk"), false);
});

test("a routine day resolves through the shared client and reconciles once", async () => {
  let homeCalls = 0;
  const resolved: unknown[] = [];
  const c = client(fakeApi({
    home: async () => { homeCalls++; return home(); },
    resolveRoutineDay: async (id, action, reason) => { resolved.push({ id, action, reason }); return {}; },
  }));
  await c.ensureLoaded();
  assert.equal(await c.resolveRoutine("r1", "skip", "Travelling"), true);
  assert.deepEqual(resolved, [{ id: "r1", action: "skip", reason: "Travelling" }]);
  assert.equal(homeCalls, 2);
  assert.equal(c.getSnapshot().busy.has("routine:r1"), false);
});
