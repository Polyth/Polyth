// WP11: generated walkthrough jobs (digest, cache, cancel, staleness,
// event-before-ready) and the bounded review flow (pass, iteration limit,
// permission pause, stop idempotency, no external write access by shape).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SessionEvent, WalkthroughSource } from "@polyth/contracts";
import { createWalkthroughJobService } from "../src/jobs.ts";
import { createReviewFlowService, createReviewService, type ReviewResult } from "../src/reviewService.ts";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts", "+++ b/src/a.ts",
  "@@ -1,1 +1,2 @@", " keep", "+added",
].join("\n");

const source: WalkthroughSource = { kind: "working-tree", projectId: "p1" };

interface Logged { sessionId: string; type: string; data: JsonObject }
const makeLog = () => {
  const events: Logged[] = [];
  const append = async (sessionId: string, type: string, data: JsonObject): Promise<SessionEvent> => {
    events.push({ sessionId, type, data });
    return { id: "e", sessionId, seq: events.length, time: Date.now(), type, data, v: 1 };
  };
  return { events, append };
};

test("walkthrough job: heuristic stages when no model, digest captured before generation", async () => {
  const svc = createWalkthroughJobService({ captureDiff: async () => DIFF });
  const job = await svc.create(source);
  await svc.settled(job.id);
  const done = svc.get(job.id)!;
  assert.equal(done.status, "ready");
  assert.equal(done.stages.length, 1);
  assert.match(done.stages[0]!.explanation, /Heuristic/);
  assert.equal(done.sourceDigest.length, 64);
});

test("walkthrough job: model stages, malformed JSON fails the job honestly", async () => {
  let calls = 0;
  const good = createWalkthroughJobService({
    captureDiff: async () => DIFF,
    generate: async (_s, prompt) => {
      calls += 1;
      const id = /--- hunk (\w+)/.exec(prompt)![1]!;
      return JSON.stringify({ stages: [{ title: "The change", explanation: "adds a line", stops: [{ hunkId: id, explanation: "here" }] }] });
    },
  });
  const j1 = await good.create(source);
  await good.settled(j1.id);
  assert.equal(good.get(j1.id)!.status, "ready");
  assert.equal(good.get(j1.id)!.stages[0]!.title, "The change");
  assert.equal(calls, 1);

  // cache hit by digest+prompt version: second job never calls the model
  const j2 = await good.create(source);
  await good.settled(j2.id);
  assert.equal(good.get(j2.id)!.status, "ready");
  assert.equal(calls, 1);

  const bad = createWalkthroughJobService({
    captureDiff: async () => DIFF,
    generate: async () => "sorry, I cannot",
  });
  const j3 = await bad.create(source);
  await bad.settled(j3.id);
  assert.equal(bad.get(j3.id)!.status, "failed");
  assert.match(bad.get(j3.id)!.error!, /malformed/);
});

test("walkthrough job: cache survives restart via cache file", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-wt-")), "cache.json");
  let calls = 0;
  const mk = () => createWalkthroughJobService({
    captureDiff: async () => DIFF,
    generate: async (_s, prompt) => {
      calls += 1;
      const id = /--- hunk (\w+)/.exec(prompt)![1]!;
      return JSON.stringify({ stages: [{ title: "T", stops: [{ hunkId: id }] }] });
    },
    cacheFile: file,
  });
  const first = mk();
  const j = await first.create(source);
  await first.settled(j.id);
  assert.equal(calls, 1);

  const second = mk(); // "restart"
  const j2 = await second.create(source);
  await second.settled(j2.id);
  assert.equal(second.get(j2.id)!.status, "ready");
  assert.equal(calls, 1); // served from disk cache
});

test("walkthrough job: empty diff fails, source-status detects staleness, cancel wins", async () => {
  let diff = DIFF;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const svc = createWalkthroughJobService({
    captureDiff: async () => diff,
    generate: async () => { await gate; return "{}"; },
  });

  const empty = await svc.create({ kind: "working-tree", projectId: "empty" });
  assert.equal(diff && (diff = diff), DIFF); // keep tsc quiet about unused writes
  diff = "";
  const emptyJob = await svc.create(source);
  assert.equal(emptyJob.status, "failed");
  assert.match(emptyJob.error!, /no changes/);
  diff = DIFF;

  const job = await svc.create(source);
  assert.equal(job.status === "queued" || job.status === "running", true);
  const cancelledJob = svc.cancel(job.id)!;
  assert.equal(cancelledJob.status, "failed");
  assert.equal(cancelledJob.error, "cancelled");
  release();
  await svc.settled(job.id);
  assert.equal(svc.get(job.id)!.error, "cancelled"); // late model result cannot resurrect it

  // staleness: change the working tree after capture
  diff = DIFF + "\n+more";
  const st = await svc.sourceStatus(empty.id);
  assert.equal(st.stale, true);
  assert.notEqual(st.currentDigest, st.sourceDigest);
});

test("walkthrough job: walkthrough/generated is logged before the job is ready", async () => {
  const { events, append } = makeLog();
  let readyAtLogTime: string | undefined;
  const svc = createWalkthroughJobService({
    captureDiff: async () => DIFF,
    append: async (sid, type, data) => {
      readyAtLogTime = svc.get(String(data.walkthroughId))!.status;
      return append(sid, type, data);
    },
  });
  const job = await svc.create(source, "sess-1");
  await svc.settled(job.id);
  assert.equal(svc.get(job.id)!.status, "ready");
  assert.equal(events[0]?.type, "walkthrough/generated");
  assert.equal(events[0]?.sessionId, "sess-1");
  assert.equal(readyAtLogTime, "running"); // logged before status flipped
});

