// Device-local touch-terminal preferences. These are presentation choices for
// one device (pinch zoom, the extra-keys layout, bar visibility, bell
// vibration), so they live in localStorage and never in session history.
import { useSyncExternalStore } from "react";
import { parseExtraKeys } from "./extraKeys.ts";

export interface TerminalTouchPrefs {
  /** Pinch-zoom font size in px; null follows Appearance › Terminal font size. */
  fontSize: number | null;
  /** Termux `extra-keys` syntax; null is the Termux default layout. */
  extraKeys: string | null;
  /** "auto" shows the bar for coarse pointers only. */
  extraKeysVisible: "auto" | "on" | "off";
  bellVibrate: boolean;
}

export const TERMINAL_TOUCH_PREFS_KEY = "polyth.terminal.touch.v1";
export const MIN_TERMINAL_FONT = 6;
export const MAX_TERMINAL_FONT = 40;

const DEFAULTS: TerminalTouchPrefs = { fontSize: null, extraKeys: null, extraKeysVisible: "auto", bellVibrate: true };

export const clampFontSize = (px: number): number =>
  Math.max(MIN_TERMINAL_FONT, Math.min(MAX_TERMINAL_FONT, Math.round(px)));

export function normalizeTouchPrefs(raw: unknown): TerminalTouchPrefs {
  if (!raw || typeof raw !== "object") return DEFAULTS;
  const data = raw as Record<string, unknown>;
  const fontSize = typeof data.fontSize === "number" && Number.isFinite(data.fontSize) ? clampFontSize(data.fontSize) : null;
  const extraKeys = typeof data.extraKeys === "string" && parseExtraKeys(data.extraKeys).ok ? data.extraKeys : null;
  const extraKeysVisible = data.extraKeysVisible === "on" || data.extraKeysVisible === "off" ? data.extraKeysVisible : "auto";
  const bellVibrate = typeof data.bellVibrate === "boolean" ? data.bellVibrate : true;
  return { fontSize, extraKeys, extraKeysVisible, bellVibrate };
}

let current: TerminalTouchPrefs | null = null;
const listeners = new Set<() => void>();

function read(): TerminalTouchPrefs {
  if (current) return current;
  try {
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(TERMINAL_TOUCH_PREFS_KEY);
    current = normalizeTouchPrefs(stored ? JSON.parse(stored) : null);
  } catch {
    current = DEFAULTS;
  }
  return current;
}

export function getTouchPrefs(): TerminalTouchPrefs {
  return read();
}

export function updateTouchPrefs(patch: Partial<TerminalTouchPrefs>): void {
  const next = normalizeTouchPrefs({ ...read(), ...patch });
  current = next;
  try { localStorage.setItem(TERMINAL_TOUCH_PREFS_KEY, JSON.stringify(next)); } catch { /* best effort */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TERMINAL_TOUCH_PREFS_KEY) return;
    current = null;
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useTouchPrefs(): TerminalTouchPrefs {
  return useSyncExternalStore(subscribe, read, () => DEFAULTS);
}

/** Test seam: forget the cached value so the next read hits storage. */
export function resetTouchPrefsCache(): void {
  current = null;
}
