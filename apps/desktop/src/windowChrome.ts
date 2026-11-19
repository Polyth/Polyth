import type { DesktopTitleBarAppearance } from "./types.ts";

/** Height of the renderer's desktop header in CSS px. The macOS traffic
 *  lights and Polyth's Linux buttons are centred on this band, so it is the
 *  geometry contract between main and renderer (`--desktop-titlebar-h`);
 *  Windows keeps its own caption height (WINDOWS_CAPTION_HEIGHT). */
export const DESKTOP_TITLEBAR_HEIGHT = 52;

/** Height of the native Windows caption buttons in CSS px: Windows 11's
 *  standard 32 px caption. Electron keeps each overlay button 46 DIP wide and
 *  stretches it to the full overlay height, so the overlay is never as tall as
 *  the header: at 52–84 px the buttons read as tall slabs. They sit flush in
 *  the window's top corner, as in every native Windows app. Mirrored by the
 *  renderer's Windows `--desktop-caption-h` (styles.css). */
export const WINDOWS_CAPTION_HEIGHT = 32;

/** The traffic-light group in DIP. Electron exposes where the group starts
 *  (getWindowButtonPosition) but not its size, so the size is the one thing
 *  assumed here; the position is always read back from the window. */
export interface MacTrafficLightGroup {
  width: number;
  height: number;
}

/** Up to macOS 15: three 14 pt buttons on a 20 pt pitch. */
export const MACOS_TRAFFIC_LIGHT_GROUP: Readonly<MacTrafficLightGroup> = Object.freeze({ width: 54, height: 14 });

/** macOS 26 and later draw larger window buttons for an app linked against
 *  their SDK, as Electron is: 16 pt lights in 18 pt buttons on a 25 pt pitch.
 *  Measured on a real window, where the 54×14 group above left the lights
 *  2 pt below the header's centre line and reaching 14 pt further right than
 *  the caption zone allowed, so the first header control sat against them. */
export const MACOS_26_TRAFFIC_LIGHT_GROUP: Readonly<MacTrafficLightGroup> = Object.freeze({ width: 68, height: 18 });

/** The group this macOS draws, from `process.getSystemVersion()`. A build
 *  linked against an older SDK reads 16.x there on macOS 26 and keeps the
 *  smaller buttons, so the version says both things at once. */
export function macTrafficLightGroup(systemVersion: unknown): Readonly<MacTrafficLightGroup> {
  const major = typeof systemVersion === "string" ? Number.parseInt(systemVersion, 10) : Number.NaN;
  return Number.isFinite(major) && major >= 26 ? MACOS_26_TRAFFIC_LIGHT_GROUP : MACOS_TRAFFIC_LIGHT_GROUP;
}

/** The traffic lights' edge inset in DIP: the same 18 px the header content
 *  uses. */
const MACOS_TRAFFIC_LIGHT_X = 18;

/** Centre the group on the header band and keep the header's edge inset. */
export const MACOS_TRAFFIC_LIGHT_POSITION = Object.freeze({
  x: MACOS_TRAFFIC_LIGHT_X,
  y: Math.round((DESKTOP_TITLEBAR_HEIGHT - MACOS_TRAFFIC_LIGHT_GROUP.height) / 2),
});

const pageZoom = (zoomFactor: number): number => Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;

/**
 * Where to put the traffic lights for a caption band of `band` CSS px. The
 * lights are drawn by the OS in DIP and do not scale with page zoom, while the
 * band does: centring in DIP keeps them on the header's centre line at every
 * zoom level. The edge inset stays the native 18 pt. `group` is the size this
 * macOS draws (macTrafficLightGroup).
 */
export function macTrafficLightPosition(
  band: unknown,
  zoomFactor: number,
  group: Readonly<MacTrafficLightGroup> = MACOS_TRAFFIC_LIGHT_GROUP,
): { x: number; y: number } {
  const zoom = pageZoom(zoomFactor);
  const css = typeof band === "number" && Number.isFinite(band) && band > 0 ? Math.min(band, 200) : DESKTOP_TITLEBAR_HEIGHT;
  const y = Math.round((css * zoom - group.height) / 2);
  return { x: MACOS_TRAFFIC_LIGHT_X, y: Math.max(0, Math.min(y, 160)) };
}