// ---- review generation ---------------------------------------------------

test("review generation logs review/generated and review/risk-scored before returning", async () => {
  const { events, append } = makeLog();
  const svc = createReviewService({
    captureDiff: async () => DIFF,
    generate: async () => JSON.stringify({
      summary: "ok change", findings: [{ severity: "low", body: "nit", confidence: 0.4 }],
      riskScore: 2, confidenceScore: 4,
    }),
    append,
  });
  const r = await svc.generate("sess-9", source);
  assert.ok(r.ok);
  assert.deepEqual(events.map((e) => e.type), ["review/generated", "review/risk-scored"]);
  assert.equal(events[0]?.sessionId, "sess-9");

  const noModel = createReviewService({ captureDiff: async () => DIFF, generate: null, append });
  const denied = await noModel.generate("s", source);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /unavailable/);

  const malformed = createReviewService({ captureDiff: async () => DIFF, generate: async () => "prose only", append });
  const badR = await malformed.generate("s", source);
  assert.equal(badR.ok, false);
});

// ---- review flow -----------------------------------------------------------

interface FlowHarness {
  status: string;
  sent: string[];
  events: Logged[];
  reviews: ReviewResult[];
}

const makeFlow = (opts: { reviews: ReviewResult[]; threshold?: number }) => {
  const h: FlowHarness = { status: "idle", sent: [], events: [], reviews: [...opts.reviews] };
  const { events, append } = makeLog();
  h.events = events;
  const flow = createReviewFlowService({
    sessionStatus: async () => h.status,
    sessionProject: async () => "p1",
    send: async (_sid, text) => { h.sent.push(text); },
    review: async () => h.reviews.shift() ?? { ok: false, reason: "no more reviews scripted" },
    append,
    ...(opts.threshold !== undefined ? { passRiskThreshold: opts.threshold } : {}),
  });
  return { h, flow };
};

const pass: ReviewResult = {
  ok: true, reviewId: "r-pass", sourceDigest: "d1",
  assessment: { summary: "fine", findings: [], riskScore: 1, confidenceScore: 5 },
};
const failHigh: ReviewResult = {
  ok: true, reviewId: "r-fail", sourceDigest: "d2",
  assessment: {
    summary: "problems", findings: [{ severity: "high", body: "bug", confidence: 0.9 }],
    riskScore: 4, confidenceScore: 4,
  },
};

test("review flow passes when review is clean", async () => {
  const { h, flow } = makeFlow({ reviews: [pass] });
  await flow.create("s1");
  assert.equal(h.events[0]?.type, "review-flow/started");
  await flow.tick(); // idle → review requested → passed
  const state = flow.get("s1")!;
  assert.equal(state.status, "passed");
  assert.equal(state.latestReviewId, "r-pass");
  assert.deepEqual(h.events.map((e) => e.type), ["review-flow/started", "review-flow/review-requested", "review-flow/passed"]);
  assert.equal(h.sent.length, 0);
});

test("review flow iterates on changes-requested and stops at the limit", async () => {
  const { h, flow } = makeFlow({ reviews: [failHigh, failHigh, failHigh] });
  await flow.create("s2", { maxIterations: 2 });
  await flow.tick(); // review 1 → changes requested, iteration 1, prompt sent
  assert.equal(flow.get("s2")!.status, "implementing");
  assert.equal(flow.get("s2")!.iteration, 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /Do not merge, push, or publish/);
  // the handoff prompt was logged before send
  const cr = h.events.find((e) => e.type === "review-flow/changes-requested");
  assert.equal(cr?.data.prompt, h.sent[0]);

  await flow.tick(); // review 2 → iteration 2
  assert.equal(flow.get("s2")!.iteration, 2);
  await flow.tick(); // review 3 → at limit → stopped
  const state = flow.get("s2")!;
  assert.equal(state.status, "stopped");
  assert.match(state.stoppedReason!, /iteration limit/);
  assert.equal(h.sent.length, 2); // no prompt after stop
});

test("review flow pauses when the session waits on a permission", async () => {
  const { h, flow } = makeFlow({ reviews: [pass] });
  await flow.create("s3");
  h.status = "waiting";
  await flow.tick();
  assert.equal(flow.get("s3")!.status, "paused");
  // resume continues where it left off
  h.status = "idle";
  await flow.resume("s3");
  await flow.tick();
  assert.equal(flow.get("s3")!.status, "passed");
});

test("review flow stop is idempotent and reviewer errors fail the flow", async () => {
  const { h, flow } = makeFlow({ reviews: [{ ok: false, reason: "reviewer parse error" }] });
  await flow.create("s4");
  await flow.tick();
  assert.equal(flow.get("s4")!.status, "failed");
  const eventsAfterFail = h.events.length;
  const stopped = await flow.stop("s4");
  assert.equal(stopped!.status, "failed"); // settled flows stay settled
  assert.equal(h.events.length, eventsAfterFail); // no duplicate event

  const second = makeFlow({ reviews: [] });
  await second.flow.create("s5");
  await second.flow.stop("s5");
  const count = second.h.events.length;
  await second.flow.stop("s5"); // second stop appends nothing
  assert.equal(second.h.events.length, count);
});
