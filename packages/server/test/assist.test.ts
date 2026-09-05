// F9: idle assist is a hard-switched, one-flight-per-session watcher whose
// output lives on the projection keyed to the log tail — any new event makes
// it stale (the route answers 404), and disabled means NOTHING is generated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionAssist, SessionProjection } from "@polyth/contracts";
import type { SpaceContext } from "@polyth/contracts";
import {
  buildAssistPrompt, buildNextActionPrompt, buildNotePrompt, buildPromptImprovementPrompt, capWords, createAssistService, createAssistSettings,
  createManualSuggestionService, isFresh, parseAssistReply, parseNoteReply, RECAP_MAX_WORDS,
  sanitizeNextActionReply,
} from "../src/assist.ts";
import { assistRoutes } from "../src/routes/assist.ts";
import type { RouteRequest } from "../src/http.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-assist-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("assist settings: default off, clamped idle, persisted round-trip", () => {
  const file = join(tmp(), "assist.json");
  const svc = createAssistSettings({ file });
  assert.deepEqual(svc.get(), { enabled: false, idleSeconds: 120 });

  const saved = svc.put({ enabled: true, idleSeconds: 3 });
  assert.equal(saved.enabled, true);
  assert.equal(saved.idleSeconds, 10); // clamped up to the minimum

  assert.equal(svc.put({ idleSeconds: 999_999 }).idleSeconds, 3600); // clamped down
  assert.throws(() => svc.put({ idleSeconds: "soon" }), /number/);

  assert.match(readFileSync(file, "utf8"), /"enabled": true/);
  const reloaded = createAssistSettings({ file });
  assert.equal(reloaded.get().enabled, true);
});

test("assist settings: corrupt file is left untouched on load", () => {
  const file = join(tmp(), "assist.json");
  writeFileSync(file, "{{{");
  const before = readFileSync(file, "utf8");
  const svc = createAssistSettings({ file });
  assert.deepEqual(svc.get(), { enabled: false, idleSeconds: 120 });
  assert.equal(readFileSync(file, "utf8"), before, "corrupt file must not be rewritten on load");
});

