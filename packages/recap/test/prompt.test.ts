import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection, SpaceContext, RouteRequest } from "@polyth/contracts";
import { buildNextActionPrompt, buildPromptImprovementPrompt, createManualSuggestionService, sanitizeNextActionReply } from "../src/prompt.ts";
import { promptRoutes } from "../src/promptRoutes.ts";

test("prompt helpers keep rewrites and next-action suggestions bounded", () => {
  const next = buildNextActionPrompt([
    { user: "Fix the retry path", assistant: "I found the missing await.", attachments: [], userSeq: 1, assistantSeq: 2 },
  ]);
  assert.match(next, /RECENT CONVERSATION:\nUser: Fix the retry path/);
  assert.match(next, /Assistant: I found the missing await/);
  assert.equal(sanitizeNextActionReply("\`\`\`\nSuggestion: Add a regression test.\n\`\`\`"), "Add a regression test.");
  assert.equal(sanitizeNextActionReply(`"${"x".repeat(900)}"`).length, 800);

  const improved = buildPromptImprovementPrompt("  fix retry  ");
  assert.match(improved, /USER PROMPT:\nfix retry$/);
  assert.match(improved, /Do not invent requirements/);

});
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
    events: async (_id, afterSeq = 0) => completedExchangeEvents().filter((event) => event.seq > afterSeq),
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
    events: async (_id, afterSeq = 0) => events.filter((event) => event.seq > afterSeq),
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

test("manual next-action service rejects no exchange and conversation movement, not bookkeeping", async () => {
  const noExchange = createManualSuggestionService({
    latestSeq: async () => 0,
    events: async () => [],
    complete: async () => "must not run",
  });
  await assert.rejects(noExchange.generate("s1"), { code: "no-completed-exchange" });

  let log = completedExchangeEvents();
  let release!: () => void;
  let blocked = new Promise<void>((resolve) => { release = resolve; });
  const svc = createManualSuggestionService({
    latestSeq: async () => log.at(-1)!.seq,
    events: async (_id, afterSeq = 0) => log.filter((event) => event.seq > afterSeq),
    complete: async () => { await blocked; return "Continue with the fix."; },
  });
  // Post-turn bookkeeping (usage, title) lands while the model writes: the
  // answer still describes the same conversation.
  const kept = svc.generate("s1");
  log = [...log, { id: "e8", sessionId: "s1", seq: 8, time: 8, type: "session/title", data: { title: "x" }, v: 1, ignorable: true }] as typeof log;
  release();
  assert.deepEqual(await kept, { suggestion: "Continue with the fix.", atSeq: 7 });

  blocked = new Promise<void>((resolve) => { release = resolve; });
  const moved = svc.generate("s1", "", "usr_other");
  await new Promise((resolve) => setImmediate(resolve));
  log = [...log, { id: "e9", sessionId: "s1", seq: 9, time: 9, type: "user/message", data: { text: "next" }, v: 1 }] as typeof log;
  release();
  await assert.rejects(moved, { code: "stale" });
});

test("next-action answers are shared per conversation until an explicit regenerate", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const log = completedExchangeEvents();
  const svc = createManualSuggestionService({
    latestSeq: async () => 7,
    events: async (_id, afterSeq = 0) => log.filter((event) => event.seq > afterSeq),
    complete: async () => { calls += 1; await blocked; return `Answer ${calls}`; },
  });
  // Two open clients ask at once: one model call, one answer.
  const first = svc.generate("s1", "", "usr_a");
  const second = svc.generate("s1", "", "usr_a");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await first, { suggestion: "Answer 1", atSeq: 7 });
  assert.deepEqual(await second, { suggestion: "Answer 1", atSeq: 7 });
  assert.deepEqual(await svc.generate("s1", "", "usr_a"), { suggestion: "Answer 1", atSeq: 7 }, "a remount reuses the answer");
  assert.equal(calls, 1);
  assert.deepEqual(await svc.generate("s1", "", "usr_a", { regenerate: true }), { suggestion: "Answer 2", atSeq: 7 });
  assert.deepEqual(await svc.generate("s1", "", "usr_b"), { suggestion: "Answer 3", atSeq: 7 }, "each person's small model answers for them");
  svc.invalidate();
  assert.deepEqual(await svc.generate("s1", "", "usr_a"), { suggestion: "Answer 4", atSeq: 7 }, "disabling the package forgets answers");

  // A draft rewrite stays one flight per session.
  let releaseRewrite!: () => void;
  const rewriting = new Promise<void>((resolve) => { releaseRewrite = resolve; });
  const rewrites = createManualSuggestionService({
    latestSeq: async () => 7,
    events: async () => log,
    complete: async () => { await rewriting; return "Fix it."; },
  });
  const rewrite = rewrites.generate("s1", "fix it");
  await assert.rejects(rewrites.generate("s1", "fix it"), { code: "in-flight" });
  releaseRewrite();
  assert.equal((await rewrite).suggestion, "Fix it.");
});

function routeHarness(opts: {
  projections?: Record<string, SessionProjection>;
  suggestion?: (
    space: SpaceContext, sessionId: string, draft?: string, options?: { regenerate?: boolean },
  ) => Promise<{ suggestion: string; atSeq: number }>;
  improve?: (space: SpaceContext, projectId: string, draft: string) => Promise<string>;
}) {
  const routes = promptRoutes({
    projection: async (_space, id) => opts.projections?.[id],
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

test("POST assist/suggestion returns an ephemeral result and typed conflicts", async () => {
  const unknown = routeHarness({ suggestion: async () => ({ suggestion: "x", atSeq: 7 }) });
  assert.equal((await unknown.call("POST", "/api/sessions/nope/assist/suggestion")).status, 404);

  const unavailable = routeHarness({ projections: { s1: proj("s1") } });
  assert.equal((await unavailable.call("POST", "/api/sessions/s1/assist/suggestion")).status, 503);

  const asked: Array<{ draft?: string; regenerate?: boolean }> = [];
  const ok = routeHarness({
    projections: { s1: proj("s1") },
    suggestion: async (_space, _id, draft, options) => {
      asked.push({ draft, regenerate: options?.regenerate });
      return { suggestion: "Validate the change.", atSeq: 7 };
    },
  });
  assert.deepEqual((await ok.call("POST", "/api/sessions/s1/assist/suggestion")).payload, {
    suggestion: "Validate the change.", atSeq: 7,
  });
  await ok.call("POST", "/api/sessions/s1/assist/suggestion", { draft: "", regenerate: true });
  await ok.call("POST", "/api/sessions/s1/assist/suggestion", { draft: "", regenerate: "yes" });
  assert.deepEqual(asked, [
    { draft: undefined, regenerate: false },
    { draft: "", regenerate: true },
    { draft: "", regenerate: false },
  ]);

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
