// Byte ranges on /api/files/raw: media players seek with them, and Safari
// will not play a video served without them.
import test from "node:test";
import assert from "node:assert/strict";
import { byteRange } from "../src/serverEntry.ts";

test("byteRange: closed, open-ended and suffix spans", () => {
  assert.deepEqual(byteRange("bytes=0-1", 10), { start: 0, end: 1 });
  assert.deepEqual(byteRange("bytes=4-", 10), { start: 4, end: 9 });
  assert.deepEqual(byteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange("bytes=-30", 10), { start: 0, end: 9 });
  // An end past the body is clamped, as the HTTP range rules require.
  assert.deepEqual(byteRange("bytes=8-99", 10), { start: 8, end: 9 });
});

test("byteRange: no header, other units and several ranges serve the whole body", () => {
  assert.equal(byteRange(undefined, 10), null);
  assert.equal(byteRange("", 10), null);
  assert.equal(byteRange("items=0-1", 10), null);
  assert.equal(byteRange("bytes=0-1,4-5", 10), null);
  assert.equal(byteRange("bytes=-", 10), null);
});

test("byteRange: spans outside the body are unsatisfiable", () => {
  assert.equal(byteRange("bytes=10-", 10), "unsatisfiable");
  assert.equal(byteRange("bytes=5-2", 10), "unsatisfiable");
  assert.equal(byteRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(byteRange("bytes=0-", 0), "unsatisfiable");
});
