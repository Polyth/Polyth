import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import { settleScheduledRun } from "../src/runSettlement.ts";

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent =>
  ({ id: `e${seq}`, seq, type, data, sessionId: "s1", time: seq } as unknown as SessionEvent);

/** Serves `log` in pages that grow by one poll at a time, like a live session. */
function feed(batches: SessionEvent[][]) {
  const log: SessionEvent[] = [];
  let polls = 0;
  const reads: number[] = [];
  return {
    reads,
    events: async (_sessionId: string, afterSeq: number) => {
      reads.push(afterSeq);
      if (polls < batches.length) log.push(...batches[polls]!);
      polls += 1;
      return log.filter((event) => event.seq > afterSeq);
    },
  };
}

const opts = (events: (sessionId: string, afterSeq: number) => Promise<SessionEvent[]>, extra = {}) => ({
  events,
  signal: new AbortController().signal,
  sleep: async () => {},
  ...extra,
});

const run = { sessionId: "s1", markerSeq: 10, startedAt: Date.now() };

test("a run is ok only once its turn really completes, reading after its own marker", async () => {
  const source = feed([
    [ev(11, "user/message"), ev(12, "turn/started", { turnId: "t" })],
    [],
    [ev(13, "assistant/message"), ev(14, "turn/stopped", { turnId: "t", reason: "completed" })],
  ]);
  assert.deepEqual(await settleScheduledRun(run, opts(source.events)), { status: "ok" });
  assert.equal(source.reads[0], 10);
  assert.ok(source.reads.length >= 3, "kept observing while the turn was running");
});

test("a queued run waits for its own dispatch, ignoring the turn that was already running", async () => {
  const source = feed([[
    ev(11, "queue/enqueued", { queueId: "q1" }),
    ev(12, "turn/stopped", { reason: "completed" }), // the earlier turn
    ev(13, "queue/dispatched", { queueId: "q1" }),
    ev(14, "turn/started"),
    ev(15, "turn/stopped", { reason: "error", error: "tool exploded" }),
  ]]);
  assert.deepEqual(
    await settleScheduledRun({ ...run, queueId: "q1" }, opts(source.events)),
    { status: "failed", error: "tool exploded" },
  );
});

test("a provider-limit stop with a resume plan keeps waiting for the resumed turn", async () => {
  const source = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/stopped", { reason: "error", retry: { resumeAt: 99, retryable: true } }),
    ev(13, "turn/started"),
    ev(14, "turn/stopped", { reason: "completed" }),
  ]]);
  assert.deepEqual(await settleScheduledRun(run, opts(source.events)), { status: "ok" });
});

test("a turn the tool watchdog cut and continued is still the run, not a stop", async () => {
  const continued = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "tool-timeout", source: "tool-watchdog" }),
    ev(13, "turn/stopped", { reason: "aborted" }),
  ], [], [
    ev(14, "user/message", { hiddenUserMessage: true, autoResume: true }),
    ev(15, "turn/started"),
    ev(16, "assistant/message", { text: "Shipped.\n\nReport: update — done" }),
    ev(17, "turn/stopped", { reason: "completed" }),
  ]]);
  const settled = await settleScheduledRun(run, opts(continued.events, { now: () => 20 }));
  assert.equal(settled.status, "ok");
  assert.match(settled.summary ?? "", /Shipped/);

  // The person's own message instead of the continuation ends the run as stopped.
  const overtaken = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "tool-timeout", source: "tool-watchdog" }),
    ev(13, "turn/stopped", { reason: "aborted" }),
    ev(14, "user/message", { text: "stop that" }),
  ]]);
  assert.equal((await settleScheduledRun(run, opts(overtaken.events))).status, "failed");

  // A watchdog abort with no continuation planned (no source) is a plain stop.
  const spent = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "tool-timeout" }),
    ev(13, "turn/stopped", { reason: "aborted" }),
  ]]);
  assert.equal((await settleScheduledRun(run, opts(spent.events))).status, "failed");

  // A continuation that never comes gives up after its bound.
  let clock = 0;
  const lost = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "tool-timeout", source: "tool-watchdog" }),
    { ...ev(13, "turn/stopped", { reason: "aborted" }), time: 0 } as SessionEvent,
  ]]);
  const gaveUp = await settleScheduledRun({ ...run, startedAt: 0 }, opts(lost.events, {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  }));
  assert.deepEqual(gaveUp, { status: "failed", error: "Stopped before it finished." });
  assert.ok(clock >= 15 * 60_000 && clock < 60 * 60_000, `gave up after ${clock} ms`);
});

