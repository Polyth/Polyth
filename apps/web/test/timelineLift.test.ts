import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";
import {
  cancelTimelineLift,
  captureTimelineLiftRows,
  playTimelineLift,
  TIMELINE_LIFT_MIN_PX,
  timelineLiftDistance,
  timelineLiftRunning,
} from "../src/timelineLift.ts";
import { TIMELINE_ENTRANCE_ANIMATION_ID } from "../src/timelineMotionClaims.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a tail lift animates committed movement and leaves streaming growth alone", () => {
  assert.equal(timelineLiftDistance(3), 0, "streaming growth keeps the ordinary follow");
  assert.equal(timelineLiftDistance(TIMELINE_LIFT_MIN_PX - 1), 0);
  assert.equal(timelineLiftDistance(TIMELINE_LIFT_MIN_PX), TIMELINE_LIFT_MIN_PX);
  assert.equal(timelineLiftDistance(TIMELINE_LIFT_MIN_PX + 40), TIMELINE_LIFT_MIN_PX + 40);
  assert.equal(timelineLiftDistance(-120), 0, "ordinary follow never animates shrink");
  assert.equal(timelineLiftDistance(-120, { allowShrink: true }), 120,
    "an explicit floor/revert release may glide downward");
  assert.equal(timelineLiftDistance(Number.NaN), 0);
});

test("the timeline writes the canonical tail before flipping visible rows", () => {
  const timeline = source("../src/components/Timeline.tsx");
  const lift = source("../src/timelineLift.ts");

  assert.match(timeline, /captureTimelineLiftRows\(el\)/);
  assert.match(timeline, /playTimelineLift\(liftRows/);
  // Canonical scroll first, FLIP second: no smooth-scroll competes with the
  // reader-intent logic in onScroll.
  assert.match(timeline, /el\.scrollTop = target;[\s\S]*?playTimelineLift\(liftRows/);
  // Sheet geometry must not be measured against rows carrying the lift transform.
  assert.match(timeline, /if \(!liftBusy\.current && !rewindMotionActive\.current\) syncTurnSheet\(\)/);

  assert.match(lift, /translate3d/);
  assert.match(lift, /fill: "both"/);
  // The lift honours the same switches as every other chat motion.
  assert.match(lift, /prefers-reduced-motion/);
  assert.match(lift, /desktopLowResource/);
  assert.match(lift, /reduceAnimations/);
  assert.match(lift, /pkg-harnesses-switch-marker/);
});

test("ungrouped tools join the same tail lift as messages and tasks, without capturing nested tools twice", () => {
  const dom = new Window();
  const previousElement = globalThis.HTMLElement;
  const previousComputedStyle = globalThis.getComputedStyle;
  Object.assign(globalThis, { HTMLElement: dom.HTMLElement, getComputedStyle: dom.getComputedStyle.bind(dom) });
  const timeline = dom.document.createElement("div");
  timeline.innerHTML = '<div class="tool-card execution-row"></div><div class="activity-group"><div class="execution-row"></div></div><div class="task-activity"></div>';
  dom.document.body.append(timeline);
  const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) });
  Object.defineProperty(timeline, "getBoundingClientRect", { value: () => box(0, 600) });
  for (const [index, child] of [...timeline.children].entries()) {
    Object.defineProperty(child, "getBoundingClientRect", { value: () => box(100 + index * 60, 40) });
  }
  try {
    const rows = captureTimelineLiftRows(timeline as unknown as HTMLElement);
    assert.deepEqual(rows.map(({ element }) => element.className), ["tool-card execution-row", "activity-group", "task-activity"]);
    assert.deepEqual(rows.map(({ top }) => top), [100, 160, 220]);
  } finally {
    Object.assign(globalThis, { HTMLElement: previousElement, getComputedStyle: previousComputedStyle });
    dom.close();
  }
});

