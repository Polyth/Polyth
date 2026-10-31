import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@polyth/contracts";
import { appendEventSegments, prependEventSegments, eventSegmentDepth } from "../src/eventSegments.ts";
import { buildModel, createModelCache } from "../src/reduce.ts";

const event = (seq: number): SessionEvent => ({ id: `e${seq}`, sessionId: "s", seq, time: seq, type: "assistant/chunk", data: { partId: "a", text: String(seq % 10) }, v: 1 });

test("170k immutable events append without copying the old array; all array readers preserve order", () => {
  let events: SessionEvent[] = [];
  for (let start = 1; start <= 170_000; start += 100) {
    const previous = events;
    events = appendEventSegments(events, Array.from({ length: 100 }, (_, i) => event(start + i)));
    assert.equal(previous.length, start - 1);
    if (previous.length) assert.equal(events[previous.length - 1], previous.at(-1));
  }
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 170_000);
  assert.ok(eventSegmentDepth(events) <= 20);
  assert.deepEqual(events.slice(-3).map((e) => e.seq), [169_998, 169_999, 170_000]);
  assert.equal(events.find((e) => e.seq === 169_999)?.seq, 169_999);
  assert.equal([...events].length, 170_000);
  assert.throws(() => events.push(event(170_001)), /immutable/);
});

test("prepend, serialization and incremental reduction match plain reference replay", () => {
  const all = Array.from({ length: 400 }, (_, i) => event(i + 1));
  let segmented = appendEventSegments([], all.slice(100, 200));
  const cache = createModelCache();
  cache.get("s", segmented);
  segmented = appendEventSegments(segmented, all.slice(200));
  assert.deepEqual(cache.get("s", segmented), buildModel(all.slice(100)));
  segmented = prependEventSegments(segmented, all.slice(0, 100));
  assert.equal(JSON.stringify(segmented), JSON.stringify(all));
  assert.deepEqual(segmented, all);
  assert.deepEqual(cache.get("s", segmented), buildModel(all));
});
