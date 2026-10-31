import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });

const { keyboardMotionTiming, recordNativeKeyboardMotion, resetNativeKeyboardMotion, springEasing } =
  await import("../src/keyboardMotion.ts");

const stopsOf = (easing: string) => easing.replace(/^linear\(|\)$/g, "").split(", ").map(Number);

test("a spring becomes a linear() easing that rises from 0 and lands exactly on 1", () => {
  for (const spring of [
    { mass: 1, stiffness: 200, damping: 2 * Math.sqrt(200), initialVelocity: 0 }, // critical
    { mass: 3, stiffness: 1000, damping: 500, initialVelocity: 0 }, // heavily overdamped
    { mass: 1, stiffness: 300, damping: 30, initialVelocity: 0 }, // underdamped
  ]) {
    const easing = springEasing(spring, 500);
    assert.ok(easing?.startsWith("linear("), `${JSON.stringify(spring)} → ${easing}`);
    const stops = stopsOf(easing!);
    assert.equal(stops[0], 0);
    assert.equal(stops.at(-1), 1);
    assert.ok(stops.every(Number.isFinite));
    assert.ok(stops[1]! > 0, "the keyboard starts moving at once");
  }
  // Critically/over-damped springs never overshoot.
  const critical = stopsOf(springEasing({ mass: 1, stiffness: 200, damping: 2 * Math.sqrt(200), initialVelocity: 0 }, 500)!);
  for (let i = 1; i < critical.length; i++) assert.ok(critical[i]! >= critical[i - 1]!, "monotonic");
  // Matches the closed form 1 − (1 + ωt)e^(−ωt) at the midpoint.
  const omega = Math.sqrt(200);
  const mid = critical[(critical.length - 1) / 2]!;
  assert.ok(Math.abs(mid - (1 - (1 + omega * 0.25) * Math.exp(-omega * 0.25))) < 1e-3);

  assert.equal(springEasing({ mass: 0, stiffness: 1, damping: 1, initialVelocity: 0 }, 500), null);
  assert.equal(springEasing({ mass: 1, stiffness: Number.NaN, damping: 1, initialVelocity: 0 }, 500), null);
});

test("the real animation length wins over UIKit's nominal duration; junk reports change nothing", () => {
  const spring = { mass: 1, stiffness: 200, damping: 28, initialVelocity: 0 };
  assert.equal(keyboardMotionTiming({ durationMs: 250, animationDurationMs: 520, spring }, true)?.duration, 520);
  assert.equal(keyboardMotionTiming({ durationMs: 250, spring }, true)?.duration, 250);
  // An engine without linear() keeps the token rather than a wrong curve.
  assert.equal(keyboardMotionTiming({ durationMs: 250, spring }, false), null);
  assert.deepEqual(keyboardMotionTiming({ durationMs: 300, bezier: [0.25, 0.1, 0.25, 1] }, false),
    { duration: 300, easing: "cubic-bezier(0.25, 0.1, 0.25, 1)" });
  assert.equal(keyboardMotionTiming({ durationMs: 300, bezier: [1.5, 0, 0.2, 1] }, true), null);
  assert.equal(keyboardMotionTiming({ durationMs: 10, spring }, true), null);
  assert.equal(keyboardMotionTiming({ durationMs: 60_000, spring }, true), null);
});

test("a report gives every rider the keyboard's timing without restyling <html>", async () => {
  const { keyboardMotion } = await import("../src/motionPresence.ts");
  const { reportedKeyboardTiming } = await import("../src/keyboardMotion.ts");
  const root = document.documentElement;
  recordNativeKeyboardMotion({ durationMs: 300, bezier: [0.2, 0.8, 0.2, 1] });
  assert.deepEqual(reportedKeyboardTiming(), { duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  assert.deepEqual(keyboardMotion(), { duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  // A custom property written on <html> restyles every element of the app.
  assert.equal(root.style.getPropertyValue("--motion-keyboard"), "");
  assert.equal(root.style.getPropertyValue("--motion-keyboard-ease"), "");
  // A report without a usable curve leaves the last good timing in place.
  recordNativeKeyboardMotion({ durationMs: 5 });
  assert.equal(keyboardMotion().duration, 300);
  // Reduced motion still wins.
  root.dataset.reduceAnimations = "true";
  assert.equal(keyboardMotion().duration, 0);
  delete root.dataset.reduceAnimations;
  resetNativeKeyboardMotion();
  assert.equal(reportedKeyboardTiming(), null);
});
