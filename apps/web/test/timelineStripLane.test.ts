// The transcript's scrollbar stops a column gap before the idle launcher strip
// that floats over the workspace edge, instead of sitting under it at the
// window edge; the reading column keeps its place.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { timelineStripLane } from "../src/timelineStripLane.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the lane is how far the idle strip reaches into the scrollbar side, plus the column gap", () => {
  // The default Windows window, 1600 px: the transcript spans 348–1600, the
  // floating strip 1552–1592 (8 px inset), the shell's column gap 8.
  const timeline = { left: 348, right: 1600, top: 68, bottom: 644 };
  const strip = { left: 1552, right: 1592, top: 68, bottom: 892 };
  assert.equal(timelineStripLane(timeline, [strip], 8, false), 56);
  // RTL: the scrollbar and the strip both sit at the left (inline end).
  const rtl = { left: 0, right: 1252, top: 68, bottom: 644 };
  assert.equal(timelineStripLane(rtl, [{ left: 8, right: 48, top: 68, bottom: 892 }], 8, true), 56);
  // A mirrored LTR shell floats the strip at the start: the scrollbar side is free.
  assert.equal(timelineStripLane(rtl, [{ left: 8, right: 48, top: 68, bottom: 892 }], 8, false), 0);
  // A chat in a split pane that ends before the strip, a strip beside the
  // transcript but not over its rows, and no strip at all: no lane.
  assert.equal(timelineStripLane({ ...timeline, right: 1000 }, [strip], 8, false), 0);
  assert.equal(timelineStripLane(timeline, [{ ...strip, top: 700, bottom: 892 }], 8, false), 0);
  assert.equal(timelineStripLane(timeline, [], 8, false), 0);
  // The tablet band's short cluster still covers the top of the scrollbar track.
  assert.equal(timelineStripLane(timeline, [{ left: 1538, right: 1588, top: 12, bottom: 300 }], 8, false), 70);
});

test("the lane is a transparent inline-end border, given back by the inline-end padding", async () => {
  const [styles, timeline] = await Promise.all([
    read("../src/styles.css"),
    read("../src/components/Timeline.tsx"),
  ]);
  // Non-inherited, so publishing it never restyles the transcript's rows.
  assert.match(styles, /@property --timeline-strip-lane \{\s*syntax: "<length>";\s*inherits: false;\s*initial-value: 0px;\s*\}/);
  assert.match(styles, /\.timeline \{[^}]*border-inline-end: var\(--timeline-strip-lane\) solid transparent;/s);
  // The conversation frame and the tablet band's strip clearance both give
  // the lane back, so the text does not move.
  assert.match(styles, /\.timeline \{\s*padding-inline-end: max\(0px, calc\(var\(--conversation-frame-inline-end\) - var\(--timeline-strip-lane\)\)\);\s*\}/);
  assert.match(styles, /\.timeline-viewport > \.timeline \{\s*padding-inline-end: max\(0px, calc\([^;]*- var\(--timeline-strip-lane\)\s*\)\);/s);
  assert.match(timeline, /useTimelineStripLane\(ref\);/);
});
