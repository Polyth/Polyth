import test from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_SWIPE_COMMIT_PROGRESS,
  EDGE_SWIPE_COMMIT_VELOCITY,
  EDGE_SWIPE_FLICK_MIN_TRAVEL,
  EDGE_SWIPE_SLOP,
  EDGE_SWIPE_ZONE,
  PULL_REFRESH_DISTANCE,
  SESSION_SWIPE_REVEAL,
  SETTLE_MIN_MS,
  SURFACE_SWIPE_SLOP,
  caughtUpTravel,
  cubicBezier,
  directedTravel,
  edgeSwipeCommits,
  edgeSwipeIntent,
  edgeSwipeProgress,
  horizontalDistance,
  inlineTravel,
  isEdgeSwipeStart,
  isSwipeEdgeStart,
  pullRefreshDistance,
  releaseVelocity,
  scrollerTakesSwipe,
  settleDurationMs,
  stackEase,
  swipeIntent,
} from "../src/mobileGestures.ts";

test("session swipes require deliberate horizontal movement", () => {
  assert.equal(horizontalDistance({ x: 180, y: 100 }, { x: 180 - SESSION_SWIPE_REVEAL, y: 106 }), -64);
  assert.equal(horizontalDistance({ x: 180, y: 100 }, { x: 174, y: 170 }), null);
  assert.equal(horizontalDistance({ x: 180, y: 100 }, { x: 176, y: 102 }), null);
});

test("pull to refresh only arms from the top with vertical resistance", () => {
  assert.equal(pullRefreshDistance({ x: 80, y: 40 }, { x: 84, y: 40 + PULL_REFRESH_DISTANCE * 2 }, 0), PULL_REFRESH_DISTANCE);
  assert.equal(pullRefreshDistance({ x: 80, y: 40 }, { x: 84, y: 180 }, 1), 0);
  assert.equal(pullRefreshDistance({ x: 80, y: 40 }, { x: 180, y: 80 }, 0), 0);
  assert.equal(pullRefreshDistance({ x: 80, y: 40 }, { x: 80, y: 400 }, 0), 96);
});

test("an interactive edge swipe starts at the inline-start edge in either direction", () => {
  assert.equal(isEdgeSwipeStart(EDGE_SWIPE_ZONE, 390, false), true);
  assert.equal(isEdgeSwipeStart(EDGE_SWIPE_ZONE + 1, 390, false), false);
  assert.equal(isEdgeSwipeStart(390 - EDGE_SWIPE_ZONE, 390, true), true, "RTL starts at the right edge");
  assert.equal(isEdgeSwipeStart(390 - EDGE_SWIPE_ZONE - 1, 390, true), false);
  assert.equal(isEdgeSwipeStart(8, 390, true), false, "the left edge is the inline END in RTL");
  assert.equal(inlineTravel(10, 110, false), 100);
  assert.equal(inlineTravel(380, 280, true), 100, "RTL travel is measured toward the left");
});

test("an edge touch claims the swipe only for deliberate horizontal movement toward the inline end", () => {
  const start = { x: 12, y: 300 };
  assert.equal(edgeSwipeIntent(start, { x: 12 + EDGE_SWIPE_SLOP, y: 302 }, false), "pending", "inside the slop it is still a tap");
  assert.equal(edgeSwipeIntent(start, { x: 40, y: 306 }, false), "swipe");
  assert.equal(edgeSwipeIntent(start, { x: 40, y: 360 }, false), "scroll", "mostly vertical movement is a scroll");
  assert.equal(edgeSwipeIntent(start, { x: 14, y: 330 }, false), "scroll");
  assert.equal(edgeSwipeIntent(start, { x: 4, y: 300 }, false), "pending", "a small drift toward the edge is inside the slop");
  assert.equal(edgeSwipeIntent(start, { x: -4, y: 300 }, false), "scroll", "…a deliberate one is not ours");
  assert.equal(edgeSwipeIntent({ x: 100, y: 300 }, { x: 60, y: 301 }, false), "scroll", "away from the inline end never pops");
  assert.equal(edgeSwipeIntent({ x: 378, y: 300 }, { x: 340, y: 306 }, true), "swipe", "RTL swipes toward the left");
});

