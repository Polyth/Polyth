// The per-turn latency marks: a measurement exists only when every step was seen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LATENCY_KEEP, averageLatency, createLatencyTracker, parseLatencyList } from "../src/latency.ts";

function setup() {
  let now = 10_000;
  const saved: number[] = [];
  const tracker = createLatencyTracker({ now: () => now, onChange: (list) => { saved.push(list.length); } });
  return { tracker, saved, tick: (ms: number) => { now += ms; } };
}

test("a spoken turn is split into pause, recognition, sending, agent and voice", () => {
  const h = setup();
  h.tracker.endOfTurn(550);
  h.tick(120); h.tracker.transcript();
  h.tick(300); h.tracker.turnStarted();
  h.tick(200); h.tracker.sound();
  h.tick(900); h.tracker.firstText();
  h.tick(250);
  const entry = h.tracker.audible();
  assert.deepEqual(entry, {
    at: 11_770, pause: 550, recognition: 120, sending: 300, agent: 1_100, voice: 250, total: 2_320, firstSound: 1_170,
  });
  assert.deepEqual(h.tracker.recent(), [entry]);
  assert.deepEqual(h.saved, [1]);
  assert.equal(h.tracker.audible(), null, "one measurement per turn");
});

test("a turn with a missing or out-of-order step is not measured", () => {
  const h = setup();
  assert.equal(h.tracker.audible(), null, "nothing was said");
  h.tracker.endOfTurn(1_000);
  h.tracker.turnStarted();
  h.tracker.firstText();
  assert.equal(h.tracker.audible(), null, "a turn that started before the words were final is someone else's");

  h.tracker.endOfTurn(1_000);
  h.tracker.transcript();
  h.tracker.discard();
  h.tracker.turnStarted();
  h.tracker.firstText();
  assert.equal(h.tracker.audible(), null, "a queued or refused turn is discarded");

  h.tracker.endOfTurn(1_000);
  h.tracker.transcript();
  h.tick(130_000);
  h.tracker.turnStarted();
  h.tracker.firstText();
  assert.equal(h.tracker.audible(), null, "marks from a turn that never answered go stale");
  assert.deepEqual(h.tracker.recent(), []);
});

test("only recent turns are kept, and a stored list is read back defensively", () => {
  const h = setup();
  for (let index = 0; index < LATENCY_KEEP + 5; index++) {
    h.tracker.endOfTurn(400);
    h.tracker.transcript();
    h.tracker.turnStarted();
    h.tracker.firstText();
    h.tick(100 + index);
    h.tracker.audible();
  }
  assert.equal(h.tracker.recent().length, LATENCY_KEEP);
  const round = parseLatencyList(JSON.stringify(h.tracker.recent()));
  assert.deepEqual(round, h.tracker.recent());
  assert.deepEqual(parseLatencyList("nope"), []);
  assert.deepEqual(parseLatencyList(JSON.stringify([{ at: 1, pause: "x" }, null, 4])), []);
  assert.deepEqual(parseLatencyList(JSON.stringify({ at: 1 })), []);
  assert.equal(averageLatency([]), null);
  assert.deepEqual(averageLatency([
    { at: 1, pause: 400, recognition: 100, sending: 200, agent: 1_000, voice: 300, total: 2_000 },
    { at: 2, pause: 600, recognition: 300, sending: 400, agent: 2_000, voice: 100, total: 3_400 },
  ]), { pause: 500, recognition: 200, sending: 300, agent: 1_500, voice: 200, total: 2_700 });
});
