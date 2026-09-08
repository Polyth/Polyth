export interface ImageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const VIEWPORT_WIDTH_MIN = 320;
export const VIEWPORT_HEIGHT_MIN = 240;
export const VIEWPORT_RESIZE_DEBOUNCE_MS = 150;

const clamp = (value: number, min = 0, max = 1): number =>
  Math.max(min, Math.min(max, value));

export function clampViewport(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(VIEWPORT_WIDTH_MIN, Math.round(width)),
    height: Math.max(VIEWPORT_HEIGHT_MIN, Math.round(height)),
  };
}

export function containedImageRect(
  elementWidth: number,
  elementHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ImageRect {
  if (elementWidth <= 0 || elementHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(elementWidth / sourceWidth, elementHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    left: (elementWidth - width) / 2,
    top: (elementHeight - height) / 2,
    width,
    height,
  };
}

export function normalizedPointInImage(
  x: number,
  y: number,
  rect: ImageRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (x < rect.left || y < rect.top || x > rect.left + rect.width || y > rect.top + rect.height) return null;
  return {
    x: clamp((x - rect.left) / rect.width),
    y: clamp((y - rect.top) / rect.height),
  };
}

/** Map a normalized image point to page CSS pixels. */
export function pagePointFromNormalized(
  norm: { x: number; y: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.round(norm.x * viewport.width),
    y: Math.round(norm.y * viewport.height),
  };
}

export function compactDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

export function pressKeyFromEvent(event: { key: string; shiftKey?: boolean }): string | null {
  if (event.key === "Escape") return "Escape";
  if (event.key === "Enter") return "Enter";
  if (event.key === "Backspace") return "Backspace";
  if (event.key === "Delete") return "Delete";
  if (event.key === "Tab") return event.shiftKey ? "Shift+Tab" : "Tab";
  if (event.key === "ArrowUp") return "ArrowUp";
  if (event.key === "ArrowDown") return "ArrowDown";
  if (event.key === "ArrowLeft") return "ArrowLeft";
  if (event.key === "ArrowRight") return "ArrowRight";
  if (event.key === "Home") return "Home";
  if (event.key === "End") return "End";
  if (event.key.length === 1) return event.key;
  return null;
}

export function modifiersFromEvent(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  const mods: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
  if (event.altKey) mods.push("Alt");
  if (event.ctrlKey) mods.push("Control");
  if (event.metaKey) mods.push("Meta");
  if (event.shiftKey) mods.push("Shift");
  return mods;
}
