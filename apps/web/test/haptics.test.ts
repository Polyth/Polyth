import test from "node:test";
import assert from "node:assert/strict";
import {
  NATIVE_HAPTIC_EVENT,
  errorFeedback,
  hapticFeedback,
  selectionFeedback,
  successFeedback,
} from "../src/haptics.ts";

test("semantic web haptics emit one bounded browser vibration", () => {
  const calls: Array<number | number[]> = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { vibrate: (pattern: number | number[]) => { calls.push(pattern); return true; } },
  });

  selectionFeedback();
  successFeedback();
  errorFeedback();

  assert.deepEqual(calls, [5, [8, 32, 8], [18, 34, 18]]);
});

test("native shells use the Capacitor event backend instead of browser vibration", () => {
  const calls: string[] = [];
  const target = new EventTarget();
  target.addEventListener(NATIVE_HAPTIC_EVENT, (event) => {
    calls.push((event as CustomEvent<string>).detail);
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body: { dataset: { nativePlatform: "ios" } } },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { vibrate: () => { throw new Error("browser fallback must not run"); } },
  });

  hapticFeedback("warning");

  assert.deepEqual(calls, ["warning"]);
});
