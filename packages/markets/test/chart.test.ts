import assert from "node:assert/strict";
import test from "node:test";
import { buildCloseLine } from "../widgets/chart.ts";

test("buildCloseLine normalizes finite close values into a stable path", () => {
  const line = buildCloseLine([
    { time: 1, open: 10, high: 11, low: 9, close: 10 },
    { time: 2, open: 10, high: 13, low: 10, close: 12 },
    { time: 3, open: 12, high: 13, low: 11, close: 11 },
  ], 100, 50, 5);
  assert.ok(line);
  assert.equal(line.minimum, 10);
  assert.equal(line.maximum, 12);
  assert.equal(line.first, 10);
  assert.equal(line.last, 11);
  assert.match(line.path, /^M5\.00,/);
  assert.match(line.path, /L95\.00,/);
});

test("buildCloseLine handles flat series without division by zero", () => {
  const line = buildCloseLine([
    { time: 1, open: 10, high: 10, low: 10, close: 10 },
    { time: 2, open: 10, high: 10, low: 10, close: 10 },
  ]);
  assert.ok(line);
  assert.equal(line.minimum, 10);
  assert.equal(line.maximum, 10);
  assert.doesNotMatch(line.path, /NaN|Infinity/);
});


test("buildCloseLine skips empty and single-point data", () => {
  assert.equal(buildCloseLine([]), null);
  assert.equal(buildCloseLine([{ time: 1, open: 1, high: 1, low: 1, close: 1 }]), null);
});
