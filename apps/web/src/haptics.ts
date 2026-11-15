// Bounded haptics for consequential touch actions and a few live events.
// Unsupported platforms (notably iOS Safari) simply get nothing. Haptics are
// independent from motion preferences; never use this for hover, scroll,
// typing, replay, or streaming.
//
// Two paths, one per-device switch (`HapticsMode`, kept in localStorage: a
// motor belongs to one device, so the choice is never synced):
// - hapticFeedback() and its helpers follow a completed local action;
// - eventHaptic() is the only path for live events (a turn finished, an agent
//   waits, a person wrote). Feed it discrete, already-deduplicated events; it
//   stays silent off screen and lets one vibration stand for a burst.
export type HapticKind = "selection" | "tap" | "success" | "warning" | "error";
export const NATIVE_HAPTIC_EVENT = "polyth:native-haptic";

/** off: never. touch: local actions only. all: local actions and live events. */
export type HapticsMode = "off" | "touch" | "all";
export const HAPTICS_MODES: readonly HapticsMode[] = ["off", "touch", "all"];
export const HAPTICS_MODE_KEY = "polyth.haptics";
const DEFAULT_HAPTICS_MODE: HapticsMode = "all";

const PATTERNS: Record<HapticKind, number | number[]> = {
  selection: 5,
  tap: 8,
  success: [8, 32, 8],
  warning: [12, 42, 12],
  error: [18, 34, 18],
};

/** Events closer together than this count as one burst. */
export const EVENT_HAPTIC_BURST_MS = 700;
const STRENGTH: Record<HapticKind, number> = { selection: 0, tap: 1, success: 2, warning: 3, error: 4 };

let mode: HapticsMode | null = null;
const modeListeners = new Set<() => void>();
let lastEvent = { at: Number.NEGATIVE_INFINITY, strength: -1 };

function readStoredMode(): HapticsMode {
  try {
    const raw = globalThis.localStorage?.getItem(HAPTICS_MODE_KEY);
    return HAPTICS_MODES.includes(raw as HapticsMode) ? raw as HapticsMode : DEFAULT_HAPTICS_MODE;
  } catch {
    return DEFAULT_HAPTICS_MODE;
  }
}

export function getHapticsMode(): HapticsMode {
  mode ??= readStoredMode();
  return mode;
}

export function setHapticsMode(next: HapticsMode): void {
  if (!HAPTICS_MODES.includes(next) || next === getHapticsMode()) return;
  mode = next;
  try { globalThis.localStorage?.setItem(HAPTICS_MODE_KEY, next); } catch { /* private mode */ }
  for (const listener of [...modeListeners]) listener();
}

export function subscribeHapticsMode(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => { modeListeners.delete(listener); };
}

function nativeShell(): boolean {
  return typeof document !== "undefined"
    && /^(?:android|ios)$/.test(document.body?.dataset.nativePlatform ?? "");
}

/** Whether this device can vibrate at all. Desktop Chromium exposes
 *  `navigator.vibrate` without a motor, so a browser counts only when touch is
 *  its primary input. */
export function hapticsSupported(): boolean {
  if (nativeShell()) return true;
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return false;
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

function play(kind: HapticKind): void {
  if (nativeShell()) {
    window.dispatchEvent(new CustomEvent(NATIVE_HAPTIC_EVENT, { detail: kind }));
    return;
  }
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    // A vibration is never worth an error.
  }
}

export function hapticFeedback(kind: HapticKind = "tap"): void {
  if (getHapticsMode() === "off") return;
  play(kind);
}

/** A live event the person may be waiting for. Plays only while the page is on
 *  screen (in the background the push notification speaks for it) and only
 *  when the switch allows events; within one burst a later event plays only if
 *  it is stronger, so five finished subagents buzz once. Returns whether it
 *  played. */
export function eventHaptic(kind: HapticKind, now = Date.now()): boolean {
  if (getHapticsMode() !== "all") return false;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  if (now - lastEvent.at < EVENT_HAPTIC_BURST_MS && STRENGTH[kind] <= lastEvent.strength) return false;
  lastEvent = { at: now, strength: STRENGTH[kind] };
  play(kind);
  return true;
}

export function selectionFeedback(): void {
  hapticFeedback("selection");
}

export function tapFeedback(): void {
  hapticFeedback("tap");
}

export function successFeedback(): void {
  hapticFeedback("success");
}

export function warningFeedback(): void {
  hapticFeedback("warning");
}

export function errorFeedback(): void {
  hapticFeedback("error");
}
