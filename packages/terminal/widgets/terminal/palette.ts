// xterm 256-color palette resolution. Indexes 0–15 are theme-driven (CSS
// variables --term-a0..--term-a15 set by theme.ts), 16–231 the 6×6×6 cube,
// 232–255 the grayscale ramp. RGB-encoded colors come straight from the cell.
import { isRgbColor, rgbOf } from "./emulator.ts";

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const to2 = (n: number): string => n.toString(16).padStart(2, "0");

/** Hex color for palette indexes 16–255 (the theme owns 0–15). */
export function xterm256Hex(index: number): string {
  if (index < 16) return "#000000"; // callers route 0–15 through CSS vars
  if (index < 232) {
    const i = index - 16;
    const r = CUBE_LEVELS[Math.floor(i / 36)]!;
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6]!;
    const b = CUBE_LEVELS[i % 6]!;
    return `#${to2(r)}${to2(g)}${to2(b)}`;
  }
  const v = 8 + (index - 232) * 10;
  return `#${to2(v)}${to2(v)}${to2(v)}`;
}

/** CSS color for a cell color value: null = default (inherit). */
export function cellColorCss(color: number): string | null {
  if (color < 0) return null;
  if (isRgbColor(color)) {
    const v = rgbOf(color);
    return `#${to2((v >> 16) & 0xff)}${to2((v >> 8) & 0xff)}${to2(v & 0xff)}`;
  }
  if (color < 16) return `var(--term-a${color})`;
  return xterm256Hex(color);
}
