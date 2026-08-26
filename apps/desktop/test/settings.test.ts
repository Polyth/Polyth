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

test("desktop settings reject malformed persisted values", () => {
  assert.deepEqual(normalizeDesktopSettings({
    closeToTray: "yes",
    startMinimized: true,
    launchAtLogin: 1,
    keepAwake: "always",
    automaticUpdates: false,
    lowResourceMode: "tiny",
    reduceAnimations: "sometimes",
    controlsPosition: "middle",
    controlsTheme: "neon",
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
    automaticUpdates: false,
    lowResourceMode: true,
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
