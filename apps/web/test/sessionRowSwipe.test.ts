import test from "node:test";
import assert from "node:assert/strict";
import {
  availableRowSwipeActions, commitDistance, fullSwipeAction, isCommitting, parseRowSwipeActions, parseRowSwipeFull,
  releaseVelocity, revealProgress, rubberBandOffset, ROW_SWIPE_DEFAULTS, settleDuration, settleRowSwipe,
  swipeOwnership, trayWidth,
} from "../src/components/mobile/sessionRowSwipe.ts";
import { parseUiSettings, UI_DEFAULTS } from "../src/uiPrefs.ts";

test("action lists normalise: unknown ids, duplicates and overflow are dropped", () => {
  assert.deepEqual(parseRowSwipeActions(["archive", "bogus", "archive", "pin", "mute", "delete"], []), ["archive", "pin", "mute"]);
  assert.deepEqual(parseRowSwipeActions("pin", ["archive"]), ["archive"], "a non-array falls back");
  assert.deepEqual(parseRowSwipeActions([], ["pin"]), [], "an explicit empty list is a choice");
  assert.equal(parseRowSwipeFull("yes"), true);
  assert.equal(parseRowSwipeFull(false), false);
});

test("UI settings carry defaults for a record that predates the fields and keep chosen values", () => {
  const old = parseUiSettings(JSON.stringify({ swipeNavigation: "edge" }));
  assert.deepEqual(old.rowSwipeLeading, ["pin", "archive"]);
  assert.deepEqual(old.rowSwipeTrailing, []);
  assert.equal(old.rowSwipeFull, true);
  const chosen = parseUiSettings(JSON.stringify({ rowSwipeLeading: ["mute"], rowSwipeTrailing: ["delete", "x"], rowSwipeFull: false }));
  assert.deepEqual(chosen.rowSwipeLeading, ["mute"]);
  assert.deepEqual(chosen.rowSwipeTrailing, ["delete"]);
  assert.equal(chosen.rowSwipeFull, false);
  assert.deepEqual(UI_DEFAULTS.rowSwipeLeading, ROW_SWIPE_DEFAULTS.leading);
});

test("availability: mute needs a conversation, archive and delete need manage access", () => {
  const all = ["pin", "archive", "mute", "delete"] as const;
  assert.deepEqual(availableRowSwipeActions(all, { conversation: false, manage: false }), ["pin"]);
  assert.deepEqual(availableRowSwipeActions(all, { conversation: true, manage: true }), [...all]);
});

test("a full swipe never commits delete, and needs the setting", () => {
  assert.equal(fullSwipeAction(["pin", "archive"], true), "pin");
  assert.equal(fullSwipeAction(["delete", "pin"], true), null);
  assert.equal(fullSwipeAction(["pin"], false), null);
  assert.equal(fullSwipeAction([], true), null);
});

test("data-owns-swipe per configuration", () => {
  assert.equal(swipeOwnership(128, 0, false), "toward-end", "default: swipe toward the start still closes the Navigator");
  assert.equal(swipeOwnership(128, 64, false), "", "both sides configured");
  assert.equal(swipeOwnership(0, 64, false), "toward-start");
  assert.equal(swipeOwnership(0, 0, false), undefined);
  assert.equal(swipeOwnership(128, 0, true), "", "an open tray owns the drag back");
});

test("row follows 1:1 through the tray and rubber-bands past it", () => {
  assert.equal(rubberBandOffset(100, 128, false, 360), 100);
  const banded = rubberBandOffset(300, 128, false, 360);
  assert.ok(banded > 128 && banded < 128 + 28, "asymptotic stop without commit");
  assert.equal(rubberBandOffset(-300, 128, false, 360), -banded, "mirrors on the trailing side");
  assert.equal(rubberBandOffset(200, 128, true, 360), 128 + 36, "half speed past the tray when it can commit");
  assert.equal(rubberBandOffset(50, 0, true, 360), 0, "no tray, no movement");
  assert.equal(revealProgress(64, 128), 0.5);
  assert.equal(revealProgress(-300, 128), 1);
});

test("commit threshold is 60% of the row and only when committing is allowed", () => {
  assert.equal(commitDistance(360), 216);
  assert.equal(isCommitting(216, true, 360), true);
  assert.equal(isCommitting(215, true, 360), false);
  assert.equal(isCommitting(-300, true, 360), true);
  assert.equal(isCommitting(300, false, 360), false);
});

test("release decision: distance, velocity flick, and commit", () => {
  const base = { rowWidth: 360, canCommit: true, openAtStart: false, tray: 128 };
  assert.equal(settleRowSwipe({ ...base, raw: 50, velocity: 0 }), "close");
  assert.equal(settleRowSwipe({ ...base, raw: 70, velocity: 0 }), "open");
  assert.equal(settleRowSwipe({ ...base, raw: 30, velocity: 0.8 }), "open", "a fast flick opens below the threshold");
  assert.equal(settleRowSwipe({ ...base, raw: 100, velocity: -0.8 }), "close", "a fast flick back closes past the threshold");
  assert.equal(settleRowSwipe({ ...base, raw: 230, velocity: 0 }), "commit");
  assert.equal(settleRowSwipe({ ...base, raw: -230, velocity: 0 }), "commit", "trailing side");
  assert.equal(settleRowSwipe({ ...base, raw: 230, velocity: 0, canCommit: false }), "open");
  assert.equal(settleRowSwipe({ ...base, raw: 150, velocity: 1.5, openAtStart: true }), "commit", "second swipe from an open tray");
  assert.equal(settleRowSwipe({ ...base, raw: 150, velocity: 1.5, openAtStart: false }), "open");
  assert.equal(settleRowSwipe({ ...base, raw: 40, velocity: 0, tray: 0 }), "close");
});

test("settle time follows the release speed and stays clamped", () => {
  assert.equal(settleDuration(100, 0), 220);
  assert.equal(settleDuration(100, 2), 120);
  assert.equal(settleDuration(100, 0.1), 320);
  assert.equal(settleDuration(100, 0.5), 200);
});

test("release velocity reads the last 100 ms only", () => {
  assert.equal(releaseVelocity([{ x: 0, t: 0 }, { x: 50, t: 50 }], 60), 1);
  assert.equal(releaseVelocity([{ x: 0, t: 0 }, { x: 50, t: 50 }], 400), 0, "a resting finger has no velocity");
  assert.equal(releaseVelocity([{ x: 10, t: 0 }], 10), 0);
  assert.equal(trayWidth(2), 128);
});