test("a new lift supersedes a running one from the row's visual pixels; an entrance keeps only its fade", async () => {
  const dom = new Window();
  Object.assign(globalThis, { getComputedStyle: dom.getComputedStyle.bind(dom) });
  interface Recorded { frames: Keyframe[]; id: string; cancelled: boolean; playState: string }
  const made: Recorded[] = [];
  const running = new Map<HTMLElement, Recorded[]>();
  const proto = dom.HTMLElement.prototype as unknown as HTMLElement;
  let layoutTop = 100;
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      // The incoming entrance still contributes 4px until it is cancelled.
      const entering = (running.get(this) ?? []).some((motion) =>
        motion.id === TIMELINE_ENTRANCE_ANIMATION_ID && motion.playState === "running");
      const top = layoutTop + (entering ? 4 : 0);
      return { top, bottom: top + 40, height: 40, left: 0, right: 10, width: 10, x: 0, y: top };
    },
  });
  Object.defineProperty(proto, "animate", {
    configurable: true,
    value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const record: Recorded = { frames, id: String(options.id ?? ""), cancelled: false, playState: "running" };
      made.push(record);
      running.set(this, [...(running.get(this) ?? []), record]);
      let settle!: () => void;
      const finished = new Promise<void>((resolve) => { settle = resolve; });
      return {
        get id() { return record.id; },
        get playState() { return record.playState; },
        finished,
        effect: { getComputedTiming: () => ({ endTime: 300, localTime: 60 }) },
        cancel() { record.cancelled = true; record.playState = "idle"; settle(); },
      } as unknown as Animation;
    },
  });
  Object.defineProperty(proto, "getAnimations", {
    configurable: true,
    value(this: HTMLElement) {
      return (running.get(this) ?? []).filter((record) => record.playState === "running").map((record) => ({
        id: record.id,
        playState: record.playState,
        effect: { getComputedTiming: () => ({ endTime: 300, localTime: 60 }) },
        cancel() { record.cancelled = true; record.playState = "idle"; },
      }));
    },
  });
  const timeline = dom.document.createElement("div") as unknown as HTMLElement;
  const row = dom.document.createElement("div") as unknown as HTMLElement;
  timeline.append(row);
  (dom.document.body as unknown as HTMLElement).append(timeline);

  // chatMotion's entrance was already running when the row joins a lift.
  row.animate([{ opacity: 0, transform: "translate3d(0, 8px, 0)" }, { opacity: 1, transform: "none" }],
    { duration: 300, id: TIMELINE_ENTRANCE_ANIMATION_ID });
  row.style.opacity = "0.2";
  assert.equal(playTimelineLift([{ element: row, top: 104.5 }]), false,
    "a subpixel no-op leaves the running entrance intact");
  assert.equal(made[0]!.cancelled, false);
  // The row was painted at 180; the canonical layout puts it at 100.
  assert.equal(playTimelineLift([{ element: row, top: 180 }]), true);
  const entrance = made[0]!;
  const fade = made[1]!;
  const first = made[2]!;
  assert.ok(entrance.cancelled, "the entrance gives up its transform");
  assert.deepEqual(fade.frames.map((frame) => Object.keys(frame).sort().join()), ["opacity", "opacity"],
    "the entrance continues as an opacity-only fade");
  assert.match(String(first.frames[0]?.transform), /translate3d\(0, 80px, 0\)/);
  assert.equal(timelineLiftRunning(timeline), true);

  // A second lift starts mid-flight: the first is superseded, and the row
  // travels from where it was captured (its visual position), not from layout.
  layoutTop = 60;
  assert.equal(playTimelineLift([{ element: row, top: 150 }]), true);
  const second = made.at(-1)!;
  assert.ok(first.cancelled, "one transform owner per row");
  assert.match(String(second.frames[0]?.transform), /translate3d\(0, 90px, 0\)/);
  // A running transform animation is composited by itself: no layer is
  // forced before the glide or kept after it.
  assert.equal(row.style.willChange, "");

  cancelTimelineLift();
  assert.ok(second.cancelled);
  assert.equal(timelineLiftRunning(timeline), false);
  assert.equal(row.style.willChange, "");

  // A row whose whole path lies outside the reading area is never seen
  // travelling: it lands at once instead of taking a layer for the glide.
  Object.defineProperty(timeline, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 10, width: 10, x: 0, y: 0 }),
  });
  layoutTop = 300;
  const before = made.length;
  assert.equal(playTimelineLift([{ element: row, top: 400 }]), false, "an off-screen path starts no animation");
  assert.equal(made.length, before);
  layoutTop = 90;
  assert.equal(playTimelineLift([{ element: row, top: 400 }]), true, "a path that enters the reading area glides");
  cancelTimelineLift();
  dom.close();
});
