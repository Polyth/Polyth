import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_POSITION,
  WINDOWS_CAPTION_HEIGHT,
  desktopChromeOptions,
  normalizeTitleBarAppearance,
  trayIconSize,
} from "../src/windowChrome.ts";

test("each platform keeps its own native caption controls", () => {
  const mac = desktopChromeOptions("darwin", true);
  assert.equal(mac.titleBarStyle, "hidden");
  assert.deepEqual(mac.trafficLightPosition, MACOS_TRAFFIC_LIGHT_POSITION);
  assert.equal(mac.frame, undefined);
  assert.equal(mac.transparent, false);

  const windows = desktopChromeOptions("win32", false);
  assert.equal(windows.titleBarStyle, "hidden");
  // Electron keeps each caption button 46 DIP wide and stretches it to the
  // overlay height: the overlay takes Windows' own caption height, not the
  // header's, so the buttons keep their native proportions.
  assert.equal(windows.titleBarOverlay?.height, WINDOWS_CAPTION_HEIGHT);
  assert.ok(WINDOWS_CAPTION_HEIGHT < DESKTOP_TITLEBAR_HEIGHT);
  assert.equal(windows.frame, undefined, "Windows keeps its native frame: Snap, shadow, rounded corners");
  assert.equal(windows.transparent, false);
  assert.equal(windows.backgroundColor, windows.titleBarOverlay?.color);

  const linux = desktopChromeOptions("linux", true);
  assert.equal(linux.frame, false);
  assert.equal(linux.transparent, true);
  assert.equal(linux.hasShadow, false);
  assert.equal(linux.titleBarOverlay, undefined);
});

test("traffic lights are centred on the header band", () => {
  const groupHeight = 14;
  const { y } = MACOS_TRAFFIC_LIGHT_POSITION;
  assert.ok(Math.abs((y + groupHeight / 2) - DESKTOP_TITLEBAR_HEIGHT / 2) <= 1);
});

test("title bar appearance from the renderer is validated and zoom-scaled", () => {
  assert.deepEqual(
    normalizeTitleBarAppearance({ color: "#191D25", symbolColor: "#e8eaf0", height: 51 }, 1.25),
    { color: "#191d25", symbolColor: "#e8eaf0", height: 64 },
  );
  // The renderer keeps the overlay's background transparent; glyphs stay opaque.
  assert.deepEqual(
    normalizeTitleBarAppearance({ color: "#F6F5F300", symbolColor: "#5e5e5e", height: 68 }, 1),
    { color: "#f6f5f300", symbolColor: "#5e5e5e", height: 68 },
  );
  assert.equal(normalizeTitleBarAppearance({ color: "#000000", symbolColor: "#ffffff" }, Number.NaN).height, WINDOWS_CAPTION_HEIGHT);
  // The caption height still fits at the 500 % zoom ceiling; absurd heights
  // stay bounded.
  assert.equal(normalizeTitleBarAppearance({ color: "#00000000", symbolColor: "#ffffff", height: WINDOWS_CAPTION_HEIGHT }, 5).height, 160);
  assert.equal(normalizeTitleBarAppearance({ color: "#000000", symbolColor: "#ffffff", height: 4000 }, 1).height, 160);
  assert.equal(normalizeTitleBarAppearance({ color: "#000000", symbolColor: "#ffffff", height: 1 }, 1).height, 28);
  for (const bad of [
    null,
    "#000000",
    { color: "red", symbolColor: "#ffffff" },
    { color: "#000000", symbolColor: "url(javascript:1)" },
    { color: "#0000", symbolColor: "#ffffff" },
    { color: "#0000000", symbolColor: "#ffffff" },
    { color: "#000000000", symbolColor: "#ffffff" },
    { color: "#000000", symbolColor: "#ffffff00" },
    { color: "#000000;background:red", symbolColor: "#ffffff" },
  ]) {
    assert.throws(() => normalizeTitleBarAppearance(bad, 1), /Invalid title bar colors/);
  }
});

test("tray glyph matches each platform's notification area", () => {
  assert.equal(trayIconSize("win32"), 16);
  assert.equal(trayIconSize("darwin"), 18);
  assert.equal(trayIconSize("linux"), 22);
});