test("edge swipe progress is clamped and a release decides by distance or flick", () => {
  assert.equal(edgeSwipeProgress(-20, 390), 0);
  assert.equal(edgeSwipeProgress(195, 390), 0.5);
  assert.equal(edgeSwipeProgress(900, 390), 1);
  assert.equal(edgeSwipeProgress(100, 0), 0, "an unmeasured layer never divides by zero");

  const width = 390;
  const slow = (travel: number) => edgeSwipeCommits({ travel, width, velocity: 0.05 });
  assert.equal(slow(width * EDGE_SWIPE_COMMIT_PROGRESS - 1), false, "a short slow drag springs home");
  assert.equal(slow(width * EDGE_SWIPE_COMMIT_PROGRESS), true, "past the share it completes");
  assert.equal(edgeSwipeCommits({ travel: EDGE_SWIPE_FLICK_MIN_TRAVEL, width, velocity: EDGE_SWIPE_COMMIT_VELOCITY }), true,
    "a quick flick completes from a short drag");
  assert.equal(edgeSwipeCommits({ travel: EDGE_SWIPE_FLICK_MIN_TRAVEL - 1, width, velocity: 2 }), false, "a twitch does not");
  assert.equal(edgeSwipeCommits({ travel: width * 0.8, width, velocity: -EDGE_SWIPE_COMMIT_VELOCITY }), false,
    "pulling back at speed cancels even far along");
});

test("release velocity reads the trailing window only", () => {
  assert.equal(releaseVelocity([]), 0);
  assert.equal(releaseVelocity([{ t: 0, travel: 0 }]), 0);
  assert.equal(releaseVelocity([{ t: 0, travel: 0 }, { t: 50, travel: 25 }, { t: 100, travel: 50 }]), 0.5);
  // A long, slow drag that ends with a flick is a flick: the old samples fall out of the window.
  assert.equal(
    releaseVelocity([{ t: 0, travel: 0 }, { t: 900, travel: 90 }, { t: 950, travel: 100 }, { t: 1000, travel: 150 }]),
    (150 - 90) / 100,
  );
  assert.ok(releaseVelocity([{ t: 0, travel: 200 }, { t: 40, travel: 150 }]) < 0, "returning is negative");
});

test("shell swipes measure travel along their own direction and start at the edge they leave", () => {
  assert.equal(directedTravel(100, 160, false, "toward-end"), 60);
  assert.equal(directedTravel(100, 160, false, "toward-start"), -60);
  assert.equal(directedTravel(300, 240, true, "toward-end"), 60, "RTL: the inline end is on the left");
  assert.equal(directedTravel(300, 240, true, "toward-start"), -60);

  // Toward the inline end (Navigator, Back) leaves the inline-start edge…
  assert.equal(isSwipeEdgeStart(EDGE_SWIPE_ZONE, 390, false, "toward-end"), true);
  assert.equal(isSwipeEdgeStart(390 - 4, 390, false, "toward-end"), false);
  // …toward the inline start (Workspace) leaves the inline-end edge.
  assert.equal(isSwipeEdgeStart(390 - EDGE_SWIPE_ZONE, 390, false, "toward-start"), true);
  assert.equal(isSwipeEdgeStart(390 - EDGE_SWIPE_ZONE - 1, 390, false, "toward-start"), false);
  assert.equal(isSwipeEdgeStart(4, 390, true, "toward-start"), true, "mirrored in RTL");
  assert.equal(isSwipeEdgeStart(386, 390, true, "toward-start"), false);
});

test("an edge start keeps the lenient edge rule; a surface start must be decisive", () => {
  const start = { x: 200, y: 300 };
  const edge = { rtl: false, direction: "toward-end" as const, edge: true };
  const surface = { rtl: false, direction: "toward-end" as const, edge: false };
  // Identical to edgeSwipeIntent at the edge.
  for (const to of [{ x: 211, y: 302 }, { x: 228, y: 306 }, { x: 228, y: 360 }, { x: 188, y: 300 }]) {
    assert.equal(swipeIntent(start, to, edge), edgeSwipeIntent(start, to, false));
  }
  assert.equal(swipeIntent(start, { x: 200 + SURFACE_SWIPE_SLOP, y: 300 }, surface), "pending", "more travel before a surface claim");
  assert.equal(swipeIntent(start, { x: 230, y: 304 }, surface), "swipe");
  assert.equal(swipeIntent(start, { x: 218, y: 312 }, surface), "pending", "a diagonal is not yet a swipe…");
  assert.equal(swipeIntent(start, { x: 226, y: 318 }, surface), "scroll", "…and one that wanders gives up");
  assert.equal(swipeIntent(start, { x: 230, y: 304 }, { ...surface, direction: "toward-start" }), "scroll",
    "the opposite direction is never ours");
  assert.equal(swipeIntent(start, { x: 170, y: 304 }, { ...surface, direction: "toward-start" }), "swipe");
  assert.equal(swipeIntent(start, { x: 230, y: 304 }, { rtl: true, direction: "toward-start", edge: false }), "swipe",
    "RTL: toward the inline start is rightward");
});

