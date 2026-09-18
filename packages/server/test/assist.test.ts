// Explicit small-model assist routes and helpers that remain core-owned.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection, SpaceContext } from "@polyth/contracts";
import {
  buildNextActionPrompt,
  buildNotePrompt,
  buildPromptImprovementPrompt,
  createManualSuggestionService,
  parseNoteReply,
  sanitizeNextActionReply,
} from "../src/assist.ts";
import { assistRoutes } from "../src/routes/assist.ts";
import type { RouteRequest } from "../src/http.ts";

const completedExchangeEvents = () => [
  { id: "e1", sessionId: "s1", seq: 1, time: 1, type: "user/message", data: { text: "older prompt" }, v: 1 },
  { id: "e2", sessionId: "s1", seq: 2, time: 2, type: "assistant/message", data: { text: "older answer" }, v: 1 },
  { id: "e3", sessionId: "s1", seq: 3, time: 3, type: "user/message", data: { text: "latest prompt" }, v: 1 },
  { id: "e4", sessionId: "s1", seq: 4, time: 4, type: "turn/started", data: { turnId: "t1" }, v: 1, ignorable: true },
  { id: "e5", sessionId: "s1", seq: 5, time: 5, type: "tool/result", data: { callId: "c", tool: "read", output: "tool-only" }, v: 1 },
  { id: "e6", sessionId: "s1", seq: 6, time: 6, type: "assistant/message", data: { text: "latest answer" }, v: 1 },
  { id: "e7", sessionId: "s1", seq: 7, time: 7, type: "turn/stopped", data: { turnId: "t1", reason: "completed" }, v: 1, ignorable: true },
] as unknown as import("@polyth/contracts").SessionEvent[];

test("manual next-action service sends the recent completed exchanges without tool noise", async () => {
  const prompts: string[] = [];
  const svc = createManualSuggestionService({
    latestSeq: async () => 7,
    events: async () => completedExchangeEvents(),
    complete: async (_id, prompt) => { prompts.push(prompt); return "Suggestion: Implement the missing await."; },
  });
  assert.deepEqual(await svc.generate("s1"), { suggestion: "Implement the missing await.", atSeq: 7 });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /latest prompt/);
  assert.match(prompts[0]!, /latest answer/);
  // The preceding exchange is what a short closing message refers to, so it
  // belongs in the context. Raw tool output still never does.
  assert.match(prompts[0]!, /older prompt/);
  assert.match(prompts[0]!, /older answer/);
  assert.doesNotMatch(prompts[0]!, /tool-only/);
});

// The failure this guards against: the user says "looks good", the assistant
// says "glad it worked", and a suggestion built from that pair alone has no
// idea what the session was actually doing.
test("a trivial closing exchange does not bury the work the suggestion needs", async () => {
  const events = [
    { id: "e1", sessionId: "s1", seq: 1, time: 1, type: "user/message", data: { text: "Add retry to the upload path" }, v: 1 },
    { id: "e2", sessionId: "s1", seq: 2, time: 2, type: "assistant/message", data: { text: "Added exponential backoff to uploadChunk." }, v: 1 },
    { id: "e3", sessionId: "s1", seq: 3, time: 3, type: "user/message", data: { text: "looks good" }, v: 1 },
    { id: "e4", sessionId: "s1", seq: 4, time: 4, type: "turn/started", data: { turnId: "t2" }, v: 1, ignorable: true },
    { id: "e5", sessionId: "s1", seq: 5, time: 5, type: "assistant/message", data: { text: "Glad it works." }, v: 1 },
    { id: "e6", sessionId: "s1", seq: 6, time: 6, type: "turn/stopped", data: { turnId: "t2", reason: "completed" }, v: 1, ignorable: true },
  ] as unknown as import("@polyth/contracts").SessionEvent[];
  const prompts: string[] = [];
  const svc = createManualSuggestionService({
    latestSeq: async () => 6,
    events: async () => events,
    complete: async (_id, prompt) => { prompts.push(prompt); return ""; },
  });
  // An honest empty answer is passed through rather than turned into a CTA.
  assert.deepEqual(await svc.generate("s1"), { suggestion: "", atSeq: 6 });
  assert.match(prompts[0]!, /Add retry to the upload path/);
  assert.match(prompts[0]!, /exponential backoff to uploadChunk/);
});

