import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoachStore } from "../src/index.ts";
import type { SessionProjection, SpaceContext } from "@polyth/contracts";
import {
  COACH_SESSION_TITLE,
  createCoachSessionFlow,
  parseCoachSessionInput,
  resolveCanonicalCoachSession,
} from "../src/sessionFlow.ts";

const space = { spaceId: "a" } as SpaceContext;
const projection = (id: string, projectId = "anchor", spaceId = "a", createdAt = 1): SessionProjection => ({
  id, projectId, spaceId, createdAt, updatedAt: createdAt, status: "idle", title: "Coach",
});
function harness(options: { failSend?: boolean; failCreate?: boolean; state?: "new" | "started" | "complete" } = {}) {
  let state = options.state ?? "new";
  // The durable canonical pointer, modelled exactly as the real store keeps it:
  // a reset clears it, so a fresh conversation cannot resume a stale chat.
  let canonical: string | undefined;
  const rows: SessionProjection[] = [];
  const calls: string[] = [];
  const texts: string[] = [];
  const store = {
    profile: () => ({ onboardingState: state, timeZone: "UTC" }),
    updateProfile: (patch: { onboardingState: typeof state }) => { state = patch.onboardingState; calls.push(`profile:${state}`); },
    canonicalSessionId: () => canonical,
    setCanonicalSessionId: (id: string | null) => { canonical = id ?? undefined; },
  } as unknown as CoachStore;
  const flow = createCoachSessionFlow({
    workspace: async () => { calls.push("workspace"); return { projectId: "anchor" }; },
    store: () => store,
    prepare: async () => { calls.push("prepare"); },
    context: async (id) => { calls.push(`context:${id}`); },
    sessions: () => ({
      list: async () => rows,
      create: async (input) => {
        calls.push("create");
        if (options.failCreate) throw new Error("provider unavailable");
        const id = `s${rows.length + 1}`;
        rows.push({ ...projection(id), ...(input.title ? { title: input.title } : {}) });
        return { id };
      },
      send: async (id, input) => {
        calls.push(`send:${id}`); texts.push(input.text);
        if (options.failSend) throw new Error("uncertain admission");
        return { turnId: "turn" };
      },
    }),
  });
  return {
    flow, rows, calls, texts,
    state: () => state,
    canonical: () => canonical,
    reset: () => { state = "new"; canonical = undefined; },
  };
}

test("input is validated before workspace/runtime creation", async () => {
  const h = harness();
  for (const input of [{ title: "x".repeat(121) }, { text: 42 }, { text: "   " }, { text: "x".repeat(4001) }, { resume: "yes" }, { timeZone: "Mars/Olympus" }]) {
    await assert.rejects(h.flow(space, input), (error: { code?: string }) => error.code === "invalid-input");
  }
  assert.deepEqual(h.calls, []);
  assert.deepEqual(parseCoachSessionInput({ text: "  Ship a beta  ", resume: true }), { text: "Ship a beta", resume: true });
});

test("legacy session creation keeps the existing response and does not send a hidden first turn", async () => {
  const h = harness();
  assert.deepEqual(await h.flow(space, {}), { sessionId: "s1" });
  assert.equal(h.rows[0]?.title, COACH_SESSION_TITLE);
  assert.equal(h.state(), "new");
  assert.deepEqual(h.texts, []);
});

test("fresh objective prepares capabilities, persists started state/context, then admits the exact first message", async () => {
  const h = harness();
  assert.deepEqual(await h.flow(space, { text: "Ship a beta", resume: true, timeZone: "Europe/Kyiv" }), { sessionId: "s1" });
  assert.deepEqual(h.calls, ["workspace", "prepare", "create", "profile:started", "context:s1", "send:s1"]);
  assert.deepEqual(h.texts, ["Ship a beta"]);
  assert.equal(h.state(), "started");
  // One durable Coach identity from the first turn on: no "Coach · Setup" name
  // left behind to become stale the moment onboarding finishes.
  assert.equal(h.rows[0]?.title, COACH_SESSION_TITLE);
  assert.equal(h.canonical(), "s1");
});

test("double clicks/tabs resume one canonical session and never replay the objective", async () => {
  const h = harness();
  const results = await Promise.all([
    h.flow(space, { resume: true, text: "Ship a beta" }),
    h.flow(space, { resume: true, text: "Ship a beta" }),
  ]);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(results.map((value) => value.sessionId), ["s1", "s1"]);
  assert.deepEqual(h.texts, ["Ship a beta"]);
  assert.equal(results[1]?.resumed, true);
});