test("pure helpers: word cap, freshness, reply parsing", () => {
  assert.equal(capWords("one two three", 5), "one two three");
  assert.equal(capWords("a b c d", 2), "a b…");

  assert.equal(isFresh(undefined, 5), false);
  assert.equal(isFresh({ atSeq: 5 }, 5), true);
  assert.equal(isFresh({ atSeq: 5 }, 6), false); // any new event = stale

  const labeled = parseAssistReply("Recap: refactored the queue store.\nSuggestion: Add a migration test.");
  assert.deepEqual(labeled, { recap: "refactored the queue store.", suggestion: "Add a migration test." });

  // fenced + label-less fallback: first two non-empty lines
  const loose = parseAssistReply("```\nFixed the login bug\nRun the auth test suite now\n```");
  assert.equal(loose?.recap, "Fixed the login bug");
  assert.equal(loose?.suggestion, "Run the auth test suite now");

  assert.equal(parseAssistReply("just one line"), null);
  assert.equal(parseAssistReply(""), null);

  // an over-long recap is hard-capped even if the model ignored the limit
  const long = parseAssistReply(`Recap: ${"word ".repeat(40)}\nSuggestion: do x`);
  assert.equal(long!.recap.split(/\s+/).length, RECAP_MAX_WORDS); // ellipsis rides the last word
  assert.ok(long!.recap.endsWith("…"));

  assert.deepEqual(parseNoteReply("Title here\n\nBody line"), { title: "Title here", body: "Body line" });
  assert.deepEqual(parseNoteReply("only-title"), { title: "only-title", body: "" });

  assert.match(buildAssistPrompt("T"), /<conversation>\nT\n<\/conversation>/);
  assert.match(buildNotePrompt("T"), /project note/);

  const next = buildNextActionPrompt({ user: "Fix the retry path", assistant: "I found the missing await." });
  assert.match(next, /LATEST USER MESSAGE:\nFix the retry path/);
  assert.match(next, /LATEST ASSISTANT RESPONSE:\nI found the missing await/);
  assert.equal(sanitizeNextActionReply("```\nSuggestion: Add a regression test.\n```"), "Add a regression test.");
  assert.equal(sanitizeNextActionReply(`"${"x".repeat(900)}"`).length, 800);
  assert.equal(sanitizeNextActionReply("Improved prompt: Fix it."), "Fix it.");
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

test("manual next-action service sends only the latest completed exchange and returns an ephemeral suggestion", async () => {
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
  assert.doesNotMatch(prompts[0]!, /older prompt|older answer|tool-only/);
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

// -------------------------------------------------------------- service

function serviceHarness(opts: {
  enabled?: boolean;
  idleSeconds?: number;
  completeDelayMs?: number;
  reply?: string;
}) {
  let seq = 10;
  const saves: Array<{ sessionId: string; assist: SessionAssist }> = [];
  const completes: string[] = [];
  const errors: unknown[] = [];
  const svc = createAssistService({
    settings: () => ({ enabled: opts.enabled ?? true, idleSeconds: opts.idleSeconds ?? 0.01 }),
    latestSeq: async () => seq,
    transcript: async () => "User: fix the bug\n\nAssistant: fixed it",
    complete: async (_sid, prompt) => {
      completes.push(prompt);
      if (opts.completeDelayMs) await sleep(opts.completeDelayMs);
      return opts.reply ?? "Recap: fixed the bug\nSuggestion: Add a regression test.";
    },
    save: async (sessionId, assist) => { saves.push({ sessionId, assist }); },
    onError: (_sid, err) => { errors.push(err); },
  });
  return { svc, saves, completes, errors, bumpSeq: () => { seq += 1; }, seqNow: () => seq };
}

test("assist service: quiet session gets a recap keyed to the log tail", async () => {
  const h = serviceHarness({});
  h.svc.onTurnCompleted("s1");
  await sleep(60);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0]!.sessionId, "s1");
  assert.equal(h.saves[0]!.assist.atSeq, 10);
  assert.equal(h.saves[0]!.assist.recap, "fixed the bug");
  assert.equal(h.saves[0]!.assist.suggestion, "Add a regression test.");
  assert.equal(h.errors.length, 0);
  h.svc.stop();
});

test("assist service: hard switch — disabled generates NOTHING", async () => {
  const h = serviceHarness({ enabled: false });
  h.svc.onTurnCompleted("s1");
  await sleep(50);
  assert.equal(h.completes.length, 0);
  assert.equal(h.saves.length, 0);
  h.svc.stop();
});

test("assist service: a new event between schedule and fire skips generation", async () => {
  const h = serviceHarness({ idleSeconds: 0.25 });
  h.svc.onTurnCompleted("s1");
  await sleep(20); // after latestSeq capture, well before the 250ms timer fires
  h.bumpSeq();
  await sleep(400);
  assert.equal(h.completes.length, 0);
  assert.equal(h.saves.length, 0);
  h.svc.stop();
});

test("assist service: a new event DURING generation discards the result", async () => {
  const h = serviceHarness({ idleSeconds: 0.02, completeDelayMs: 250 });
  h.svc.onTurnCompleted("s1");
  await sleep(120); // model call in flight (starts ~20ms in, runs 250ms)
  h.bumpSeq();
  await sleep(400);
  assert.equal(h.completes.length, 1); // the call happened…
  assert.equal(h.saves.length, 0);     // …but the stale result was dropped
  h.svc.stop();
});

test("assist service: unusable model output saves nothing, errors fail soft", async () => {
  const bad = serviceHarness({ reply: "cannot help" });
  bad.svc.onTurnCompleted("s1");
  await sleep(60);
  assert.equal(bad.saves.length, 0);
  bad.svc.stop();

  const boom = createAssistService({
    settings: () => ({ enabled: true, idleSeconds: 0.01 }),
    latestSeq: async () => 1,
    transcript: async () => "x",
    complete: async () => { throw new Error("model offline"); },
    save: async () => { throw new Error("must not save"); },
    onError: () => { /* observed */ },
  });
  boom.onTurnCompleted("s1");
  await sleep(60);
  boom.stop(); // reaching here without an unhandled rejection is the assertion
});

// -------------------------------------------------------------- routes

function routeHarness(opts: {
  projections?: Record<string, SessionProjection>;
  latestSeq?: number;
  distill?: (sessionId: string) => Promise<{ title: string; body: string }>;
  taskBrief?: (sessionId: string) => Promise<string>;
  suggestion?: (sessionId: string, draft?: string) => Promise<{ suggestion: string; atSeq: number }>;
  improve?: (space: SpaceContext, projectId: string, draft: string) => Promise<string>;
}) {
  const settings = createAssistSettings({ file: join(tmp(), "assist.json") });
  const routes = assistRoutes({
    settings,
    projection: async (id) => opts.projections?.[id],
    latestSeq: async () => opts.latestSeq ?? 0,
    ...(opts.distill ? { distill: opts.distill } : {}),
    ...(opts.taskBrief ? { taskBrief: opts.taskBrief } : {}),
    ...(opts.suggestion ? { suggestion: opts.suggestion } : {}),
    ...(opts.improve ? { improve: opts.improve } : {}),
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {}, space: { spaceId: "space-1", membership: { role: "owner" } },
      url: new URL(`http://x${path}`),
      path, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload };
  };
  return { settings, call };
}

const proj = (id: string, assist?: SessionAssist): SessionProjection => ({
  id, projectId: "p1", title: "t", status: "idle", createdAt: 1, updatedAt: 1,
  ...(assist ? { assist } : {}),
});

test("GET/PUT /api/settings/assist round-trips the hard switch", async () => {
  const h = routeHarness({});
  const before = await h.call("GET", "/api/settings/assist");
  assert.equal(before.status, 200);
  assert.deepEqual(before.payload, { enabled: false, idleSeconds: 120 });

  const after = await h.call("PUT", "/api/settings/assist", { enabled: true, idleSeconds: 60 });
  assert.equal(after.status, 200);
  assert.deepEqual(after.payload, { enabled: true, idleSeconds: 60 });
});

test("GET assist: 404 unknown session, 404 none, 404 stale, 200 fresh", async () => {
  const fresh: SessionAssist = { recap: "r", suggestion: "s", atSeq: 7, generatedAt: 1 };

  const unknown = routeHarness({});
  assert.equal((await unknown.call("GET", "/api/sessions/nope/assist")).status, 404);

  const none = routeHarness({ projections: { s1: proj("s1") }, latestSeq: 7 });
  const r0 = await none.call("GET", "/api/sessions/s1/assist");
  assert.equal(r0.status, 404);
  assert.equal((r0.payload as { error: string }).error, "not-found");

  const stale = routeHarness({ projections: { s1: proj("s1", fresh) }, latestSeq: 9 });
  const r1 = await stale.call("GET", "/api/sessions/s1/assist");
  assert.equal(r1.status, 404);
  assert.equal((r1.payload as { error: string }).error, "stale");

  const ok = routeHarness({ projections: { s1: proj("s1", fresh) }, latestSeq: 7 });
  const r2 = await ok.call("GET", "/api/sessions/s1/assist");
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.payload, fresh);
});

test("POST assist/note: 404 unknown, 503 unwired, draft when wired, 502 on failure", async () => {
  const unknown = routeHarness({ distill: async () => ({ title: "t", body: "b" }) });
  assert.equal((await unknown.call("POST", "/api/sessions/nope/assist/note")).status, 404);

  const unwired = routeHarness({ projections: { s1: proj("s1") } });
  assert.equal((await unwired.call("POST", "/api/sessions/s1/assist/note")).status, 503);

  const wired = routeHarness({
    projections: { s1: proj("s1") },
    distill: async (id) => ({ title: `Note for ${id}`, body: "decisions" }),
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
  assert.equal((await wired.call("POST", "/api/projects/p1/assist/prompt", { draft: " " })).status, 400);
});
