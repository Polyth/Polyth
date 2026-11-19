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
    { status: "failed", cause: "error", error: "tool exploded" },
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

  // The person's own message instead of the continuation: the run goes on
  // with the turn their message starts, and its report is the run's.
  const overtaken = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "tool-timeout", source: "tool-watchdog" }),
    ev(13, "turn/stopped", { reason: "aborted" }),
    ev(14, "user/message", { text: "build it again from the new devel" }),
    ev(15, "turn/started"),
    ev(16, "assistant/message", { text: "Rebuilt.\n\nReport: update — rebuilt from devel" }),
    ev(17, "turn/stopped", { reason: "completed" }),
  ]]);
  const followed = await settleScheduledRun(run, opts(overtaken.events));
  assert.equal(followed.status, "ok");
  assert.equal(followed.steered, true);
  assert.match(followed.summary ?? "", /Rebuilt/);

  // A message that starts no turn leaves the run as the person's stop.
  const silent = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "tool-timeout", source: "tool-watchdog" }),
    ev(13, "turn/stopped", { reason: "aborted" }),
    ev(14, "user/message", { text: "stop that" }),
  ]]);
  const left = await settleScheduledRun(run, opts(silent.events));
  assert.equal(left.status, "failed");
  assert.equal(left.stopped, true);
  assert.equal(left.cause, "person");

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
  assert.deepEqual(gaveUp, { status: "failed", cause: "cut", error: "Cut off before it finished." });
  assert.ok(clock >= 15 * 60_000 && clock < 60 * 60_000, `gave up after ${clock} ms`);
});

test("a turn a Polyth restart cut and the server replayed on a fresh runtime is still the run", async () => {
  const continued = feed([[
    ev(11, "turn/started"),
    ev(12, "tool/started", { callId: "c1", tool: "bash" }),
    ev(13, "turn/abort-requested", { reason: "runtime-replaced", source: "runtime-epoch" }),
    ev(14, "tool/error", { callId: "c1", tool: "bash" }),
    ev(15, "turn/stopped", { reason: "aborted" }),
    ev(16, "runtime/epoch-replaced", { new: { epoch: 2 } }),
  ], [], [
    // The run's prompt replayed as the hidden epoch continuation.
    ev(17, "user/message", { text: "charter", hiddenUserMessage: true, autoResume: true, runtimeEpochRecovery: { epoch: 2, markerSeq: 16 } }),
    ev(18, "turn/started"),
    ev(19, "assistant/message", { text: "Finished after the restart." }),
    ev(20, "turn/stopped", { reason: "completed" }),
  ]]);
  const settled = await settleScheduledRun(run, opts(continued.events, { now: () => 25 }));
  assert.equal(settled.status, "ok");

  // A person's own message instead of the continuation ends the run as stopped.
  const other = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "runtime-replaced", source: "runtime-epoch" }),
    ev(13, "turn/stopped", { reason: "aborted" }),
    ev(14, "user/message", { text: "stop that" }),
  ]]);
  assert.equal((await settleScheduledRun(run, opts(other.events))).status, "failed");
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

// ---- who cut the turn, and what the run does about it ----

/** A runner that records each continuation and appends its marker, like the
 *  server's: `log` is the live session the settlement reads. */
function resumer(log: SessionEvent[], next: (attempt: number) => SessionEvent[]) {
  const asked: Array<{ attempt: number; cause: string }> = [];
  return {
    asked,
    onCut: async (attempt: number, cause: string) => {
      asked.push({ attempt, cause });
      const seq = log.at(-1)!.seq;
      log.push(ev(seq + 1, "schedule/run-resumed", { runId: "r1", attempt }), ...next(attempt));
      return true;
    },
  };
}

const live = (log: SessionEvent[]) => async (_sessionId: string, afterSeq: number) => log.filter((event) => event.seq > afterSeq);
const instant = { resumeDelaysMs: [0] };
const owned = { ...run, runId: "r1" };

