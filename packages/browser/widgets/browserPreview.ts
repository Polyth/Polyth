export const BROWSER_DEVICE_PRESETS = [
  /** 0×0 means “follow the pane”; never treat this as a fixed viewport. */
  { id: "responsive", labelKey: "browserpreview.responsive", width: 0, height: 0 },
  { id: "iphone-14", labelKey: "browserpreview.iphone14", width: 390, height: 844 },
  { id: "pixel-7", labelKey: "browserpreview.pixel7", width: 412, height: 915 },
  { id: "ipad-mini", labelKey: "browserpreview.ipadMini", width: 768, height: 1024 },
  { id: "laptop", labelKey: "browserpreview.laptop", width: 1366, height: 768 },
  { id: "desktop", labelKey: "browserpreview.desktop", width: 1440, height: 900 },
] as const;

export type BrowserDevicePresetId = typeof BROWSER_DEVICE_PRESETS[number]["id"];
export type ViewportUiMode = "responsive" | "preset" | "custom";

/** Normalized 0–1 selection on the letterboxed frame. */
export interface NormRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserPointedElement {
  selector: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  rect: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
  editable?: boolean;
}

export interface ImageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number, min = 0, max = 1): number =>
  Math.max(min, Math.min(max, value));

/** Compact label for the selected-element editor — never dump page-sized text. */
export function browserPointedElementLabel(
  element: Pick<BrowserPointedElement, "name" | "text" | "selector">,
  maxLength = 120,
): string {
  const raw = (element.name || element.text || element.selector).replace(/\s+/g, " ").trim();
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Approval errors carry a stable code; message fallback covers older servers. */
export function browserApprovalRequired(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "approval-required") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("approval-required") || /\bneeds\b.*\bapproval\b/i.test(message);
}

export function namedPresetForViewport(width: number, height: number): Exclude<BrowserDevicePresetId, "responsive"> | null {
  const match = BROWSER_DEVICE_PRESETS.find((preset) =>
    preset.id !== "responsive" && preset.width === width && preset.height === height
  );
  return match ? match.id as Exclude<BrowserDevicePresetId, "responsive"> : null;
}

/** @deprecated Prefer namedPresetForViewport — unmatched sizes are custom, not responsive. */
export function devicePresetForViewport(width: number, height: number): BrowserDevicePresetId {
  return namedPresetForViewport(width, height) ?? "responsive";
}

const viewportModeMemory = new Map<string, ViewportUiMode>();

export function rememberViewportMode(browserId: string, mode: ViewportUiMode): void {
  viewportModeMemory.set(browserId, mode);
  try { sessionStorage.setItem(`polyth.browser.viewportMode.${browserId}`, mode); } catch { /* private mode */ }
}

export function recalledViewportMode(browserId: string): ViewportUiMode {
  const mem = viewportModeMemory.get(browserId);
  if (mem) return mem;
  try {
    const raw = sessionStorage.getItem(`polyth.browser.viewportMode.${browserId}`);
    if (raw === "responsive" || raw === "preset" || raw === "custom") {
      viewportModeMemory.set(browserId, raw);
      return raw;
    }
  } catch { /* ignore */ }
  return "responsive";
}

/** Host + path for compact chrome; full URL stays available on edit. */
export function compactPageIdentity(url: string): string {
  try {
    const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
    const parsed = new URL(raw);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const id = `${parsed.host}${path}`;
    return id.length > 42 ? `${id.slice(0, 41)}…` : id;
  } catch {
    return url;
  }
}

/** Coalesce pointer/wheel deltas so one rAF flush sends a single scroll action. */
export function mergeScrollDelta(
  pending: { x: number; y: number } | null,
  dx: number,
  dy: number,
): { x: number; y: number } {
  if (!pending) return { x: dx, y: dy };
  return { x: pending.x + dx, y: pending.y + dy };
}

/** Bounds of an object-fit:contain image inside its element. */
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

export const VIEWPORT_WIDTH_MIN = 320;
export const VIEWPORT_WIDTH_MAX = 3840;
export const VIEWPORT_HEIGHT_MIN = 240;
export const VIEWPORT_HEIGHT_MAX = 2160;

export function clampViewport(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(VIEWPORT_WIDTH_MIN, Math.min(width, VIEWPORT_WIDTH_MAX)),
    height: Math.max(VIEWPORT_HEIGHT_MIN, Math.min(height, VIEWPORT_HEIGHT_MAX)),
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

/** Normalize a drag selection and clamp it to the object-fit image bounds. */
export function normalizedRectInImage(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: ImageRect,
): NormRect | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const left = clamp(Math.min(start.x, end.x), rect.left, rect.left + rect.width);
  const top = clamp(Math.min(start.y, end.y), rect.top, rect.top + rect.height);
  const right = clamp(Math.max(start.x, end.x), rect.left, rect.left + rect.width);
  const bottom = clamp(Math.max(start.y, end.y), rect.top, rect.top + rect.height);
  if (right - left < 4 || bottom - top < 4) return null;
  return {
    x: (left - rect.left) / rect.width,
    y: (top - rect.top) / rect.height,
    width: (right - left) / rect.width,
    height: (bottom - top) / rect.height,
  };
}

export function annotationViewportRect(
  annotation: NormRect,
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.round(clamp(annotation.x) * viewport.width);
  const y = Math.round(clamp(annotation.y) * viewport.height);
  const right = Math.round(clamp(annotation.x + annotation.width) * viewport.width);
  const bottom = Math.round(clamp(annotation.y + annotation.height) * viewport.height);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

/** Map a compositor keydown to a Playwright-style key chord. */
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
  return null;
}

/** Best-effort parse of click/press hit-test metadata from a browser action. */
export function pointedFromActionResult(result: unknown): BrowserPointedElement | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const raw = result as Record<string, unknown>;
  if (typeof raw.tag !== "string") return null;
  const box = raw.rect && typeof raw.rect === "object" && !Array.isArray(raw.rect)
    ? raw.rect as Record<string, unknown>
    : null;
  if (!box || !Number.isFinite(Number(box.x)) || !Number.isFinite(Number(box.y))) return null;
  const attributes = raw.attributes && typeof raw.attributes === "object" && !Array.isArray(raw.attributes)
    ? Object.fromEntries(
      Object.entries(raw.attributes as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
    : undefined;
  return {
    selector: typeof raw.selector === "string" ? raw.selector : "",
    tag: raw.tag,
    ...(typeof raw.role === "string" ? { role: raw.role } : {}),
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    rect: {
      x: Number(box.x),
      y: Number(box.y),
      width: Number(box.width) || 0,
      height: Number(box.height) || 0,
    },
    ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
    ...(raw.editable === true || raw.editable === false ? { editable: raw.editable } : {}),
  };
}

/** Map an element pixel rect into a normalized frame highlight. */
export function elementHighlightRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): NormRect {
  const x = Math.max(0, rect.x) / viewport.width;
  const y = Math.max(0, rect.y) / viewport.height;
  return {
    x,
    y,
    width: Math.min(viewport.width - Math.max(0, rect.x), Math.max(1, rect.width)) / viewport.width,
    height: Math.min(viewport.height - Math.max(0, rect.y), Math.max(1, rect.height)) / viewport.height,
  };
}
