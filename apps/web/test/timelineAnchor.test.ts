// UX-A390 repair: per-session timeline scroll anchor store — parse rules,
// round-trip, and the LRU cap. DOM-free (localStorage shimmed).
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  MAX_TIMELINE_ANCHORS, TIMELINE_ANCHORS_KEY,
  loadTimelineAnchor, parseTimelineAnchors, saveTimelineAnchor,
} = await import("../src/timelineAnchor.ts");

test("parseTimelineAnchors survives garbage and drops malformed entries", () => {
  assert.deepEqual(parseTimelineAnchors(null), {});
  assert.deepEqual(parseTimelineAnchors("not json"), {});
  assert.deepEqual(parseTimelineAnchors("[1,2]"), {});
  const parsed = parseTimelineAnchors(JSON.stringify({
    good: { atBottom: false, scrollTop: 120.6 },
    following: { atBottom: true, scrollTop: 0 },
    negative: { atBottom: false, scrollTop: -4 },
    wrongTypes: { atBottom: "no", scrollTop: "120" },
    infinite: { atBottom: false, scrollTop: Number.POSITIVE_INFINITY },
    empty: null,
  }));
  assert.deepEqual(parsed, {
    good: { atBottom: false, scrollTop: 121 }, // offsets round to whole pixels
    following: { atBottom: true, scrollTop: 0 },
  });
});

test("save/load round-trips, including the exact scrollTop=0 top anchor", () => {
  mem.clear();
  saveTimelineAnchor("s1", { atBottom: false, scrollTop: 0 });
  assert.deepEqual(loadTimelineAnchor("s1"), { atBottom: false, scrollTop: 0 });
  saveTimelineAnchor("s1", { atBottom: false, scrollTop: 987.4 });
  assert.deepEqual(loadTimelineAnchor("s1"), { atBottom: false, scrollTop: 987 });
  saveTimelineAnchor("s1", { atBottom: true, scrollTop: 2414 });
  assert.deepEqual(loadTimelineAnchor("s1"), { atBottom: true, scrollTop: 2414 });
  assert.equal(loadTimelineAnchor("unknown"), null);
});

test("the anchor map is LRU-capped and re-saving refreshes recency", () => {
  mem.clear();
  for (let i = 0; i < MAX_TIMELINE_ANCHORS; i++) {
    saveTimelineAnchor(`s${i}`, { atBottom: false, scrollTop: i });
  }
  // Refresh the oldest, then push one past the cap: the refreshed entry
  // survives and the now-oldest (s1) is evicted.
  saveTimelineAnchor("s0", { atBottom: false, scrollTop: 999 });
  saveTimelineAnchor("overflow", { atBottom: true, scrollTop: 0 });
  const all = parseTimelineAnchors(mem.get(TIMELINE_ANCHORS_KEY) ?? null);
  assert.equal(Object.keys(all).length, MAX_TIMELINE_ANCHORS);
  assert.deepEqual(all.s0, { atBottom: false, scrollTop: 999 });
  assert.deepEqual(all.overflow, { atBottom: true, scrollTop: 0 });
  assert.equal(all.s1, undefined);
});
