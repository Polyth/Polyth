import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { createEventIngestionBatcher } from "../src/streamIngestion.ts";

test("1/4/8 sustained streams remain bounded when timers never fire", () => {
  for (const streams of [1, 4, 8]) {
    let outstanding = 0;
    let maximum = 0;
    let applied = 0;
    let peakBatch = 0;
    const batcher = createEventIngestionBatcher((events) => {
      applied += events.length;
      peakBatch = Math.max(peakBatch, events.length);
    }, {
      now: () => 0,
      setTimer: () => { outstanding++; maximum = Math.max(maximum, outstanding); return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => { outstanding--; },
    });
    for (let seq = 1; seq <= 10_000; seq++) for (let id = 0; id < streams; id++) batcher.pushLive({ ...event(seq), sessionId: `stream-${id}` });
    batcher.dispose();
    assert.equal(applied, 10_000 * streams);
    assert.ok(peakBatch <= 256);
    assert.ok(maximum <= 1);
    assert.equal(outstanding, 0);
  }
});

const event = (seq: number, type = "assistant/chunk", data: JsonObject = { partId: "p", text: "x" }): SessionEvent => ({
  id: `e-${seq}`,
  sessionId: "s",
  seq,
  time: seq,
  type,
  data,
  v: 1,
});

test("first stream chunk is immediate and sustained chunks publish once per cadence", () => {
  let clock = 0;
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const batches: number[][] = [];
  const batcher = createEventIngestionBatcher(
    (events) => batches.push(events.map((item) => item.seq)),
    {
      intervalMs: 100,
      now: () => clock,
      setTimer: (callback, delay) => {
        scheduled.push({ callback, delay });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => { scheduled.length = 0; },
    },
  );

  batcher.pushLive(event(1));
  assert.deepEqual(batches, [[1]]);

  clock = 20;
  batcher.pushLive(event(2));
  clock = 40;
  batcher.pushLive(event(3));
  assert.deepEqual(batches, [[1]]);
  const timer = scheduled.at(-1);
  assert.ok(timer, "the pending cadence timer is scheduled");
  assert.equal(timer.delay, 80);

  clock = 100;
  timer.callback();
  assert.deepEqual(batches, [[1], [2, 3]]);
});

test("control events are barriers and are never held behind streamed text", () => {
  let clock = 0;
  const scheduled: Array<() => void> = [];
  const batches: Array<{ seqs: number[]; keys: string[] }> = [];
  const batcher = createEventIngestionBatcher(
    (events, liveKeys) => batches.push({
      seqs: events.map((item) => item.seq),
      keys: [...liveKeys],
    }),
    {
      intervalMs: 100,
      now: () => clock,
      setTimer: (callback) => {
        scheduled.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => { scheduled.length = 0; },
    },
  );

  batcher.pushLive(event(1));
  clock = 10;
  batcher.pushLive(event(2));
  assert.equal(scheduled.length, 1);

  clock = 20;
  batcher.pushLive(event(3, "tool/call", { callId: "c", tool: "read", input: {} }));
  assert.equal(scheduled.length, 0);
  assert.deepEqual(batches.map((batch) => batch.seqs), [[1], [2, 3]]);
  assert.deepEqual(batches[1]!.keys, ["s:2", "s:3"]);
});

test("replay flushes pending live text first and never marks replay rows as live", () => {
  let clock = 0;
  const batches: Array<{ seqs: number[]; keys: string[] }> = [];
  const batcher = createEventIngestionBatcher(
    (events, liveKeys) => batches.push({ seqs: events.map((item) => item.seq), keys: [...liveKeys] }),
    {
      intervalMs: 100,
      now: () => clock,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    },
  );

  batcher.pushLive(event(1));
  clock = 10;
  batcher.pushLive(event(2));
  batcher.pushReplay([event(3, "user/message", { text: "history" })]);

  assert.deepEqual(batches, [
    { seqs: [1], keys: ["s:1"] },
    { seqs: [2], keys: ["s:2"] },
    { seqs: [3], keys: [] },
  ]);
});
