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

test("an iOS server page WebKit killed and could not reload goes to the hub, not a blank WebView", async () => {
  const scene = await source("../ios/App/App/SceneDelegate.swift");
  // Installed in front of Capacitor's delegate before the first page loads.
  assert.match(scene, /override func capacitorDidLoad\(\) \{\s*super\.capacitorDidLoad\(\)[\s\S]*?PolythPageRecovery\(forwardingTo: capacitor\)[\s\S]*?webView\.navigationDelegate = recovery[\s\S]*?registerPluginInstance\(PolythLinkPlugin\(\)\)/);
  // Everything else still reaches Capacitor.
  assert.match(scene, /override func forwardingTarget\(for aSelector: Selector!\) -> Any\? \{\s*capacitor\.responds\(to: aSelector\) \? capacitor/);
  assert.match(scene, /capacitor\.webViewWebContentProcessDidTerminate\?\(webView\)/);
  assert.match(scene, /capacitor\.webView\?\(webView, didFailProvisionalNavigation: navigation, withError: error\)\s*guard serverPageLost, !Self\.superseded\(error\)/);
  // Only a lost Link proxy page, and only once per loss.
  assert.match(scene, /serverPageLost = webView\.url\?\.scheme\?\.lowercased\(\) == "http" && webView\.url\?\.host == "127\.0\.0\.1"/);
  assert.match(scene, /URL\(string: "capacitor:\/\/localhost\?resume=1"\)[\s\S]*?serverPageLost = false\s*webView\.load/);
});
