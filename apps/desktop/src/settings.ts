import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DesktopSettings } from "./types.ts";

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  closeToTray: true,
  startMinimized: false,
  launchAtLogin: false,
  keepAwake: false,
  automaticUpdates: true,
  lowResourceMode: false,
  reduceAnimations: false,
  controlsPosition: "right",
  controlsTheme: "system",
};

export function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    closeToTray: typeof raw.closeToTray === "boolean"
      ? raw.closeToTray
      : DEFAULT_DESKTOP_SETTINGS.closeToTray,
    startMinimized: typeof raw.startMinimized === "boolean"
      ? raw.startMinimized
      : DEFAULT_DESKTOP_SETTINGS.startMinimized,
    launchAtLogin: typeof raw.launchAtLogin === "boolean"
      ? raw.launchAtLogin
      : DEFAULT_DESKTOP_SETTINGS.launchAtLogin,
    keepAwake: typeof raw.keepAwake === "boolean"
      ? raw.keepAwake
      : DEFAULT_DESKTOP_SETTINGS.keepAwake,
    automaticUpdates: typeof raw.automaticUpdates === "boolean"
      ? raw.automaticUpdates
      : DEFAULT_DESKTOP_SETTINGS.automaticUpdates,
    lowResourceMode: typeof raw.lowResourceMode === "boolean"
      ? raw.lowResourceMode
      : DEFAULT_DESKTOP_SETTINGS.lowResourceMode,
    reduceAnimations: typeof raw.reduceAnimations === "boolean"
      ? raw.reduceAnimations
      : DEFAULT_DESKTOP_SETTINGS.reduceAnimations,
    controlsPosition: raw.controlsPosition === "left" || raw.controlsPosition === "right"
      ? raw.controlsPosition
      : DEFAULT_DESKTOP_SETTINGS.controlsPosition,
    controlsTheme: raw.controlsTheme === "dark" || raw.controlsTheme === "light" || raw.controlsTheme === "system"
      ? raw.controlsTheme
      : DEFAULT_DESKTOP_SETTINGS.controlsTheme,
  };
}

export async function readDesktopSettings(path: string): Promise<DesktopSettings> {
  try {
    return normalizeDesktopSettings(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_DESKTOP_SETTINGS };
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export function readDesktopSettingsSync(path: string): DesktopSettings {
  try {
    return normalizeDesktopSettings(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
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
