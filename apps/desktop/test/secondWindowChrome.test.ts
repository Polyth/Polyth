// Second windows wear the main window's chrome (no system title bar, caption
// controls in the page header) through a bridge that reaches only their own
// caption controls: secondWindowChrome.ts, secondWindowPreload.ts, main.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SECOND_WINDOW_CHANNELS, secondWindowSettings } from "../src/secondWindowChrome.ts";
import type { DesktopSettings } from "../src/types.ts";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("a second window reads only the settings its caption controls follow", () => {
  const settings: DesktopSettings = {
    closeToTray: true, startMinimized: false, launchAtLogin: true, keepAwake: true, keepAwakeMode: "always",
    automaticUpdates: true, updateChannel: "nightly", lowResourceMode: true, softwareRendering: true,
    reduceAnimations: true, controlsPosition: "left", controlsFollowSystem: false, controlsTheme: "dark",
  };
  assert.deepEqual(secondWindowSettings(settings), {
    controlsPosition: "left", controlsFollowSystem: false, controlsTheme: "dark", lowResourceMode: true, reduceAnimations: true,
  });
});

test("the second-window preload exposes its own small bridge, on its own channels only", async () => {
  const preload = await source("../src/secondWindowPreload.ts");
  const chrome = await source("../src/secondWindowChrome.ts");
  assert.match(preload, /exposeInMainWorld\("polythDesktopWindow"/);
  assert.doesNotMatch(preload, /exposeInMainWorld\("polythDesktop"[,)]/, "never the main window's bridge");
  // Every channel the preload names comes from the constant table, and every
  // entry there is a second-window channel.
  assert.doesNotMatch(preload, /["']desktop:/, "no literal channel names");
  for (const channel of Object.values(SECOND_WINDOW_CHANNELS)) assert.match(channel, /^desktop:second-window:/);
  // The sandboxed preload bundles the channel module: it must stay free of runtime imports.
  assert.doesNotMatch(chrome, /^import (?!type )/m);
});

test("main gives a second window the main window's chrome and that preload", async () => {
  const main = await source("../src/main.ts");
  const build = await source("../build.ts");
  const open = main.slice(main.indexOf("const openSecondWindow ="), main.indexOf("/** Just below and beside the window it came from"));
  assert.match(open, /\.\.\.desktopChromeOptions\(process\.platform,/);
  assert.match(open, /preload: join\(import\.meta\.dirname, "second-window-preload\.cjs"\)/);
  assert.match(open, /sandbox: true/);
  assert.match(open, /contextIsolation: true/);
  assert.match(open, /nodeIntegration: false/);
  assert.match(build, /src", "secondWindowPreload\.ts"\)\][\s\S]*?outfile: join\(dist, "second-window-preload\.cjs"\)/);
});

test("main answers second-window channels only from a second window's top frame, for that window", async () => {
  const main = await source("../src/main.ts");
  const guard = /const secondWindowHandle = [\s\S]*?\n  \};/.exec(main)?.[0] ?? "";
  assert.match(guard, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  assert.match(guard, /window === mainWindow/);
  assert.match(guard, /!isSecondWindowContents\(event\.sender\)/);
  assert.match(guard, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(guard, /throw new Error\("Untrusted second window IPC sender"\)/);
  for (const key of ["get", "action", "caption", "titlebar"]) {
    assert.match(main, new RegExp(`secondWindowHandle\\(SECOND_WINDOW_CHANNELS\\.${key},`), key);
  }
  // The main window's channels stay the main window's.
  assert.match(main, /if \(!mainWindow \|\| event\.sender !== mainWindow\.webContents\) throw new Error\("Untrusted desktop IPC sender"\)/);
});
