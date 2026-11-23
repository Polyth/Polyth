import assert from "node:assert/strict";
import test from "node:test";
import { anchorAt, clampPosition, DEFAULT_ANCHOR, parseAnchor, placeCard, SNAP_PX, type Insets, type Rect } from "../src/placement.ts";
import { DEFAULT_SETTINGS, parseSettings, sameSettings } from "../src/settings.ts";

test("settings fall back to defaults and clamp every number", () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings([1, 2]), DEFAULT_SETTINGS);
  const parsed = parseSettings({
    focusMin: 0,
    shortMin: 9999,
    longMin: 12.6,
    rounds: Number.NaN,
    volume: 3,
    repeat: -1,
    soundId: "airhorn",
    sound: "yes",
    flash: false,
  });
  assert.equal(parsed.focusMin, 1);
  assert.equal(parsed.shortMin, 60);
  assert.equal(parsed.longMin, 13);
  assert.equal(parsed.rounds, DEFAULT_SETTINGS.rounds);
  assert.equal(parsed.volume, 1);
  assert.equal(parsed.repeat, 1);
  assert.equal(parsed.soundId, "chime");
  assert.equal(parsed.sound, DEFAULT_SETTINGS.sound);
  assert.equal(parsed.flash, false);
  assert.ok(sameSettings(parseSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS));
  assert.ok(!sameSettings(parsed, DEFAULT_SETTINGS));
});

const frame: Rect = { left: 300, top: 50, width: 900, height: 700 };
const card = { width: 272, height: 380 };
const insets: Insets = { start: 12, top: 12, end: 12, bottom: 12 };

test("the default place is the chat column's top end corner", () => {
  assert.deepEqual(parseAnchor(undefined), DEFAULT_ANCHOR);
  const at = placeCard(frame, card, DEFAULT_ANCHOR, insets);
  assert.equal(at.left, 300 + 900 - 12 - 272);
  assert.equal(at.top, 50 + 12);
  // Mirrored for a right-to-left chat: the end corner is on the left.
  const rtl = placeCard(frame, card, DEFAULT_ANCHOR, insets, true);
  assert.equal(rtl.left, 300 + 12);
});

test("a drop becomes an anchor that keeps its corner when the column resizes", () => {
  const anchor = anchorAt(frame, card, 500, 300, insets);
  assert.ok(anchor.x > 0 && anchor.x < 1);
  assert.deepEqual(placeCard(frame, card, anchor, insets), { left: 500, top: 300 });
  const narrower: Rect = { ...frame, width: 600 };
  const moved = placeCard(narrower, card, anchor, insets);
  assert.ok(moved.left >= narrower.left + insets.start);
  assert.ok(moved.left + card.width <= narrower.left + narrower.width - insets.end);
});

test("a drop near an edge snaps to it, in both reading directions", () => {
  const nearEnd = anchorAt(frame, card, 300 + 900 - 12 - 272 - (SNAP_PX - 4), 50 + 12 + 5, insets);
  assert.deepEqual(nearEnd, { x: 1, y: 0 });
  const rtl = anchorAt(frame, card, 300 + 12 + 3, 50 + 700 - 12 - 380, insets, true);
  assert.deepEqual(rtl, { x: 1, y: 1 }, "the left edge is the end edge in RTL");
});

test("a dragged card stays inside the column", () => {
  assert.deepEqual(clampPosition(frame, card, -500, 9000, insets), { left: 312, top: 50 + 700 - 12 - 380 });
  // A column smaller than the card pins it to the start corner instead of overflowing backwards.
  const tiny: Rect = { left: 0, top: 0, width: 200, height: 200 };
  assert.deepEqual(placeCard(tiny, card, { x: 1, y: 1 }, insets), { left: 12, top: 12 });
});
