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
  activeGoals: [{ id: "g1", title: "Ship Coach", status: "active", priority: 3 }],
  today: {
    mainFocus: { id: "c1", title: "Finish UI", status: "open" },
    commitments: [
      { id: "c1", title: "Finish UI", status: "open" },
      { id: "c2", title: "Review", status: "open" },
    ],
    overflowCount: 0,
    overdueCount: 0,
    dueRoutines: [],
  },
  nextAction: { id: "c1", title: "Finish UI", status: "open" },
  reviewDue: false,
});

function fakeApi(overrides: Partial<CoachApi> = {}): CoachApi {
  return {
    home: async () => home(),
    settings: async () => ({ revision: 1, profile: home().profile }),
    updateSettings: async (patch) => ({ ...home().profile, ...patch }),
    completeCommitment: async (id) => ({ id, title: "Done", status: "done" }),
    skipCommitment: async (id) => ({ id, title: "Skipped", status: "skipped" }),
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
    plans: async () => [],
    plan: async (id) => ({ id, title: "Plan", currentRevision: 1, createdAt: 1, updatedAt: 1, revisions: [] }),
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

test("complete is optimistic and reconciles with one explicit refresh", async () => {
  let homeCalls = 0;
  const c = client(fakeApi({ home: async () => { homeCalls++; return home(); } }));
  await c.ensureLoaded();
  const complete = c.complete("c1");
  assert.deepEqual(c.getSnapshot().home?.today.commitments.map((item) => item.id), ["c2"]);
  await complete;
  assert.equal(homeCalls, 2);
  assert.equal(c.getSnapshot().error, undefined);
});

test("failed optimistic mutation rolls back the previous projection", async () => {
  const c = client(fakeApi({
    completeCommitment: async () => { throw new Error("offline"); },
  }));
  await c.ensureLoaded();
  await c.complete("c1");
  assert.deepEqual(c.getSnapshot().home?.today.commitments.map((item) => item.id), ["c1", "c2"]);
  assert.match(c.getSnapshot().error ?? "", /offline/);
  assert.equal(c.getSnapshot().busy.has("commitment:c1"), false);
});

test("check-in updates the shared projection without a Home round trip", async () => {
  let homeCalls = 0;
  const c = client(fakeApi({ home: async () => { homeCalls++; return home(); } }));
  await c.ensureLoaded();
  await c.checkIn(4, 5);
  assert.equal(c.getSnapshot().home?.lastCheckIn?.energy, 4);
  assert.equal(c.getSnapshot().home?.lastCheckIn?.focus, 5);
  assert.equal(homeCalls, 1);
});

test("Talk creates one Coach session then hands it to canonical session navigation", async () => {
  const opened: string[] = [];
  let title: string | undefined;
  const c = client(fakeApi({ createSession: async (value) => { title = value; return { sessionId: "coach-session" }; } }), opened);
  await c.talk("Coach · Weekly review");
  assert.equal(title, "Coach · Weekly review");
  assert.deepEqual(opened, ["coach-session"]);
  assert.equal(c.getSnapshot().busy.has("talk"), false);
});
