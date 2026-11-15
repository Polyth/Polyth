import test from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_HAPTIC_BURST_MS,
  HAPTICS_MODE_KEY,
  NATIVE_HAPTIC_EVENT,
  errorFeedback,
  eventHaptic,
  getHapticsMode,
  hapticFeedback,
  hapticsSupported,
  selectionFeedback,
  setHapticsMode,
  successFeedback,
  tapFeedback,
} from "../src/haptics.ts";
import { EVENT_HAPTIC } from "../src/notifications.ts";

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

function browserWithMotor(calls: Array<number | number[]>, extra: Record<string, unknown> = {}): void {
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body: { dataset: {} }, visibilityState: "visible", ...extra },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { vibrate: (pattern: number | number[]) => { calls.push(pattern); return true; } },
  });
}

test("the per-device switch silences touches, events or both and is stored locally", () => {
  const calls: Array<number | number[]> = [];
  browserWithMotor(calls);
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
  });
  try {
    assert.equal(getHapticsMode(), "all", "events vibrate by default");

    setHapticsMode("touch");
    assert.equal(stored.get(HAPTICS_MODE_KEY), "touch");
    tapFeedback();
    assert.equal(eventHaptic("success", 100_000), false);
    assert.deepEqual(calls, [8]);

    setHapticsMode("off");
    tapFeedback();
    assert.equal(eventHaptic("error", 200_000), false);
    assert.deepEqual(calls, [8]);

    setHapticsMode("all");
    assert.equal(eventHaptic("success", 300_000), true);
    assert.deepEqual(calls, [8, [8, 32, 8]]);
  } finally {
    setHapticsMode("all");
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a burst of live events vibrates once unless a stronger one follows", () => {
  const calls: Array<number | number[]> = [];
  browserWithMotor(calls);

  assert.equal(eventHaptic("selection", 1_000_000), true);
  assert.equal(eventHaptic("selection", 1_000_100), false, "same strength inside the burst");
  assert.equal(eventHaptic("error", 1_000_200), true, "a failure outranks the burst");
  assert.equal(eventHaptic("success", 1_000_300), false, "weaker than the failure just played");
  assert.equal(eventHaptic("tap", 1_000_200 + EVENT_HAPTIC_BURST_MS), true, "the burst is over");

  assert.deepEqual(calls, [5, [18, 34, 18], 8]);
});

test("live events stay silent while the page is hidden", () => {
  const calls: Array<number | number[]> = [];
  browserWithMotor(calls, { visibilityState: "hidden" });

  assert.equal(eventHaptic("error", 2_000_000), false);
  assert.deepEqual(calls, []);
});

test("only native shells and touch-first browsers count as able to vibrate", () => {
  const media = (coarse: boolean) => Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: () => ({ matches: coarse }),
  });
  try {
    browserWithMotor([]);
    media(true);
    assert.equal(hapticsSupported(), true, "Android Chrome");
    media(false);
    assert.equal(hapticsSupported(), false, "desktop Chromium has vibrate() without a motor");

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    media(true);
    assert.equal(hapticsSupported(), false, "iOS Safari has no vibration API");

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { body: { dataset: { nativePlatform: "ios" } } },
    });
    assert.equal(hapticsSupported(), true, "the native app vibrates through Capacitor");
  } finally {
    Reflect.deleteProperty(globalThis, "matchMedia");
  }
});

test("every notification kind has a vibration, and waiting on the person outranks a finished turn", () => {
  assert.deepEqual(EVENT_HAPTIC, {
    completed: "success",
    failed: "error",
    question: "warning",
    permission: "warning",
    subagent: "selection",
    mention: "tap",
    message: "tap",
  });
});
