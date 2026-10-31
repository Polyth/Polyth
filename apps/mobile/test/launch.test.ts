// The native launch screen is a curtain the pages hand over to
// their own identical launch veil; it is raised only across page swaps.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { coverPageForLeave, raiseLaunchCurtain, releaseLaunchCurtain, setLaunchLeaveCover } from "../src/launch.ts";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("outside the native shell the curtain helpers do nothing", async () => {
  let covered = 0;
  setLaunchLeaveCover(async () => { covered += 1; });
  try {
    await releaseLaunchCurtain();
    assert.equal(await raiseLaunchCurtain(), false);
    await coverPageForLeave();
    assert.equal(covered, 0, "a browser page never re-covers itself for a native swap");
  } finally {
    setLaunchLeaveCover(null);
  }
});

test("the curtain is raised only on iOS and never awaited past its fade", async () => {
  const launch = await source("../src/launch.ts");
  assert.match(launch, /nativeShell\(\) !== "ios"\) return false/);
  assert.match(launch, /autoHide: true,\s*showDuration: LAUNCH_CURTAIN_SAFETY_MS/);
  assert.match(launch, /void SplashScreen\.show\(/, "show() resolves only after its safety timeout");
  assert.match(launch, /LEAVE_COVER_BUDGET_MS/);
});

test("no page lifts the launch screen before its own veil is up", async () => {
  const [bridge, hub, runtime, main] = await Promise.all([
    source("../src/nativeBridge.ts"),
    source("../src/ConnectionScreen.tsx"),
    source("../src/runtime.ts"),
    source("../../web/src/main.tsx"),
  ]);
  assert.doesNotMatch(bridge, /@capacitor\/splash-screen/);
  assert.doesNotMatch(hub, /@capacitor\/splash-screen/);
  assert.doesNotMatch(hub, /SplashScreen\.hide/);
  assert.match(main, /launchVeil\.ready\(\)\.then\(\(\) => releaseLaunchCurtain\(\)\)/);
  assert.match(main, /setLaunchLeaveCover\(\(\) => launchVeil\.restore\(\)\)/);
  assert.match(main, /renderMobileConnection\(mobileLaunch, \{ veil: launchVeil \}\)/);
  // Leaving a page for the hub, or the hub for a server, covers the swap.
  assert.match(runtime, /await coverPageForLeave\(\)[\s\S]*?location\.replace\(mobileConnectionHubUrl/);
  assert.match(hub, /veil\.restore\(\{ from: brandMarkRef\.current \}\)[\s\S]*?raiseLaunchCurtain\([\s\S]*?location\.replace\(target\)/);
  // A launch that never left the page lifts the cover and shows the hub.
  assert.match(hub, /controller\?\.launchStalled\(next\.connectionId\);[\s\S]*?releaseLaunchCurtain\(\);[\s\S]*?veil\?\.lift\(/);
});
