// The phone Workspace reorder model (workspaceArrange.ts), pure parts: where a
// held item lands in a grid that mixes tiles (four to a line) and full-width
// rows, the stickiness that keeps a resting finger from flickering the hole,
// the edge auto-scroll curve, and the key map.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ARRANGE_HYSTERESIS_PX,
  arrangeAutoScrollSpeed,
  arrangeInsertionIndex,
  arrangeKeyTarget,
  arrangePreviewOrder,
  type ArrangeRect,
  type ArrangeShape,
} from "../src/workspaceArrange.ts";

const TILE = { width: 80, height: 90 };
const ROW_HEIGHT = 60;
const GAP = 10;
const WIDTH = 4 * TILE.width + 3 * GAP;

/** Lay `shapes` out the way the editor grid does: tiles flow four to a line, a row fills its own line. */
function layout(shapes: readonly ArrangeShape[], rtl = false): ArrangeRect[] {
  const rects: ArrangeRect[] = [];
  let top = 0;
  let column = 0;
  let lineHeight = 0;
  shapes.forEach((shape, index) => {
    if (shape === "row" || column === 4) {
      if (column > 0) top += lineHeight + GAP;
      column = 0;
      lineHeight = 0;
    }
    if (shape === "row") {
      rects.push({ id: `i${index}`, shape, left: 0, top, width: WIDTH, height: ROW_HEIGHT });
      top += ROW_HEIGHT + GAP;
      return;
    }
    const left = column * (TILE.width + GAP);
    rects.push({ id: `i${index}`, shape, left: rtl ? WIDTH - left - TILE.width : left, top, width: TILE.width, height: TILE.height });
    lineHeight = TILE.height;
    column += 1;
  });
  return rects;
}