test("manual suggestion improves a draft without paying to load conversation context", async () => {
  let eventReads = 0;
  const svc = createManualSuggestionService({
    latestSeq: async () => 7,
    events: async () => { eventReads += 1; return completedExchangeEvents(); },
    complete: async (_id, prompt) => {
      assert.match(prompt, /USER PROMPT:\nfix teh bug/);
      return "Fix the bug.";
    },
  });
  assert.deepEqual(await svc.generate("s1", "fix teh bug"), { suggestion: "Fix the bug.", atSeq: 7 });
  assert.equal(eventReads, 0);
});

test("manual next-action service rejects no exchange, stale results, and duplicate flights", async () => {
  const noExchange = createManualSuggestionService({
    latestSeq: async () => 0,
    events: async () => [],
    complete: async () => "must not run",
  });
  await assert.rejects(noExchange.generate("s1"), { code: "no-completed-exchange" });

  let seq = 7;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const svc = createManualSuggestionService({
    latestSeq: async () => seq,
    events: async () => completedExchangeEvents(),
    complete: async () => { await blocked; return "Continue with the fix."; },
  });
  const first = svc.generate("s1");
  await Promise.resolve();
  await assert.rejects(svc.generate("s1"), { code: "in-flight" });
  seq = 8;
  release();
  await assert.rejects(first, { code: "stale" });
});

// -------------------------------------------------------------- routes

function routeHarness(opts: {
  projections?: Record<string, SessionProjection>;
  distill?: (space: SpaceContext, sessionId: string) => Promise<{ title: string; body: string }>;
  taskBrief?: (space: SpaceContext, sessionId: string) => Promise<string>;
  suggestion?: (space: SpaceContext, sessionId: string, draft?: string) => Promise<{ suggestion: string; atSeq: number }>;
  improve?: (space: SpaceContext, projectId: string, draft: string) => Promise<string>;
}) {
  const routes = assistRoutes({
    projection: async (id) => opts.projections?.[id],
    ...(opts.distill ? { distill: opts.distill } : {}),
    ...(opts.taskBrief ? { taskBrief: opts.taskBrief } : {}),
    ...(opts.suggestion ? { suggestion: opts.suggestion } : {}),
    ...(opts.improve ? { improve: opts.improve } : {}),
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {}, space: { spaceId: "space-1", userId: "usr_test", membership: { role: "owner" } },
      url: new URL(`http://x${path}`),
      path, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload };
  };
  return { call };
}

const proj = (id: string): SessionProjection => ({
  id, projectId: "p1", title: "t", status: "idle", createdAt: 1, updatedAt: 1,
});

test("POST assist/note: 404 unknown, 503 unwired, draft when wired, 502 on failure", async () => {
  const unknown = routeHarness({ distill: async () => ({ title: "t", body: "b" }) });
  assert.equal((await unknown.call("POST", "/api/sessions/nope/assist/note")).status, 404);

  const unwired = routeHarness({ projections: { s1: proj("s1") } });
  assert.equal((await unwired.call("POST", "/api/sessions/s1/assist/note")).status, 503);

  const wired = routeHarness({
    projections: { s1: proj("s1") },
    distill: async (_space, id) => ({ title: `Note for ${id}`, body: "decisions" }),
  });
  const ok = await wired.call("POST", "/api/sessions/s1/assist/note");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, { title: "Note for s1", body: "decisions" });

  const failing = routeHarness({
    projections: { s1: proj("s1") },
    distill: async () => { throw new Error("model offline"); },
  });
  const soft = await failing.call("POST", "/api/sessions/s1/assist/note");
  assert.equal(soft.status, 502);
  assert.match(String((soft.payload as { message: string }).message), /model offline/);
});

