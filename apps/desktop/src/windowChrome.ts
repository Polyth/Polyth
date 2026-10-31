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

/** macOS traffic lights are a 14 px tall group; centre it on the header band
 *  and keep the same 18 px edge inset the header content uses. */
export const MACOS_TRAFFIC_LIGHT_POSITION = Object.freeze({
  x: 18,
  y: Math.round((DESKTOP_TITLEBAR_HEIGHT - 14) / 2),
});

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
 * - macOS: hidden title bar, OS-drawn traffic lights centred on the header.
 * - Windows: hidden title bar with the native Window Controls Overlay, so the
 *   caption buttons, Snap Layouts flyout, rounded corners, and shadow stay the
 *   operating system's own, at its standard caption height.
 * - Linux: frameless and transparent; the renderer clips the rounded sheet and
 *   paints Polyth's caption buttons (CSD has no native control overlay that
 *   matches GNOME/KDE).
 */
export function desktopChromeOptions(platform: NodeJS.Platform, dark: boolean): DesktopChromeOptions {
  const backgroundColor = dark ? "#121110" : "#f6f5f3";
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: { ...MACOS_TRAFFIC_LIGHT_POSITION },
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
