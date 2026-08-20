// WP12 pace helpers: reset boundaries, sparse samples, counter decrease,
// unknown period, clock skew, zero slope, projected overflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuotaWindow } from "@polyth/contracts";
import { computePace, usableSamples } from "@polyth/usage";

const HOUR = 60 * 60_000;
const NOW = 1_800_000_000_000;

const win = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: "w", label: "W", used: 50, limit: 100, unit: "requests",
  resetsAt: NOW + HOUR, periodMs: 2 * HOUR, // half the window elapsed at NOW
  ...over,
});

test("unknown period or zero limit → no pace at all", () => {
  assert.equal(computePace(win({ resetsAt: undefined as unknown as number }), [], { now: NOW }), null);
  assert.equal(computePace(win({ periodMs: undefined as unknown as number }), [], { now: NOW }), null);
  assert.equal(computePace(win({ limit: 0 }), [], { now: NOW }), null);
});

test("pace classification from fractions without prediction (sparse samples)", () => {
  // one sample only: pace shows, prediction hidden
  const p = computePace(win({ used: 50 }), [{ at: NOW, used: 50 }], { now: NOW })!;
  assert.equal(p.usageFraction, 0.5);
  assert.equal(p.timeFraction, 0.5);
  assert.equal(p.pace, "on-track");
  assert.equal(p.predictedAtReset, undefined);
  assert.equal(p.exhaustsAt, undefined);

  const over = computePace(win({ used: 90 }), [], { now: NOW })!;
  assert.equal(over.pace, "over");
  const under = computePace(win({ used: 10 }), [], { now: NOW })!;
  assert.equal(under.pace, "under");
});

test("prediction requires a minimum observation span", () => {
  const short = computePace(win(), [
    { at: NOW - 60_000, used: 40 }, { at: NOW, used: 50 },
  ], { now: NOW, minObservationMs: 5 * 60_000 })!;
  assert.equal(short.predictedAtReset, undefined);

  const enough = computePace(win(), [
    { at: NOW - 30 * 60_000, used: 20 }, { at: NOW, used: 50 },
  ], { now: NOW, minObservationMs: 5 * 60_000 })!;
  // slope = 1/min → +60 over the remaining hour
  assert.equal(Math.round(enough.predictedAtReset!), 110);
  // exhausts before reset: 50 remaining at 1/min = 50 min from NOW
  assert.equal(Math.round((enough.exhaustsAt! - NOW) / 60_000), 50);
});

test("counter decrease (reset) clamps: only post-reset samples count", () => {
  const samples = [
    { at: NOW - 3 * HOUR, used: 900 },
    { at: NOW - 40 * 60_000, used: 5 },   // counter reset happened
    { at: NOW, used: 25 },
  ];
  assert.deepEqual(usableSamples(samples).map((s) => s.used), [5, 25]);
  const p = computePace(win({ used: 25 }), samples, { now: NOW, minObservationMs: 10 * 60_000 })!;
  // slope from post-reset points = 0.5/min → +30 over remaining hour
  assert.equal(Math.round(p.predictedAtReset!), 55);
});

test("zero slope → prediction equals current usage, no exhaustion", () => {
  const p = computePace(win(), [
    { at: NOW - HOUR, used: 50 }, { at: NOW, used: 50 },
  ], { now: NOW })!;
  assert.equal(p.predictedAtReset, 50);
  assert.equal(p.exhaustsAt, undefined);
});

test("clock skew: now behind the newest sample is clamped", () => {
  const p = computePace(win(), [{ at: NOW + 10_000, used: 50 }], { now: NOW - HOUR })!;
  assert.ok(p.timeFraction >= 0.5); // used the sample time, not the skewed clock
});

test("reset boundary: resetsAt in the past pins timeFraction at 1", () => {
  const p = computePace(win({ resetsAt: NOW - 1000 }), [], { now: NOW })!;
  assert.equal(p.timeFraction, 1);
  assert.equal(p.pace, "under"); // 0.5 usage over a finished window
});

test("projected overflow beyond the limit is reported, exhaustion capped to the window", () => {
  const p = computePace(win({ used: 95 }), [
    { at: NOW - 30 * 60_000, used: 35 }, { at: NOW, used: 95 },
  ], { now: NOW })!;
  assert.ok(p.predictedAtReset! > 100);
  assert.ok(p.exhaustsAt! > NOW && p.exhaustsAt! < NOW + HOUR);

  // slope that would exhaust *after* the reset → no exhaustsAt
  const slow = computePace(win({ used: 55 }), [
    { at: NOW - 60 * 60_000, used: 50 }, { at: NOW, used: 55 },
  ], { now: NOW })!;
  assert.equal(slow.exhaustsAt, undefined);
});