test("a release settles in the rest of its travel time and never slows a flick down", () => {
  const base = 300;
  const width = 400;
  assert.equal(settleDurationMs({ remaining: width, width, velocity: 0, base }), base, "the whole way takes the full time");
  assert.equal(settleDurationMs({ remaining: 200, width, velocity: 0, base }), Math.round(base * (0.45 + 0.55 * 0.5)));
  assert.ok(settleDurationMs({ remaining: 40, width, velocity: 0, base }) >= SETTLE_MIN_MS, "a short rest still reads as motion");
  // The curve leaves at the finger's speed: 2.25 × remaining / velocity.
  assert.equal(settleDurationMs({ remaining: 200, width, velocity: 3, base }), 150);
  assert.equal(settleDurationMs({ remaining: 200, width, velocity: 5, base }), SETTLE_MIN_MS, "but never a blink");
  assert.equal(settleDurationMs({ remaining: 400, width, velocity: 4, base }), 225);
  assert.equal(settleDurationMs({ remaining: 200, width, velocity: -2, base }), Math.round(base * 0.725),
    "moving away from the destination gains no speed-up");
  assert.equal(settleDurationMs({ remaining: 200, width, velocity: 1, base: 0 }), 0, "motion off: nothing to wait for");
  assert.equal(settleDurationMs({ remaining: 200, width, velocity: 0, base: 90 }), 90, "never longer than the token");
});

test("a horizontal scroller keeps a swipe until it has nowhere left to go that way", () => {
  const box = (scrollLeft: number) => ({ scrollLeft, scrollWidth: 900, clientWidth: 300 });
  assert.equal(scrollerTakesSwipe(box(0), "toward-end"), false, "at its start, a swipe toward the end is the shell's");
  assert.equal(scrollerTakesSwipe(box(0), "toward-start"), true, "…and one toward the start scrolls it");
  assert.equal(scrollerTakesSwipe(box(250), "toward-end"), true);
  assert.equal(scrollerTakesSwipe(box(600), "toward-start"), false, "at its end");
  assert.equal(scrollerTakesSwipe(box(-250), "toward-end"), true, "RTL scrollLeft counts down from 0");
  assert.equal(scrollerTakesSwipe(box(-600), "toward-start"), false);
  assert.equal(scrollerTakesSwipe({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }, "toward-start"), false,
    "content that fits does not scroll");
});

test("a claimed drag leaves rest with the finger and is under it one claim distance later", () => {
  // Claimed 12px in: painting 12px at once would lurch; the gap closes instead.
  assert.equal(caughtUpTravel(12, 12), 0, "the frame that claims stays at rest");
  assert.equal(caughtUpTravel(18, 12), 12, "twice the finger's speed while catching up");
  assert.equal(caughtUpTravel(24, 12), 24, "caught up: exactly under the finger");
  assert.equal(caughtUpTravel(240, 12), 240);
  assert.equal(caughtUpTravel(4, 12), 0, "back behind the claim point is rest, never negative");
  assert.equal(caughtUpTravel(30, 0), 30, "nothing to close: a caught layer moves 1:1 at once");
  // Monotonic and continuous across the hand-over to 1:1 tracking.
  let previous = -1;
  for (let travel = 12; travel <= 60; travel += 0.5) {
    const painted = caughtUpTravel(travel, 12);
    assert.ok(painted >= previous, `monotonic at ${travel}`);
    assert.ok(painted - previous <= 2.0001 || previous < 0, `no jump at ${travel}`);
    previous = painted;
  }
});

test("scripted settles follow the stack curve the CSS hand-offs use", () => {
  const linear = cubicBezier(0, 0, 1, 1);
  for (const t of [0, 0.1, 0.5, 0.9, 1]) assert.ok(Math.abs(linear(t) - t) < 1e-5, `linear at ${t}`);
  // cubic-bezier(.32,.72,0,1): starts at slope .72/.32 (the settle math's assumption), ends at rest.
  assert.equal(stackEase(0), 0);
  assert.equal(stackEase(1), 1);
  const slope = stackEase(0.001) / 0.001;
  assert.ok(Math.abs(slope - 2.25) < 0.05, `initial slope ${slope}`);
  let previous = 0;
  for (let t = 0.02; t <= 1; t += 0.02) {
    const value = stackEase(t);
    assert.ok(value >= previous - 1e-9 && value <= 1 + 1e-9, `monotonic at ${t}`);
    previous = value;
  }
  // Front-loaded like the CSS curve: more than half the way in the first quarter.
  assert.ok(stackEase(0.25) > 0.5);
});
