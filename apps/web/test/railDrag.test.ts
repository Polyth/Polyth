// Rail launcher drag: the preview/persist model shared by the top and right rails.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distanceToRect, finalOrder, followZone, insertionIndex, previewOrder, removalIntent,
  REMOVE_DISTANCE_PX, REMOVE_HYSTERESIS_PX, type RailDragState, type ZoneGeometry,
} from "../src/railDrag.ts";

const drag = (patch: Partial<RailDragState>): RailDragState =>
  ({ id: "b", from: "top", over: "top", index: 0, phase: "dragging", ...patch });

test("insertion index counts resting centres before the pointer", () => {
  assert.equal(insertionIndex([10, 40, 70], 0), 0);
  assert.equal(insertionIndex([10, 40, 70], 41), 2);
  assert.equal(insertionIndex([10, 40, 70], 99), 3);
  assert.equal(insertionIndex([], 50), 0);
});

test("reorder inside one rail moves the lifted icon itself", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(previewOrder(ids, "top", drag({ index: 3 })), ["a", "c", "d", "b"]);
  assert.deepEqual(finalOrder(ids, drag({ index: 0 })), ["b", "a", "c", "d"]);
  assert.deepEqual(previewOrder(ids, "right", drag({ index: 3 })), ids, "an uninvolved rail is untouched");
});

test("crossing rails collapses the source and opens a slot in the target", () => {
  const top = ["a", "b", "c"];
  const right = ["x", "y"];
  const state = drag({ over: "right", index: 1 });
  assert.deepEqual(previewOrder(top, "top", state), ["a", "c"]);
  assert.deepEqual(previewOrder(right, "right", state), ["x", null, "y"]);
  assert.deepEqual(finalOrder(right, state), ["x", "b", "y"]);
});

test("hovering nowhere keeps the icon's home so release puts it back", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(previewOrder(ids, "top", drag({ over: null, index: 2 })), ids);
});

test("a target that already shows the icon treats the drop as a move, not a copy", () => {
  // Terminal can appear in both rails; landing on the right must not duplicate it.
  const right = ["terminal", "x", "y"];
  const state = drag({ id: "terminal", from: "top", over: "right", index: 2 });
  assert.deepEqual(previewOrder(right, "right", state), ["x", "y", null]);
  assert.deepEqual(finalOrder(right, state), ["x", "y", "terminal"]);
});

test("out-of-range indices clamp to the rail ends", () => {
  assert.deepEqual(previewOrder(["a", "b"], "top", drag({ id: "z", from: "right", index: 9 })), ["a", "b", null]);
  assert.deepEqual(previewOrder(["a", "b"], "top", drag({ id: "z", from: "right", index: -3 })), [null, "a", "b"]);
});

test("a rail that jumps to the other edge mid-drag stays a drop target", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
  // The right rail moves from the right edge to the left edge (pane re-docked).
  const right: ZoneGeometry = { rect: rect(1067, 73, 29, 800), scroll: 0, centers: [87, 122], itemSize: 29 };
  const moved = followZone(right, rect(5, 73, 29, 800), "y");
  assert.equal(moved.rect.left, 5);
  assert.deepEqual(moved.centers, [87, 122], "same vertical slots");
  // A top rail that shifts down and right carries its slot centres along.
  const top: ZoneGeometry = { rect: rect(173, 12, 96, 32), scroll: 0, centers: [189, 221], itemSize: 28 };
  assert.deepEqual(followZone(top, rect(183, 20, 96, 32), "x").centers, [199, 231]);
  // Growing or re-centring along its own axis (a landing slot opened) is the
  // preview itself: the frozen geometry must not chase it.
  assert.equal(followZone(top, rect(157, 12, 128, 32), "x"), top);
});

test("pulled far enough to be removed, the icon's home closes over the gap", () => {
  const top = ["a", "b", "c"];
  const right = ["x", "y"];
  const leaving = drag({ over: null, index: 2, removing: true });
  assert.deepEqual(previewOrder(top, "top", leaving), ["a", "c"], "like the Dock, the neighbours close ranks");
  assert.deepEqual(previewOrder(right, "right", leaving), right, "no other rail holds a slot for it");
  // Not far enough yet: the hole stays so a release reads "put back".
  assert.deepEqual(previewOrder(top, "top", drag({ over: null, index: 2, removing: false })), top);
  // Back over a rail the verdict no longer matters: the slot returns.
  assert.deepEqual(previewOrder(top, "top", drag({ over: "top", index: 0, removing: false })), ["b", "a", "c"]);
});

test("the distance to a rail is the straight line to its nearest edge", () => {
  const rail = { left: 100, top: 50, right: 140, bottom: 250 };
  assert.equal(distanceToRect(rail, 120, 100), 0, "inside");
  assert.equal(distanceToRect(rail, 140, 250), 0, "on the corner");
  assert.equal(distanceToRect(rail, 190, 100), 50, "beside it");
  assert.equal(distanceToRect(rail, 120, 300), 50, "below it");
  assert.equal(distanceToRect(rail, 40, 50 - 80), 100, "past a corner: 60 across, 80 up");
});

test("a release is a removal only farther than the line, with a little give on the way back", () => {
  assert.equal(REMOVE_DISTANCE_PX, 50);
  assert.equal(removalIntent(REMOVE_DISTANCE_PX, false), false, "on the line is still near");
  assert.equal(removalIntent(REMOVE_DISTANCE_PX + 0.5, false), true);
  assert.equal(removalIntent(0, false), false);
  // Armed, the pointer has to come REMOVE_HYSTERESIS_PX back before it disarms.
  assert.equal(removalIntent(REMOVE_DISTANCE_PX - 1, true), true);
  assert.equal(removalIntent(REMOVE_DISTANCE_PX - REMOVE_HYSTERESIS_PX, true), false);
  assert.equal(removalIntent(REMOVE_DISTANCE_PX - 1, false), false, "unarmed: no give");
});
