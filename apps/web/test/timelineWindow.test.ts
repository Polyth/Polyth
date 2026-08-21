// L13 timeline windowing: the rendered window is always a suffix, growing it
// is monotonic and capped at "everything", and a jump to a hidden row grows
// the limit exactly far enough. Pure math — the render model never changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { grownLimit, hiddenCount, limitToInclude, windowStart, TIMELINE_CHUNK, TIMELINE_WINDOW } from "../src/timelineWindow.ts";

// The integration assertion below exercises timelineAnchor.ts against window
// growth; its usable-edge helpers read computed styles.
(globalThis as { getComputedStyle?: unknown }).getComputedStyle =
  (el: { __position?: string }) => ({ position: el.__position ?? "static" });
const { captureTimelineAnchor, restoreScrollDelta } = await import("../src/timelineAnchor.ts");

test("windowStart/hiddenCount: suffix window, nothing hidden for short sessions", () => {
  assert.equal(windowStart(10, TIMELINE_WINDOW), 0);
  assert.equal(hiddenCount(10, TIMELINE_WINDOW), 0);
  assert.equal(windowStart(500, 150), 350);
  assert.equal(hiddenCount(500, 150), 350);
  // degenerate limits stay safe
  assert.equal(windowStart(500, 0), 500);
  assert.equal(windowStart(500, -5), 500);
  assert.equal(windowStart(0, 150), 0);
});

test("grownLimit grows by a chunk and caps at everything", () => {
  assert.equal(grownLimit(500, 150), 150 + TIMELINE_CHUNK);
  assert.equal(grownLimit(160, 150), 160);
  assert.equal(grownLimit(150, 150), 150);
  assert.equal(grownLimit(500, 150, 25), 175);
});

test("limitToInclude: visible rows keep the limit, hidden rows grow it exactly", () => {
  // 500 rows, limit 150 → rows 350..499 visible
  assert.equal(limitToInclude(500, 150, 400), 150);
  assert.equal(limitToInclude(500, 150, 350), 150);
  // row 349 is the first hidden one: limit must become 151
  assert.equal(limitToInclude(500, 150, 349), 151);
  // the very first row needs everything
  assert.equal(limitToInclude(500, 150, 0), 500);
  // out-of-range indexes change nothing (unknown prompt id)
  assert.equal(limitToInclude(500, 150, -1), 150);
  assert.equal(limitToInclude(500, 150, 500), 150);
});

// ---- UX-TIMELINE-LAYOUT-01 integration: growth keeps the reader's anchor ------
//
// Simulates exactly what Timeline.tsx does on `Show earlier`: the suffix
// window grows, rows are PREPENDED above the reader, and the scroll root is
// compensated by the scrollHeight delta. The anchored row must keep its
// usable-edge offset (captured anchor unchanged, restore delta 0) and the new
// window must contain every previously visible row exactly once.
test("window growth preserves the anchored row's usable-edge offset and duplicates nothing", () => {
  const ROWS = 500;
  const ROW_H = 100;
  const ids = Array.from({ length: ROWS }, (_, i) => `m${i}`);

  // A fake scroll root rendering the suffix ids[start..] at ROW_H each, with
  // the viewport scrolled `scrollTop` px into that content.
  const renderWindow = (limit: number, scrollTop: number) => {
    const start = windowStart(ROWS, limit);
    const shown = ids.slice(start);
    const rows = shown.map((id, i) => {
      const top = i * ROW_H - scrollTop;
      return {
        dataset: { msgId: id },
        getBoundingClientRect: () => ({ top, bottom: top + ROW_H, left: 0, right: 700, width: 700, height: ROW_H }),
      };
    });
    const el = {
      getBoundingClientRect: () => ({ top: 0, bottom: 600, left: 0, right: 700, width: 700, height: 600 }),
      children: [],
      querySelectorAll: (sel: string) => (sel === "[data-msg-id]" ? rows : []),
    } as unknown as HTMLElement;
    return { el, shown, rows, start };
  };

  // Reader is 40px into the row ids[360] with limit 150 (window starts at 350).
  const limit = TIMELINE_WINDOW;
  assert.equal(limit, 150);
  const scrollTop = 10 * ROW_H + 40;
  const before = renderWindow(limit, scrollTop);
  const anchor = captureTimelineAnchor(before.el, false);
  assert.deepEqual(anchor, { id: "m360", offset: -40, atBottom: false });

  // Grow one chunk. Timeline.tsx compensates scrollTop by the height that the
  // revealed rows prepended above the reader.
  const grown = grownLimit(ROWS, limit);
  const prepended = (windowStart(ROWS, limit) - windowStart(ROWS, grown)) * ROW_H;
  const after = renderWindow(grown, scrollTop + prepended);

  // Monotonic suffix growth: no duplicate row, previous window intact in order.
  assert.equal(new Set(after.shown).size, after.shown.length, "duplicate row after growth");
  assert.deepEqual(after.shown.slice(-before.shown.length), before.shown, "growth disturbed the visible suffix");

  // The reader's anchor is bit-identical and needs no corrective scroll.
  assert.deepEqual(captureTimelineAnchor(after.el, false), anchor);
  const anchoredRow = after.rows.find((r) => r.dataset.msgId === "m360")! as unknown as Element;
  assert.equal(restoreScrollDelta(after.el, anchoredRow, anchor), 0);

  // Growing to everything preserves the same invariant.
  const all = renderWindow(ROWS, scrollTop + (windowStart(ROWS, limit) - 0) * ROW_H);
  assert.equal(all.start, 0);
  assert.deepEqual(captureTimelineAnchor(all.el, false), anchor);
});