/** The traffic-light group as the page sees it: the window's applied position
 *  (DIP) converted to CSS px, so the renderer's caption zone matches the real
 *  buttons at any page zoom. */
export function macCaptionGeometry(
  position: { x: number; y: number } | null,
  zoomFactor: number,
  group: Readonly<MacTrafficLightGroup> = MACOS_TRAFFIC_LIGHT_GROUP,
): { x: number; y: number; width: number; height: number } {
  const zoom = pageZoom(zoomFactor);
  const at = position ?? macTrafficLightPosition(DESKTOP_TITLEBAR_HEIGHT, 1, group);
  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    x: round(at.x / zoom),
    y: round(at.y / zoom),
    width: round(group.width / zoom),
    height: round(group.height / zoom),
  };
}

export interface DesktopChromeOptions {
  titleBarStyle?: "hidden";
  trafficLightPosition?: { x: number; y: number };
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
  frame?: false;
  transparent: boolean;
  hasShadow: boolean;
  backgroundColor: string;
}

/**
 * Window chrome per platform.
 *
 * - macOS: hidden title bar, OS-drawn traffic lights centred on the header
 *   (`systemVersion` picks the size the lights are drawn at).
 * - Windows: hidden title bar with the native Window Controls Overlay, so the
 *   caption buttons, Snap Layouts flyout, rounded corners, and shadow stay the
 *   operating system's own, at its standard caption height.
 * - Linux: frameless and transparent; the renderer clips the rounded sheet and
 *   paints Polyth's caption buttons (CSD has no native control overlay that
 *   matches GNOME/KDE).
 */
export function desktopChromeOptions(platform: NodeJS.Platform, dark: boolean, systemVersion?: string): DesktopChromeOptions {
  const backgroundColor = dark ? "#121110" : "#f6f5f3";
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: macTrafficLightPosition(DESKTOP_TITLEBAR_HEIGHT, 1, macTrafficLightGroup(systemVersion)),
      transparent: false,
      hasShadow: true,
      backgroundColor,
    };
  }
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: backgroundColor,
        symbolColor: dark ? "#e7e9ed" : "#25282d",
        height: WINDOWS_CAPTION_HEIGHT,
      },
      transparent: false,
      hasShadow: true,
      backgroundColor,
    };
  }
  // Linux CSD does not round a frameless window. A transparent host lets
  // renderer CSS clip .app to --radius-sheet; the native shadow is disabled
  // so it cannot paint a square halo around the clip.
  return { frame: false, transparent: true, hasShadow: false, backgroundColor: "#00000000" };
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** The overlay background may carry alpha (`#rrggbbaa`): the renderer sends it
 *  fully transparent so Windows paints only the caption glyphs over the
 *  renderer's own surface. The glyphs themselves stay opaque. */
const HEX_COLOR_WITH_ALPHA = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

/** The tallest overlay main accepts, in DIP: the caption height at the 500 %
 *  page-zoom ceiling. */
const TITLEBAR_OVERLAY_MAX_HEIGHT = 160;

/** Validate a renderer-reported title bar appearance. `height` arrives in CSS
 *  px and is converted to DIP with the page zoom factor. */
export function normalizeTitleBarAppearance(value: unknown, zoomFactor: number): { color: string; symbolColor: string; height: number } {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof DesktopTitleBarAppearance, unknown>>
    : {};
  const color = typeof raw.color === "string" ? raw.color.trim() : "";
  const symbolColor = typeof raw.symbolColor === "string" ? raw.symbolColor.trim() : "";
  if (!HEX_COLOR_WITH_ALPHA.test(color) || !HEX_COLOR.test(symbolColor)) throw new Error("Invalid title bar colors");
  const height = typeof raw.height === "number" && Number.isFinite(raw.height) ? raw.height : WINDOWS_CAPTION_HEIGHT;
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    color: color.toLowerCase(),
    symbolColor: symbolColor.toLowerCase(),
    height: Math.min(TITLEBAR_OVERLAY_MAX_HEIGHT, Math.max(28, Math.round(height * zoom))),
  };
}

/** Tray glyph size per platform: Windows notification area is 16 px, the
 *  macOS menu bar 18 pt, and Linux status notifiers render 22 px. */
export function trayIconSize(platform: NodeJS.Platform): number {
  if (platform === "win32") return 16;
  if (platform === "darwin") return 18;
  return 22;
}