test("a person's interrupting message redirects the run: its turn and report are the run's", async () => {
  const source = feed([[
    ev(11, "turn/started"),
    ev(12, "assistant/message", { text: "I'll start by checking what the previous run left behind." }),
    ev(13, "turn/abort-requested", { reason: "interrupt", queueId: "q9" }),
    ev(14, "turn/stopped", { reason: "aborted" }),
    ev(15, "user/message", { text: "devel has new changes, build again", queueId: "q9" }),
    ev(16, "turn/started"),
    ev(17, "assistant/message", { text: "Rebuilt from the new devel.\n\nReport: update — nightly rebuilt" }),
    ev(18, "turn/stopped", { reason: "completed" }),
  ]]);
  const settled = await settleScheduledRun(run, opts(source.events));
  assert.equal(settled.status, "ok");
  assert.equal(settled.steered, true);
  assert.match(settled.summary ?? "", /Rebuilt from the new devel/);
});

test("a stop someone asked for is theirs: never a failure of the agent, never continued", async () => {
  for (const source of ["http", "agent-stop", "composer"]) {
    const log = [
      ev(11, "turn/started"),
      ev(12, "turn/abort-requested", { reason: "user", source }),
      ev(13, "turn/stopped", { reason: "aborted" }),
    ];
    const cut = resumer(log, () => []);
    const settled = await settleScheduledRun(owned, opts(live(log), { onCut: cut.onCut, ...instant }));
    assert.deepEqual(settled, { status: "failed", stopped: true, cause: "person", error: "Stopped before it finished." });
    assert.equal(cut.asked.length, 0, source);
  }
  // An approval nobody answered stopped it: the person has to act, a retry would not help.
  const waited = feed([[
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "user", source: "agent-approval-timeout" }),
    ev(13, "turn/stopped", { reason: "aborted" }),
  ]]);
  const expired = await settleScheduledRun(run, opts(waited.events, { onCut: async () => true, ...instant }));
  assert.equal(expired.status, "failed");
  assert.equal(expired.cause, "approval");
  assert.equal(expired.stopped, undefined);
});

test("a turn cut under the agent is continued by the run itself, once caught up, and reports as one run", async () => {
  const log = [
    ev(11, "turn/started"),
    ev(12, "assistant/message", { text: "Dispatching the nightly." }),
    // No abort request: nobody asked for this stop.
    ev(13, "turn/stopped", { reason: "aborted" }),
  ];
  const cut = resumer(log, () => [
    ev(15, "user/message", { text: "Polyth: your turn was cut off" }),
    ev(16, "turn/started"),
    ev(17, "assistant/message", { text: "All platforms delivered.\n\nReport: update — nightly delivered" }),
    ev(18, "turn/stopped", { reason: "completed" }),
  ]);
  const settled = await settleScheduledRun(owned, opts(live(log), { onCut: cut.onCut, ...instant }));
  assert.equal(settled.status, "ok");
  assert.equal(settled.resumed, 1);
  assert.deepEqual(cut.asked, [{ attempt: 1, cause: "cut" }]);
  assert.match(settled.summary ?? "", /All platforms delivered/);
  assert.ok(settled.timeline?.some((moment) => moment.kind === "resume"), "the page can say it continued");
});

test("a continuation already in the log is never sent twice (a restart reads the same events again)", async () => {
  const log = [
    ev(11, "turn/started"),
    ev(12, "turn/stopped", { reason: "aborted" }),
    ev(13, "schedule/run-resumed", { runId: "r1", attempt: 1 }),
    ev(14, "user/message", { text: "Polyth: your turn was cut off" }),
    ev(15, "turn/started"),
    ev(16, "turn/stopped", { reason: "completed" }),
  ];
  const cut = resumer(log, () => []);
  const settled = await settleScheduledRun(owned, opts(live(log), { onCut: cut.onCut, ...instant }));
  assert.equal(settled.status, "ok");
  assert.equal(settled.resumed, 1);
  assert.equal(cut.asked.length, 0);
  // Another run's marker is not this run's continuation.
  const foreign = [
    ev(11, "turn/started"),
    ev(12, "turn/stopped", { reason: "aborted" }),
    ev(13, "schedule/run-resumed", { runId: "someone-else", attempt: 1 }),
  ];
  const other = resumer(foreign, () => [ev(15, "turn/started"), ev(16, "turn/stopped", { reason: "completed" })]);
  await settleScheduledRun(owned, opts(live(foreign), { onCut: other.onCut, ...instant }));
  assert.equal(other.asked.length, 1);
});