const centre = (rect: ArrangeRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

test("the preview order moves only the held item", () => {
  assert.deepEqual(arrangePreviewOrder(["a", "b", "c", "d"], "a", 2), ["b", "c", "a", "d"]);
  assert.deepEqual(arrangePreviewOrder(["a", "b", "c", "d"], "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(arrangePreviewOrder(["a", "b"], "b", 99), ["a", "b"], "indices clamp");
  assert.deepEqual(arrangePreviewOrder(["a", "b"], "x", 0), ["a", "b"], "an unknown item changes nothing");
});

test("tiles: a tile passes a neighbour once its centre is past that neighbour's middle", () => {
  // The others of a full line of five tiles with the first one lifted.
  const others = layout(["tile", "tile", "tile", "tile", "tile"]).slice(1);
  // Its own slot: nothing passed yet.
  assert.equal(arrangeInsertionIndex(others, { x: 40, y: 45 }, { current: 0 }), 0);
  // Just past the second tile's middle (x 135): one passed.
  assert.equal(arrangeInsertionIndex(others, { x: 136, y: 45 }, { current: 0 }), 1);
  // Right of the last tile of the line: all three passed.
  assert.equal(arrangeInsertionIndex(others, { x: 340, y: 45 }, { current: 0 }), 3);
  // Down on the next line, left of its only tile: the whole first line passed.
  assert.equal(arrangeInsertionIndex(others, { x: 10, y: 150 }, { current: 0 }), 3);
  assert.equal(arrangeInsertionIndex(others, { x: 60, y: 150 }, { current: 0 }), 4);
});

test("rows: a row passes another below its middle, and splits a line of tiles where it is held", () => {
  const shapes: ArrangeShape[] = ["tile", "tile", "tile", "tile", "tile", "tile", "row", "row"];
  const rects = layout(shapes);
  // Lift the last row; the others keep their boxes.
  const others = rects.slice(0, -1);
  const lastRow = others.at(-1)!;
  assert.equal(arrangeInsertionIndex(others, { x: 200, y: lastRow.top + 40 }, { current: 7 }), 7, "below the other row's middle");
  assert.equal(arrangeInsertionIndex(others, { x: 200, y: lastRow.top + 10 }, { current: 7 }), 6, "above it, clearly");
  // Held over the second line of tiles, between its two tiles: after the first.
  const secondLine = others[4]!;
  assert.equal(arrangeInsertionIndex(others, { x: secondLine.left + secondLine.width + 5, y: secondLine.top + 20 }, { current: 7 }), 5);
  // Above everything: first. Below everything: last.
  assert.equal(arrangeInsertionIndex(others, { x: 200, y: -20 }, { current: 7 }), 0);
  assert.equal(arrangeInsertionIndex(others, { x: 200, y: 2000 }, { current: 7 }), 7);
});

test("stickiness: a point resting on a midpoint never flickers the hole", () => {
  const others = layout(["tile", "tile", "tile", "tile"]).slice(1);
  const middle = centre(others[0]!);
  // Coming from before it, the neighbour still counts as after a few pixels past its middle…
  assert.equal(arrangeInsertionIndex(others, { x: middle.x + ARRANGE_HYSTERESIS_PX - 1, y: middle.y }, { current: 0, margin: ARRANGE_HYSTERESIS_PX }), 0);
  assert.equal(arrangeInsertionIndex(others, { x: middle.x + ARRANGE_HYSTERESIS_PX + 1, y: middle.y }, { current: 0, margin: ARRANGE_HYSTERESIS_PX }), 1);
  // …and once passed, it stays passed a few pixels back the other way.
  assert.equal(arrangeInsertionIndex(others, { x: middle.x - ARRANGE_HYSTERESIS_PX + 1, y: middle.y }, { current: 1, margin: ARRANGE_HYSTERESIS_PX }), 1);
  assert.equal(arrangeInsertionIndex(others, { x: middle.x - ARRANGE_HYSTERESIS_PX - 1, y: middle.y }, { current: 1, margin: ARRANGE_HYSTERESIS_PX }), 0);
});

test("stickiness never oscillates: after the hole moves, the same point keeps the same answer", () => {
  // Simulate a full drag of the first of seven tiles across the grid and back,
  // re-laying out the preview after every move as the editor does.
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const held = "a";
  let index = 0;
  const others = (at: number) => {
    const order = arrangePreviewOrder(ids, held, at);
    const rects = layout(order.map(() => "tile"));
    return rects.map((rect, position) => ({ ...rect, id: order[position]! })).filter((rect) => rect.id !== held);
  };
  const path = [...Array(60).keys()].map((step) => ({ x: 20 + (step % 30) * 11, y: step < 30 ? 45 : 145 }));
  for (const point of [...path, ...path.reverse()]) {
    const next = arrangeInsertionIndex(others(index), point, { current: index, margin: ARRANGE_HYSTERESIS_PX });
    if (next !== index) {
      // Re-aim immediately against the new layout: a stable answer does not move again.
      const again = arrangeInsertionIndex(others(next), point, { current: next, margin: ARRANGE_HYSTERESIS_PX });
      assert.equal(again, next, `stable at ${point.x},${point.y}`);
      index = next;
    }
  }
});

test("right-to-left grids pass tiles toward the left", () => {
  const others = layout(["tile", "tile", "tile", "tile"], true).slice(1);
  const second = centre(others[0]!);
  assert.equal(arrangeInsertionIndex(others, { x: second.x - 1, y: second.y }, { rtl: true }), 1);
  assert.equal(arrangeInsertionIndex(others, { x: second.x + 1, y: second.y }, { rtl: true }), 0);
});

test("auto-scroll eases in near an edge, runs at full speed past it, and rests in between", () => {
  assert.equal(arrangeAutoScrollSpeed(400, 100, 800), 0);
  const creeping = arrangeAutoScrollSpeed(780, 100, 800);
  const running = arrangeAutoScrollSpeed(799, 100, 800);
  assert.ok(creeping > 0 && creeping < running, `${creeping} < ${running}`);
  assert.equal(arrangeAutoScrollSpeed(900, 100, 800), 18, "past the bottom edge (over the dock) it runs at full speed");
  assert.ok(arrangeAutoScrollSpeed(120, 100, 800) < 0, "near the top it scrolls up");
  assert.equal(arrangeAutoScrollSpeed(0, 100, 800), -18);
  assert.equal(arrangeAutoScrollSpeed(95, 100, 140), -18, "a tiny scroller still has a band");
  assert.equal(arrangeAutoScrollSpeed(120, 100, 140), 0);
});

test("arrow keys move an item one place, Home/End to the ends, mirrored right to left", () => {
  assert.equal(arrangeKeyTarget("ArrowUp", 2, 5), 1);
  assert.equal(arrangeKeyTarget("ArrowRight", 2, 5), 3);
  assert.equal(arrangeKeyTarget("ArrowRight", 2, 5, true), 1);
  assert.equal(arrangeKeyTarget("ArrowLeft", 2, 5, true), 3);
  assert.equal(arrangeKeyTarget("ArrowDown", 4, 5), 4);
  assert.equal(arrangeKeyTarget("Home", 3, 5), 0);
  assert.equal(arrangeKeyTarget("End", 1, 5), 4);
  assert.equal(arrangeKeyTarget("Enter", 1, 5), null);
});
