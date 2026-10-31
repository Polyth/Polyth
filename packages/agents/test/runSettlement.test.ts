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
