import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_DESKTOP_SETTINGS,
  normalizeDesktopSettings,
  readDesktopSettings,
  readDesktopSettingsSync,
  writeDesktopSettings,
} from "../src/settings.ts";
import { keepAwakeWanted } from "../src/keepAwake.ts";

test("desktop settings reject malformed persisted values", () => {
  assert.deepEqual(normalizeDesktopSettings({
    closeToTray: "yes",
    startMinimized: true,
    launchAtLogin: 1,
    keepAwake: "always",
    automaticUpdates: false,
    lowResourceMode: "tiny",
    softwareRendering: "auto",
    reduceAnimations: "sometimes",
    controlsPosition: "middle",
    controlsTheme: "neon",
    updateChannel: "beta",
  }), {
    ...DEFAULT_DESKTOP_SETTINGS,
    startMinimized: true,
    automaticUpdates: false,
  });
});

test("desktop settings round-trip atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-desktop-settings-"));
  const path = join(dir, "nested", "settings.json");
  const expected = {
    closeToTray: false,
    startMinimized: true,
    launchAtLogin: true,
    keepAwake: true,
    keepAwakeMode: "working" as const,
    automaticUpdates: false,
    updateChannel: "nightly" as const,
    lowResourceMode: true,
    softwareRendering: true,
    reduceAnimations: true,
    controlsPosition: "left" as const,
    controlsTheme: "light" as const,
  };
  await writeDesktopSettings(path, expected);
  assert.deepEqual(await readDesktopSettings(path), expected);
  assert.deepEqual(readDesktopSettingsSync(path), expected);
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
});

test("missing desktop settings use safe defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-desktop-missing-"));
  assert.deepEqual(await readDesktopSettings(join(dir, "missing.json")), DEFAULT_DESKTOP_SETTINGS);
});

test("the update channel defaults to the running build's channel", async () => {
  const defaults = { ...DEFAULT_DESKTOP_SETTINGS, updateChannel: "nightly" as const };
  assert.equal(normalizeDesktopSettings({}, defaults).updateChannel, "nightly");
  assert.equal(normalizeDesktopSettings({ updateChannel: "test" }, defaults).updateChannel, "test");
  const dir = await mkdtemp(join(tmpdir(), "polyth-desktop-settings-"));
  assert.equal((await readDesktopSettings(join(dir, "missing.json"), defaults)).updateChannel, "nightly");
});

test("keep-awake defaults to working-only, and an older enabled setting keeps holding it always", () => {
  assert.equal(DEFAULT_DESKTOP_SETTINGS.keepAwakeMode, "working");
  assert.equal(normalizeDesktopSettings({ keepAwake: false }).keepAwakeMode, "working");
  assert.equal(normalizeDesktopSettings({ keepAwake: true }).keepAwakeMode, "always", "a file from before modes meant always");
  assert.equal(normalizeDesktopSettings({ keepAwake: true, keepAwakeMode: "working" }).keepAwakeMode, "working");
  assert.equal(normalizeDesktopSettings({ keepAwake: false, keepAwakeMode: "always" }).keepAwakeMode, "always");
  assert.equal(normalizeDesktopSettings({ keepAwakeMode: "nap" }).keepAwakeMode, "working");
});

test("the blocker is held only when keep-awake is on and its mode asks for it", () => {
  const on = (keepAwakeMode: "working" | "always") => ({ keepAwake: true, keepAwakeMode });
  assert.equal(keepAwakeWanted(on("working"), true), true);
  assert.equal(keepAwakeWanted(on("working"), false), false, "idle agents let the machine sleep");
  assert.equal(keepAwakeWanted(on("always"), false), true);
  assert.equal(keepAwakeWanted({ keepAwake: false, keepAwakeMode: "always" }, true), false);
});

test("low-resource mode does not imply software rendering", () => {
  assert.equal(DEFAULT_DESKTOP_SETTINGS.softwareRendering, false);
  const migrated = normalizeDesktopSettings({ lowResourceMode: true });
  assert.equal(migrated.lowResourceMode, true);
  assert.equal(migrated.softwareRendering, false);
});
