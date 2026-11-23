import assert from "node:assert/strict";
import test from "node:test";
import { anchorAt, clampPosition, DEFAULT_ANCHOR, parseAnchor, placeCard, SNAP_PX, type Insets, type Rect } from "../src/placement.ts";
import { DEFAULT_CYCLE_ID, insertStep, MAX_CYCLES, MAX_STEPS, moveStep, newStep, removeStep, STEP_MINUTES, updateStep } from "../src/cycles.ts";
import { activeCycle, DEFAULT_SETTINGS, LABEL_MAX, normalizeLabel, parseSettings, sameSettings } from "../src/settings.ts";

test("settings fall back to defaults and clamp every field", () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings([1, 2]), DEFAULT_SETTINGS);
  const parsed = parseSettings({
    cycles: [],
    volume: 3,
    repeat: -1,
    soundId: "airhorn",
    sound: "yes",
    flash: false,
    cycleId: "c-gone",
  });
  assert.equal(parsed.cycleId, DEFAULT_CYCLE_ID, "a cycle that no longer exists falls back to the classic one");
  assert.equal(parsed.volume, 1);
  assert.equal(parsed.repeat, 1);
  assert.equal(parsed.soundId, "chime");
  assert.equal(parsed.sound, DEFAULT_SETTINGS.sound);
  assert.equal(parsed.flash, false);
  assert.ok(sameSettings(parseSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS));
  assert.ok(!sameSettings(parsed, DEFAULT_SETTINGS));
});

test("own cycles are parsed step by step: bad steps drop, numbers clamp, ids stay unique", () => {
  const parsed = parseSettings({
    cycleId: "c-desk",
    cycles: [
      {
        id: "c-desk",
        name: "  Desk \n day ",
        steps: [
          { name: "Stand", minutes: 0, kind: "focus", color: "amber" },
          { name: "Sit", minutes: 9999, kind: "nap", color: "plaid", preset: "nope" },
          { name: "no length" },
          "junk",
        ],
      },
      { id: "c-desk", name: "duplicate", steps: [{ minutes: 5 }] },
      { id: "Bad Id!", steps: [{ minutes: 5 }] },
      { id: "c-empty", steps: [] },
    ],
  });
  assert.equal(parsed.cycles.length, 1);
  const cycle = parsed.cycles[0]!;
  assert.equal(cycle.name, "Desk day");
  assert.deepEqual(cycle.steps, [
    { name: "Stand", minutes: 1, kind: "focus", color: "amber" },
    { name: "Sit", minutes: STEP_MINUTES.max, kind: "focus", color: "accent" },
  ]);
  assert.equal(activeCycle(parsed).id, "c-desk");
  const many = parseSettings({ cycles: Array.from({ length: 40 }, (_, i) => ({ id: `c-${i}`, steps: [{ minutes: 5 }] })) });
  assert.equal(many.cycles.length, MAX_CYCLES);
  const long = parseSettings({ cycles: [{ id: "c-long", steps: Array.from({ length: 30 }, () => ({ minutes: 5 })) }] });
  assert.equal(long.cycles[0]!.steps.length, MAX_STEPS);
});

test("older settings with custom lengths, rounds or labels become the person's own cycle", () => {
  // The defaults of the old shape are simply the classic cycle.
  assert.deepEqual(parseSettings({ focusMin: 25, shortMin: 5, longMin: 15, rounds: 4 }), DEFAULT_SETTINGS);
  const parsed = parseSettings({ focusMin: 25, shortMin: 5, longMin: 15, rounds: 2, focusLabel: "Stand", shortLabel: "Sit", soundId: "bell" });
  assert.equal(parsed.soundId, "bell");
  assert.equal(parsed.cycles.length, 1);
  const cycle = activeCycle(parsed);
  assert.equal(cycle.name, "Stand / Sit");
  assert.deepEqual(cycle.steps.map((item) => [item.name, item.minutes, item.kind]), [
    ["Stand", 25, "focus"], ["Sit", 5, "break"], ["Stand", 25, "focus"], ["", 15, "break"],
  ]);
  assert.equal(cycle.steps[3]!.preset, "long");
  // Once saved in the new shape, the old fields are not read again.
  assert.deepEqual(parseSettings({ ...parsed, focusMin: 50 }), parsed);
});

test("names are one tidy line, capped by characters", () => {
  assert.equal(normalizeLabel("  Звіт \n для\tклієнта  "), "Звіт для клієнта");
  assert.equal(normalizeLabel("a\u0000b\u2028c"), "a b c");
  assert.equal(normalizeLabel(42), "");
  assert.equal(normalizeLabel("   "), "");
  // An emoji counts as one character and is never cut in half.
  const long = "🍅".repeat(LABEL_MAX + 5);
  assert.equal(Array.from(normalizeLabel(long)).length, LABEL_MAX);
  assert.equal(normalizeLabel(long), "🍅".repeat(LABEL_MAX));
  const parsed = parseSettings({ countdownLabel: "  Tea  " });
  assert.equal(parsed.countdownLabel, "Tea");
  assert.ok(!sameSettings(parsed, DEFAULT_SETTINGS), "a name alone is a change worth saving");
});

test("step edits move the right steps and report where each old index went", () => {
  const cycle = { id: "c-x", name: "", steps: [10, 20, 30, 40].map((minutes) => ({ name: "", minutes, kind: "focus" as const, color: "accent" as const })) };
  const moved = moveStep(cycle, 0, 2);
  assert.deepEqual(moved.cycle.steps.map((item) => item.minutes), [20, 30, 10, 40]);
  assert.deepEqual([0, 1, 2, 3].map(moved.map!), [2, 0, 1, 3]);
  const back = moveStep(cycle, 3, 1);
  assert.deepEqual(back.cycle.steps.map((item) => item.minutes), [10, 40, 20, 30]);
  assert.deepEqual([0, 1, 2, 3].map(back.map!), [0, 2, 3, 1]);
  const removed = removeStep(cycle, 1);
  assert.deepEqual(removed.cycle.steps.map((item) => item.minutes), [10, 30, 40]);
  assert.deepEqual([0, 1, 2, 3].map(removed.map!), [0, 1, 1, 2]);
  assert.equal(removeStep({ ...cycle, steps: [cycle.steps[0]!] }, 0).cycle.steps.length, 1, "the last step stays");
  const inserted = insertStep(cycle, 1, newStep(cycle.steps[0]));
  assert.deepEqual(inserted.cycle.steps.map((item) => [item.minutes, item.kind]), [[10, "focus"], [5, "break"], [20, "focus"], [30, "focus"], [40, "focus"]]);
  assert.deepEqual([0, 1, 2, 3].map(inserted.map!), [0, 2, 3, 4]);
  const renamed = updateStep(cycle, 2, { name: "  Deep\nwork ", minutes: 999 });
  assert.equal(renamed.cycle.steps[2]!.name, "Deep work");
  assert.equal(renamed.cycle.steps[2]!.minutes, STEP_MINUTES.max);
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