test("a run continues itself a bounded number of times, then ends as cut and says how often it tried", async () => {
  const log = [ev(11, "turn/started"), ev(12, "turn/stopped", { reason: "aborted" })];
  const cut = resumer(log, (attempt) => {
    const seq = 20 * attempt;
    return [ev(seq, "turn/started"), ev(seq + 1, "turn/stopped", { reason: "aborted" })];
  });
  const settled = await settleScheduledRun(owned, opts(live(log), { onCut: cut.onCut, ...instant }));
  assert.deepEqual(cut.asked.map((ask) => ask.attempt), [1, 2]);
  assert.equal(settled.status, "failed");
  assert.equal(settled.cause, "cut");
  assert.equal(settled.resumed, 2);
  assert.equal(settled.error, "Cut off before it finished.");
});

test("a transient turn error gets a continuation; an error no retry can fix ends the run with its cause", async () => {
  const log = [ev(11, "turn/started"), ev(12, "turn/stopped", { reason: "error", error: "socket hang up" })];
  const cut = resumer(log, () => [ev(14, "turn/started"), ev(15, "turn/stopped", { reason: "completed" })]);
  const settled = await settleScheduledRun(owned, opts(live(log), { onCut: cut.onCut, ...instant }));
  assert.equal(settled.status, "ok");
  assert.deepEqual(cut.asked, [{ attempt: 1, cause: "error" }]);

  for (const [code, cause] of [["auth-expired", "route"], ["model-unavailable", "route"], ["context-full", "error"]] as const) {
    const final = [ev(11, "turn/started"), ev(12, "turn/stopped", { reason: "error", code, error: `refused: ${code}` })];
    const never = resumer(final, () => []);
    const ended = await settleScheduledRun(owned, opts(live(final), { onCut: never.onCut, ...instant }));
    assert.deepEqual(ended, { status: "failed", cause, error: `refused: ${code}` });
    assert.equal(never.asked.length, 0, code);
  }
});

test("a continuation waits its delay, and a watchdog continuation that never comes is taken over by the run", async () => {
  let clock = 1_000;
  const log = [
    ev(11, "turn/started"),
    ev(12, "turn/abort-requested", { reason: "tool-timeout", source: "tool-watchdog" }),
    { ...ev(13, "turn/stopped", { reason: "aborted" }), time: 1_000 } as SessionEvent,
  ];
  const sentAt: number[] = [];
  const cut = resumer(log, () => [ev(15, "turn/started"), ev(16, "turn/stopped", { reason: "completed" })]);
  const settled = await settleScheduledRun({ ...owned, startedAt: 0 }, opts(live(log), {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    onCut: async (attempt: number, cause: string) => { sentAt.push(clock); return cut.onCut(attempt, cause); },
  }));
  assert.equal(settled.status, "ok");
  assert.equal(settled.resumed, 1);
  // The server had 15 minutes to continue the turn it cut; only then the run did.
  assert.ok(sentAt[0]! >= 15 * 60_000 && sentAt[0]! < 20 * 60_000, `sent at ${sentAt[0]}`);
});

test("a continuation that cannot be sent ends the run where it was cut", async () => {
  const source = feed([[ev(11, "turn/started"), ev(12, "turn/stopped", { reason: "aborted" })]]);
  const settled = await settleScheduledRun(owned, opts(source.events, {
    onCut: async () => { throw new Error("session gone"); }, ...instant,
  }));
  assert.deepEqual(settled, { status: "failed", cause: "cut", error: "Cut off before it finished." });
});
