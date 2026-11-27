import assert from "node:assert/strict";
import test from "node:test";

import {
  MARK_COLORS,
  activeCrop,
  arrowGeometry,
  blurCellFor,
  blurRects,
  drawMarks,
  extendPen,
  isMeaningful,
  strokeFor,
  viewportBlurs,
  type Mark,
  type MarkContext,
} from "../src/annotate.ts";

const red = MARK_COLORS[0];

test("a stray click is not a mark; a real drag is", () => {
  assert.equal(isMeaningful({ kind: "arrow", color: red, from: { x: 10, y: 10 }, to: { x: 11, y: 12 } }), false);
  assert.equal(isMeaningful({ kind: "arrow", color: red, from: { x: 10, y: 10 }, to: { x: 40, y: 10 } }), true);
  assert.equal(isMeaningful({ kind: "box", color: red, from: { x: 10, y: 10 }, to: { x: 80, y: 11 } }), false);
  assert.equal(isMeaningful({ kind: "box", color: red, from: { x: 10, y: 10 }, to: { x: 80, y: 60 } }), true);
  assert.equal(isMeaningful({ kind: "pen", color: red, points: [{ x: 5, y: 5 }] }), false);
  assert.equal(isMeaningful({ kind: "pen", color: red, points: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 30, y: 9 }] }), true);
  assert.equal(isMeaningful({ kind: "crop", from: { x: 0, y: 0 }, to: { x: 10, y: 200 } }), false);
});

test("the last crop wins, is clamped to the image and rounded; undoing it restores the one before", () => {
  const first: Mark = { kind: "crop", from: { x: 300, y: 200 }, to: { x: 100.4, y: 50.6 } };
  const second: Mark = { kind: "crop", from: { x: -40, y: 20 }, to: { x: 2000, y: 400 } };
  const arrow: Mark = { kind: "arrow", color: red, from: { x: 0, y: 0 }, to: { x: 50, y: 50 } };
  assert.equal(activeCrop([arrow], 800, 600), null);
  assert.deepEqual(activeCrop([first, arrow], 800, 600), { x: 100, y: 51, width: 200, height: 149 });
  assert.deepEqual(activeCrop([first, arrow, second], 800, 600), { x: 0, y: 20, width: 800, height: 380 });
  assert.deepEqual(activeCrop([first, arrow], 800, 600), activeCrop([first, arrow, second].slice(0, 2), 800, 600));
  // A crop squeezed by clamping to a sliver keeps the whole image.
  assert.equal(activeCrop([{ kind: "crop", from: { x: 790, y: 0 }, to: { x: 900, y: 600 } }], 800, 600), null);
});

test("the arrow head points at the target and the shaft stops inside it", () => {
  const { shaftEnd, head } = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
  assert.deepEqual(head[0], { x: 100, y: 0 });
  assert.ok(shaftEnd.x < 100 && shaftEnd.x > head[1].x, "shaft ends between the head's base and its tip");
  assert.equal(head[1].x, head[2].x);
  assert.equal(head[1].y, -head[2].y);
  // A short arrow gets a head that leaves some shaft.
  const short = arrowGeometry({ x: 0, y: 0 }, { x: 10, y: 0 }, 6);
  assert.ok(short.head[1].x >= 4);
});

test("stroke width scales with the image and is never a hairline", () => {
  assert.equal(strokeFor(300, 200), 3);
  assert.equal(strokeFor(1280, 720), 5);
  assert.equal(strokeFor(1600, 900), 7);
});

test("pen points closer than a pixel are dropped", () => {
  const points = extendPen([{ x: 1, y: 1 }], { x: 1.4, y: 1.3 });
  assert.equal(points.length, 1);
  assert.equal(extendPen(points, { x: 4, y: 4 }).length, 2);
});

test("marks draw in screenshot coordinates and crops draw nothing", () => {
  const calls: string[] = [];
  const context = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => key in target ? target[key] : (...args: number[]) => { calls.push(`${key}(${args.join(",")})`); },
    set: (target, key: string, value) => { target[key] = value; return true; },
  }) as unknown as MarkContext;
  drawMarks(context, [
    { kind: "crop", from: { x: 0, y: 0 }, to: { x: 50, y: 50 } },
    { kind: "box", color: red, from: { x: 30, y: 40 }, to: { x: 10, y: 20 } },
    { kind: "pen", color: MARK_COLORS[5], points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
  ], 5);
  assert.deepEqual(calls, [
    "save()", "beginPath()", "rect(10,20,20,20)", "stroke()", "restore()",
    "save()", "beginPath()", "moveTo(1,2)", "lineTo(3,4)", "stroke()", "restore()",
  ]);
  assert.equal(context.lineWidth, 5);
});

test("blurred areas are clamped and rounded outward; crops, boxes and empty blurs are not blurs", () => {
  const marks: Mark[] = [
    { kind: "blur", from: { x: 10.6, y: 20.4 }, to: { x: -5, y: 30.2 } },
    { kind: "blur", from: { x: 90, y: 40 }, to: { x: 150, y: 70 } },
    { kind: "blur", from: { x: 200, y: 10 }, to: { x: 220, y: 20 } },
    { kind: "box", color: red, from: { x: 0, y: 0 }, to: { x: 50, y: 50 } },
    { kind: "crop", from: { x: 0, y: 0 }, to: { x: 50, y: 50 } },
  ];
  assert.deepEqual(blurRects(marks, 100, 50), [
    { x: 0, y: 20, width: 11, height: 11 },
    { x: 90, y: 40, width: 10, height: 10 },
  ]);
  assert.ok(blurCellFor(400, 300) >= 12);
  assert.equal(blurCellFor(2560, 1600), 40);
});

test("private areas map onto a retina capture of this viewport, and onto nothing else", () => {
  const areas = [{ x: 10, y: 20, width: 100, height: 30 }];
  assert.deepEqual(viewportBlurs(areas, { width: 800, height: 600 }, { width: 1600, height: 1200 }), [
    { kind: "blur", from: { x: 20, y: 40 }, to: { x: 220, y: 100 } },
  ]);
  // A capture of another shape (a whole screen, a window with its frame) is
  // not this viewport: nothing is blurred in the wrong place.
  assert.equal(viewportBlurs(areas, { width: 800, height: 600 }, { width: 1600, height: 900 }), null);
  assert.equal(viewportBlurs(areas, { width: 0, height: 600 }, { width: 1600, height: 1200 }), null);
});
