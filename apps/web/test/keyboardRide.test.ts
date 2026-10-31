import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });

const { keyboardCurve, captureRide, focusRidesKeyboard, primeKeyboardRide, cancelKeyboardRide, KEYBOARD_RIDER_ATTRIBUTE } =
  await import("../src/keyboardRide.ts");
const { springEasing } = await import("../src/keyboardMotion.ts");

test("the keyboard token's cubic-bezier is sampled as the browser eases it", () => {
  const curve = keyboardCurve("cubic-bezier(0.38, 0.7, 0.125, 1)");
  assert.equal(curve(0), 0);
  assert.equal(curve(1), 1);
  // A steep start: most of the travel happens early, as UIKit's keyboard does.
  assert.ok(curve(0.25) > 0.6, `quarter time covers most of the way (${curve(0.25)})`);
  for (let i = 1; i <= 20; i++) assert.ok(curve(i / 20) >= curve((i - 1) / 20) - 1e-6, "monotonic");
  // The symmetric ease is its own mirror: a check on the solver itself.
  const ease = keyboardCurve("cubic-bezier(0.42, 0, 0.58, 1)");
  assert.ok(Math.abs(ease(0.5) - 0.5) < 1e-3);
  assert.ok(Math.abs(ease(0.25) + ease(0.75) - 1) < 1e-3);
});

test("a reported spring's linear() stops are followed stop by stop", () => {
  const spring = { mass: 1, stiffness: 200, damping: 2 * Math.sqrt(200), initialVelocity: 0 };
  const easing = springEasing(spring, 500)!;
  const curve = keyboardCurve(easing);
  const stops = easing.replace(/^linear\(|\)$/g, "").split(", ").map(Number);
  for (let i = 0; i < stops.length; i++) {
    assert.ok(Math.abs(curve(i / (stops.length - 1)) - stops[i]!) < 1e-9, `stop ${i}`);
  }
  // Between stops: linear interpolation, as CSS linear() does.
  const mid = curve(0.5 / (stops.length - 1));
  assert.ok(Math.abs(mid - (stops[0]! + stops[1]!) / 2) < 1e-9);
  // Anything unreadable falls back to the token's curve, never to a jump.
  assert.ok(keyboardCurve("steps(4)")(0.25) > 0.5);
});

test("only a docked composer's editor rides the keyboard, and a touch on it primes its layers", () => {
  document.body.innerHTML = `
    <div class="focus-conversation">
      <div class="timeline-wrap"><div class="timeline"><div class="msg">row</div></div></div>
      <div class="conversation-composer-dock"><div class="composer"><div class="composer-card"><textarea></textarea></div></div></div>
    </div>
    <input class="elsewhere">`;
  // happy-dom lays nothing out: give the riders a box so they count as visible.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".conversation-composer-dock, .timeline-wrap"))) {
    el.getClientRects = () => [{ x: 0, y: 0, width: 1, height: 1 }] as unknown as DOMRectList;
    // A ride needs Web Animations, which happy-dom does not implement.
    if (typeof el.animate !== "function") (el as unknown as { animate: () => void }).animate = () => undefined;
  }
  document.querySelector<HTMLInputElement>(".elsewhere")!.focus();
  assert.equal(focusRidesKeyboard(), false, "a field outside the docks takes the frame at once");
  document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  assert.equal(focusRidesKeyboard(), true);
  const snapshot = captureRide();
  assert.deepEqual(snapshot?.riders.map((rider) => rider.role), ["dock", "content"]);

  primeKeyboardRide(document.querySelector("textarea"));
  assert.ok(document.querySelector(".conversation-composer-dock")!.hasAttribute(KEYBOARD_RIDER_ATTRIBUTE));
  assert.ok(document.querySelector(".timeline-wrap")!.hasAttribute(KEYBOARD_RIDER_ATTRIBUTE));
  cancelKeyboardRide();
  assert.equal(document.querySelectorAll(`[${KEYBOARD_RIDER_ATTRIBUTE}]`).length, 0);
});
