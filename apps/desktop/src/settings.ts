import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeKeepAwakeMode } from "./keepAwake.ts";
import type { DesktopSettings } from "./types.ts";

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  closeToTray: true,
  startMinimized: false,
  launchAtLogin: false,
  keepAwake: false,
  keepAwakeMode: "working",
  automaticUpdates: true,
  updateChannel: "stable",
  lowResourceMode: false,
  softwareRendering: false,
  reduceAnimations: false,
  controlsPosition: "right",
  controlsTheme: "system",
};

const UPDATE_CHANNELS = new Set<unknown>(["stable", "test", "nightly"]);

/** `defaults` lets the caller supply the running build's own update channel. */
export function normalizeDesktopSettings(value: unknown, defaults: DesktopSettings = DEFAULT_DESKTOP_SETTINGS): DesktopSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    closeToTray: typeof raw.closeToTray === "boolean"
      ? raw.closeToTray
      : defaults.closeToTray,
    startMinimized: typeof raw.startMinimized === "boolean"
      ? raw.startMinimized
      : defaults.startMinimized,
    launchAtLogin: typeof raw.launchAtLogin === "boolean"
      ? raw.launchAtLogin
      : defaults.launchAtLogin,
    keepAwake: typeof raw.keepAwake === "boolean"
      ? raw.keepAwake
      : defaults.keepAwake,
    keepAwakeMode: normalizeKeepAwakeMode(raw, defaults.keepAwakeMode),
    automaticUpdates: typeof raw.automaticUpdates === "boolean"
      ? raw.automaticUpdates
      : defaults.automaticUpdates,
    updateChannel: UPDATE_CHANNELS.has(raw.updateChannel)
      ? raw.updateChannel as DesktopSettings["updateChannel"]
      : defaults.updateChannel,
    lowResourceMode: typeof raw.lowResourceMode === "boolean"
      ? raw.lowResourceMode
      : defaults.lowResourceMode,
    softwareRendering: typeof raw.softwareRendering === "boolean"
      ? raw.softwareRendering
      : defaults.softwareRendering,
    reduceAnimations: typeof raw.reduceAnimations === "boolean"
      ? raw.reduceAnimations
      : defaults.reduceAnimations,
    controlsPosition: raw.controlsPosition === "left" || raw.controlsPosition === "right"
      ? raw.controlsPosition
      : defaults.controlsPosition,
    controlsTheme: raw.controlsTheme === "dark" || raw.controlsTheme === "light" || raw.controlsTheme === "system"
      ? raw.controlsTheme
      : defaults.controlsTheme,
  };
}

export async function readDesktopSettings(path: string, defaults: DesktopSettings = DEFAULT_DESKTOP_SETTINGS): Promise<DesktopSettings> {
  try {
    return normalizeDesktopSettings(JSON.parse(await readFile(path, "utf8")) as unknown, defaults);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    return { ...defaults };
  }
}

export function readDesktopSettingsSync(path: string, defaults: DesktopSettings = DEFAULT_DESKTOP_SETTINGS): DesktopSettings {
  try {
    return normalizeDesktopSettings(JSON.parse(readFileSync(path, "utf8")) as unknown, defaults);
  } catch {
    return { ...defaults };
  }
}

export async function writeDesktopSettings(path: string, settings: DesktopSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