test("abort, queue removal, a lost session and the observation limit never read as success", async () => {
  const aborted = feed([[ev(11, "turn/started"), ev(12, "turn/stopped", { reason: "aborted" })]]);
  assert.equal((await settleScheduledRun(run, opts(aborted.events))).status, "failed");

  const removed = feed([[ev(11, "queue/removed", { queueId: "q1" })]]);
  assert.equal((await settleScheduledRun({ ...run, queueId: "q1" }, opts(removed.events))).status, "unknown");

  const gone = async () => { throw Object.assign(new Error("session not found"), { code: "not-found" }); };
  assert.equal((await settleScheduledRun(run, opts(gone))).status, "unknown");

  let clock = 0;
  const silent = feed([[ev(11, "turn/started")]]);
  const limited = await settleScheduledRun({ ...run, startedAt: 0 }, opts(silent.events, {
    now: () => clock,
    maxRunMs: 1_000,
    sleep: async (ms: number) => { clock += ms; },
  }));
  assert.equal(limited.status, "unknown");
  assert.match(limited.error ?? "", /observation limit/);

  assert.equal((await settleScheduledRun({ startedAt: Date.now() }, opts(silent.events))).status, "unknown");
});

test("detaching the observer rejects instead of inventing an outcome", async () => {
  const controller = new AbortController();
  const source = feed([[ev(11, "turn/started")]]);
  const pending = settleScheduledRun(run, {
    events: source.events,
    signal: controller.signal,
    minPollMs: 5,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
});

test("while a request waits for a person the observer keeps looking, so a decision shows soon", async () => {
  const waits: number[] = [];
  const reports: number[] = [];
  const source = feed([
    [ev(11, "turn/started"), ev(12, "permission/requested", { requestId: "req", permission: "bash", patterns: ["ls"] })],
    [], [], [], [], [], [], [], [], [],
    [ev(13, "permission/resolved", { requestId: "req", reply: "once" })],
    [ev(14, "turn/stopped", { reason: "completed" })],
  ]);
  const settled = await settleScheduledRun(run, {
    events: source.events,
    signal: new AbortController().signal,
    minPollMs: 1_000,
    maxPollMs: 15_000,
    sleep: async (ms) => { waits.push(ms); },
    onWaiting: (waiting) => { reports.push(waiting.length); },
  });
  assert.equal(settled.status, "ok");
  assert.deepEqual(reports, [1, 0]);
  assert.ok(Math.max(...waits) <= 2_000, `never looked away for long: ${waits.join(", ")}`);
});

const launch = (seq: number, callId: string, description?: string) =>
  ev(seq, "tool/started", { callId, tool: "Bash", input: { command: "watch ci", run_in_background: true, ...(description ? { description } : {}) } });
const wake = (seq: number) => ev(seq, "user/message", { text: "A background task you started has finished…", hiddenUserMessage: true });

test("a turn that ends to wait for its background work is not the run's end: the woken turn's report is", async () => {
  const waits: Array<unknown> = [];
  const source = feed([
    [
      ev(11, "turn/started"),
      ev(12, "assistant/message", { text: "CI on devel is red: **the lockfile** misses a workspace." }),
      launch(13, "c1", "Wait for CI on devel"),
      ev(14, "assistant/message", { text: "Pushed the fix. I'll write the report once CI finishes." }),
      ev(15, "turn/stopped", { reason: "completed" }),
    ],
    [],
    [
      wake(16),
      ev(17, "turn/started"),
      ev(18, "assistant/message", { text: "CI is green.\n\nNeeds you: PR #32 — smoke test\nReport: update — devel fixed, PR #32 waits for you" }),
      ev(19, "turn/stopped", { reason: "completed" }),
    ],
  ]);
  const settled = await settleScheduledRun(run, opts(source.events, { now: () => 20, onBackground: (wait: unknown) => { waits.push(wait); } }));
  assert.equal(settled.status, "ok");
  assert.match(settled.summary ?? "", /Report: update — devel fixed/);
  assert.deepEqual(waits, [{ since: 15, tasks: ["Wait for CI on devel"] }, null]);
  assert.deepEqual(settled.timeline, [
    { at: 12, text: "CI on devel is red: the lockfile misses a workspace." },
    { at: 14, text: "Pushed the fix. I'll write the report once CI finishes." },
    { at: 15, text: "Wait for CI on devel", kind: "wait", until: 16 },
  ], "the final message is the report, not a step");
});

test("a turn whose message carries its Report ends the run even while background work runs", async () => {
  const source = feed([[
    ev(11, "turn/started"),
    launch(12, "c1"),
    ev(13, "assistant/message", { text: "Report: quiet — nothing new" }),
    ev(14, "turn/stopped", { reason: "completed" }),
  ]]);
  let waited = false;
  const settled = await settleScheduledRun(run, opts(source.events, { onBackground: () => { waited = true; } }));
  assert.equal(settled.status, "ok");
  assert.equal(waited, false);
});

test("a waiting run ends with its last words when the session moves on, the wait runs out or the person stops it", async () => {
  const waitingTurn = [
    ev(11, "turn/started"),
    ev(12, "tool/call", { callId: "m1", tool: "Monitor", status: "pending", input: {} }),
    ev(13, "tool/started", { callId: "m1", tool: "Monitor", input: { description: "CI on devel" } }),
    ev(14, "assistant/message", { text: "Watching CI." }),
    ev(15, "turn/stopped", { reason: "completed" }),
  ];
  // Someone else's turn: the person wrote into the session, or another run began.
  for (const next of [ev(16, "user/message", { text: "hi" }), ev(16, "schedule/run-started", { runId: "r2" })]) {
    const moved = await settleScheduledRun(run, opts(feed([waitingTurn, [next], [ev(17, "turn/started")]]).events));
    assert.equal(moved.status, "ok");
    assert.equal(moved.summary, "Watching CI.");
  }

  let clock = 0;
  const lost = await settleScheduledRun({ ...run, startedAt: 0 }, opts(feed([waitingTurn]).events, {
    now: () => clock,
    backgroundWaitMs: 60_000,
    sleep: async (ms: number) => { clock += ms; },
  }));
  assert.equal(lost.status, "ok", "work lost with its process ends the wait");
  assert.ok(clock >= 60_000 - 15 && clock < 120_000, `waited about the limit: ${clock}`);

  let stop = false;
  let polls = 0;
  const stopped = await settleScheduledRun(run, opts(feed([waitingTurn]).events, {
    now: () => 20,
    stopRequested: () => stop,
    sleep: async () => { if (++polls === 3) stop = true; },
  }));
  assert.deepEqual([stopped.status, stopped.error], ["failed", "Stopped before it finished."]);
});

test("a Monitor that wakes the agent twice still counts as one launch", async () => {
  const source = feed([[
    ev(11, "turn/started"),
    ev(12, "tool/started", { callId: "m1", tool: "Monitor", input: { description: "CI" } }),
    ev(13, "turn/stopped", { reason: "completed" }),
    wake(14), ev(15, "turn/started"), ev(16, "turn/stopped", { reason: "completed" }),
  ]]);
  const settled = await settleScheduledRun(run, opts(source.events));
  assert.equal(settled.status, "ok");
  assert.deepEqual(settled.timeline?.map((moment) => moment.kind), ["wait"]);
});
