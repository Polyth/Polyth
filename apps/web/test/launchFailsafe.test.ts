// A launch whose page never rendered: never an empty white page on the phone app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  UNRENDERED_LAUNCH_MS,
  UNRENDERED_RELOAD_WINDOW_MS,
  unrenderedLaunchFallback,
} from "../src/launchFailsafe.ts";

const now = 1_000_000;

test("the phone app's Link page goes back to the hub instead of lifting onto nothing", () => {
  assert.equal(unrenderedLaunchFallback({ native: true, loopback: true, lastReloadAt: null, now }), "hub");
  // The hub's own resume cooldown bounds repeats, not this page.
  assert.equal(unrenderedLaunchFallback({ native: true, loopback: true, lastReloadAt: now - 1, now }), "hub");
});

test("the bundled hub reloads once per window, then shows what is there", () => {
  assert.equal(unrenderedLaunchFallback({ native: true, loopback: false, lastReloadAt: null, now }), "reload");
  assert.equal(unrenderedLaunchFallback({ native: true, loopback: false, lastReloadAt: now - 5_000, now }), "lift");
  assert.equal(
    unrenderedLaunchFallback({ native: true, loopback: false, lastReloadAt: now - UNRENDERED_RELOAD_WINDOW_MS, now }),
    "reload",
  );
});

test("browsers and the desktop app keep lifting the veil", () => {
  assert.equal(unrenderedLaunchFallback({ native: false, loopback: true, lastReloadAt: null, now }), "lift");
  assert.equal(unrenderedLaunchFallback({ native: false, loopback: false, lastReloadAt: null, now }), "lift");
});

test("main.tsx arms the failsafe before its first await and fires earlier than index.html's", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const armed = main.indexOf("}, UNRENDERED_LAUNCH_MS);");
  const firstAwait = main.indexOf("await prepareMobileLaunch()");
  assert.ok(armed > 0 && firstAwait > 0 && armed < firstAwait, "a stalled native call or Link read is covered");
  assert.match(main, /returnToMobileConnectionHub\([^)]*\{ resume: true \}\)/);
  assert.doesNotMatch(main, /\}, 15_000\);/, "one deadline, from launchFailsafe.ts");
  const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
  const inline = Number(html.match(/\}, (\d+)\);\s*return;\s*\}\s*document\.documentElement\.removeAttribute\("data-launch"\)/)?.[1]);
  assert.ok(inline > UNRENDERED_LAUNCH_MS, "index.html only covers a page whose scripts never ran");
});