test("uncertain first admission returns a recoverable session, not a replay or replacement", async () => {
  const h = harness({ failSend: true });
  const failed = await h.flow(space, { resume: true, text: "My objective" });
  assert.match(failed.startError ?? "", /not confirmed/);
  assert.equal(failed.sessionId, "s1");
  const resumed = await h.flow(space, { resume: true, text: "My objective" });
  assert.equal(resumed.sessionId, "s1");
  assert.equal(h.rows.length, 1);
  assert.equal(h.texts.length, 1);
});

test("runtime creation failure leaves setup new and releases the launch lock", async () => {
  const options = { failCreate: true };
  const h = harness(options);
  await assert.rejects(h.flow(space, { resume: true, text: "Goal" }), /unavailable/);
  assert.equal(h.state(), "new");
  options.failCreate = false;
  assert.equal((await h.flow(space, { resume: true, text: "Goal" })).sessionId, "s1");
});

test("new sessions after reset do not resurrect earlier setup chats", async () => {
  const h = harness();
  await h.flow(space, { resume: true, text: "Old goal" });
  h.reset();
  const next = await h.flow(space, { resume: true, text: "New direction" });
  assert.equal(next.sessionId, "s2");
  assert.deepEqual(h.texts, ["Old goal", "New direction"]);
});

test("an explicit new review starts a real turn after setup is complete", async () => {
  const h = harness({ state: "complete" });
  await h.flow(space, { resume: false, title: "Coach · Weekly review", text: "Review my week" });
  assert.equal(h.state(), "complete");
  assert.deepEqual(h.texts, ["Review my week"]);
  // A special-purpose session never becomes the generic "Ask Coach" target.
  assert.equal(h.canonical(), undefined);
});

test("a contextual ask continues the one Coach conversation instead of adding a session", async () => {
  const h = harness({ state: "complete" });
  const first = await h.flow(space, { resume: true });
  const second = await h.flow(space, { resume: true, text: "Help me with goal g1." });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.resumed, true);
  assert.equal(h.rows.length, 1, "no second Coach session is created for a contextual ask");
  assert.deepEqual(h.texts.at(-1), "Help me with goal g1.");
});

test("a scheduled check-in does not hijack the Ask Coach resume target", async () => {
  const h = harness({ state: "complete" });
  const canonical = await h.flow(space, { resume: true });
  await h.flow(space, { title: "Coach · Daily check-in", text: "Daily" });
  assert.equal(h.rows.length, 2);
  assert.equal((await h.flow(space, { resume: true })).sessionId, canonical.sessionId);
});

test("resume filters known-valid foreign Spaces, unrelated projects, and archived sessions", () => {
  const candidates = [
    projection("mine", "anchor", "a", 1),
    projection("foreign", "anchor", "b", 9),
    projection("unrelated", "other", "a", 10),
    { ...projection("archived", "anchor", "a", 11), status: "archived" as const },
  ];
  const scope = { projectId: "anchor", spaceId: "a", adopt: true };
  assert.equal(resolveCanonicalCoachSession(candidates, scope)?.id, "mine");
  assert.equal(resolveCanonicalCoachSession(candidates, { ...scope, spaceId: "missing" }), undefined);
  // A live recorded pointer outranks recency; a dangling one resolves to
  // nothing rather than silently adopting an unrelated chat.
  assert.equal(
    resolveCanonicalCoachSession(candidates, { ...scope, recordedId: "mine", adopt: false })?.id,
    "mine",
  );
  assert.equal(
    resolveCanonicalCoachSession(candidates, { ...scope, recordedId: "archived", adopt: false }),
    undefined,
  );
});

test("an upgrade adopts the existing Coach chat once, but never a scheduled run", () => {
  const scope = { projectId: "anchor", spaceId: "a", adopt: true };
  const scheduled = { ...projection("cron", "anchor", "a", 50), title: "Coach · Daily check-in" };
  const ongoing = { ...projection("chat", "anchor", "a", 10), title: "Coach · Today" };
  assert.equal(resolveCanonicalCoachSession([scheduled, ongoing], scope)?.id, "chat");
  assert.equal(resolveCanonicalCoachSession([scheduled], scope), undefined);
});
