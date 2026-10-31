import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeKeyboardMotion } from "../src/keyboardMotion.ts";

test("a keyboard motion report keeps only the documented plain numbers", () => {
  assert.deepEqual(normalizeKeyboardMotion({
    duration: 250, curve: 7, animationDuration: 512.5, sentAt: 1_760_000_000_000,
    spring: { mass: 3, stiffness: 1000, damping: 500, initialVelocity: 0 },
    bezier: [0, 0, 1, 1],
  } as never), {
    durationMs: 250, animationDurationMs: 512.5, sentAt: 1_760_000_000_000,
    spring: { mass: 3, stiffness: 1000, damping: 500, initialVelocity: 0 },
  });
  assert.deepEqual(normalizeKeyboardMotion({ duration: 300, bezier: [0.2, 0.8, 0.2, 1] }),
    { durationMs: 300, bezier: [0.2, 0.8, 0.2, 1] });
  // Missing pieces drop out instead of reaching CSS as NaN.
  assert.deepEqual(normalizeKeyboardMotion({ duration: 250, spring: { mass: "3" }, bezier: [0, "x", 1, 1], sentAt: "now" }),
    { durationMs: 250 });
  assert.equal(normalizeKeyboardMotion({ duration: 0 }), null);
  assert.equal(normalizeKeyboardMotion({}), null);
  assert.equal(normalizeKeyboardMotion(null), null);
});

test("the iOS app reports the keyboard's curve and the bridge forwards it on iOS only", async () => {
  const [bridge, scene] = await Promise.all([
    readFile(new URL("../src/nativeBridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/SceneDelegate.swift", import.meta.url), "utf8"),
  ]);
  assert.match(scene, /bridge\?\.registerPluginInstance\(PolythKeyboardMotionPlugin\(\)\)/);
  assert.match(scene, /let jsName = "PolythKeyboardMotion"/);
  assert.match(scene, /UIResponder\.keyboardWillChangeFrameNotification/);
  assert.match(scene, /notifyListeners\("keyboardMotion", data: payload\)/);
  assert.match(bridge, /if \(followKeyboard && callbacks\.setKeyboardMotion && Capacitor\.isPluginAvailable\("PolythKeyboardMotion"\)\)/);
  assert.match(bridge, /const motion = normalizeKeyboardMotion\(event\);/);
});
