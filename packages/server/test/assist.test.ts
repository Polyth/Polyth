// F9: idle assist is a hard-switched, one-flight-per-session watcher whose
// output lives on the projection keyed to the log tail — any new event makes
// it stale (the route answers 404), and disabled means NOTHING is generated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionAssist, SessionProjection } from "@polyth/contracts";
import {
  buildAssistPrompt, buildNotePrompt, capWords, createAssistService, createAssistSettings,
  isFresh, parseAssistReply, parseNoteReply, RECAP_MAX_WORDS,
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
}) {
  const settings = createAssistSettings({ file: join(tmp(), "assist.json") });
  const routes = assistRoutes({
    settings,
    projection: async (id) => opts.projections?.[id],
    latestSeq: async () => opts.latestSeq ?? 0,
    ...(opts.distill ? { distill: opts.distill } : {}),
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {},
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