test("POST task-brief is guarded and returns the small-model summary", async () => {
  const unknown = routeHarness({ taskBrief: async () => "brief" });
  assert.equal((await unknown.call("POST", "/api/sessions/nope/task-brief")).status, 404);

  const unwired = routeHarness({ projections: { s1: proj("s1") } });
  assert.equal((await unwired.call("POST", "/api/sessions/s1/task-brief")).status, 503);

  const wired = routeHarness({ projections: { s1: proj("s1") }, taskBrief: async () => "Ship mobile task overview" });
  assert.deepEqual((await wired.call("POST", "/api/sessions/s1/task-brief")).payload, { brief: "Ship mobile task overview" });
});

test("POST assist/suggestion returns an ephemeral result and typed conflicts", async () => {
  const unknown = routeHarness({ suggestion: async () => ({ suggestion: "x", atSeq: 7 }) });
  assert.equal((await unknown.call("POST", "/api/sessions/nope/assist/suggestion")).status, 404);

  const unavailable = routeHarness({ projections: { s1: proj("s1") } });
  assert.equal((await unavailable.call("POST", "/api/sessions/s1/assist/suggestion")).status, 503);

  const ok = routeHarness({
    projections: { s1: proj("s1") },
    suggestion: async () => ({ suggestion: "Validate the change.", atSeq: 7 }),
  });
  assert.deepEqual((await ok.call("POST", "/api/sessions/s1/assist/suggestion")).payload, {
    suggestion: "Validate the change.", atSeq: 7,
  });

  const stale = routeHarness({
    projections: { s1: proj("s1") },
    suggestion: async () => { throw Object.assign(new Error("stale"), { code: "stale" }); },
  });
  const conflict = await stale.call("POST", "/api/sessions/s1/assist/suggestion");
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.payload, { error: "stale", message: "the session changed during suggestion generation" });

  const failure = routeHarness({
    projections: { s1: proj("s1") },
    suggestion: async () => { throw new Error("small model offline"); },
  });
  assert.equal((await failure.call("POST", "/api/sessions/s1/assist/suggestion")).status, 502);
});

test("small-model routes forward the authenticated account identity", async () => {
  const seen: string[] = [];
  const h = routeHarness({
    projections: { s1: proj("s1") },
    suggestion: async (space, sessionId) => {
      seen.push(`${space.userId}:${sessionId}`);
      return { suggestion: "Validate the change.", atSeq: 7 };
    },
    distill: async (space, sessionId) => {
      seen.push(`${space.userId}:${sessionId}`);
      return { title: "Note", body: "Body" };
    },
    taskBrief: async (space, sessionId) => {
      seen.push(`${space.userId}:${sessionId}`);
      return "Brief";
    },
  });
  await h.call("POST", "/api/sessions/s1/assist/suggestion");
  await h.call("POST", "/api/sessions/s1/assist/note");
  await h.call("POST", "/api/sessions/s1/task-brief");
  assert.deepEqual(seen, ["usr_test:s1", "usr_test:s1", "usr_test:s1"]);
});

test("POST project assist/prompt improves a pre-session draft", async () => {
  const unavailable = routeHarness({});
  assert.equal((await unavailable.call("POST", "/api/projects/p1/assist/prompt", { draft: "fix teh bug" })).status, 503);

  const wired = routeHarness({
    improve: async (_space, projectId, draft) => `${projectId}: ${draft.replace("teh", "the")}`,
  });
  assert.deepEqual(
    (await wired.call("POST", "/api/projects/p1/assist/prompt", { draft: "fix teh bug" })).payload,
    { suggestion: "p1: fix the bug", atSeq: 0 },
  );
  const missing = routeHarness({
    improve: async () => { throw Object.assign(new Error("no small model configured"), { code: "unavailable" }); },
  });
  assert.equal((await missing.call("POST", "/api/projects/p1/assist/prompt", { draft: "fix it" })).status, 503);
  const stale = routeHarness({
    improve: async () => { throw Object.assign(new Error("model not available"), { code: "invalid-model" }); },
  });
  assert.equal((await stale.call("POST", "/api/projects/p1/assist/prompt", { draft: "fix it" })).status, 422);
  assert.equal((await wired.call("POST", "/api/projects/p1/assist/prompt", { draft: " " })).status, 400);
});
