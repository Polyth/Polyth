// UX-A390: the single JavaScript breakpoint seam for the Ember command shelf.
// Width selects the normal shell mode. A short viewport is also a phone only
// when it has a coarse primary pointer, which catches landscape phones without
// turning a short desktop window into the phone shell. No user-agent/device
// sniffing and no durable state: viewport mode is never persisted.
import { useSyncExternalStore } from "react";

/** Widths at or below this are `compact` (drawer sidebar, sheet panels). */
export const COMPACT_MAX_WIDTH = 820;
/** Widths at or below this are `phone` (compact rules + phone header/composer). */
export const PHONE_MAX_WIDTH = 480;
/** Coarse-pointer viewports at or below this height use the landscape phone shell. */
export const PHONE_LANDSCAPE_MAX_HEIGHT = 480;

export type ShellMode = "wide" | "compact" | "phone";

/** Pure viewport classifier matching the media-query subscription below. */
export function shellModeForViewport(
  width: number,
  height: number,
  coarsePointer: boolean,
): ShellMode {
  if (
    width <= PHONE_MAX_WIDTH
    || (height <= PHONE_LANDSCAPE_MAX_HEIGHT && coarsePointer)
  ) return "phone";
  if (width <= COMPACT_MAX_WIDTH) return "compact";
  return "wide";
}

/** Compatibility helper for width-only callers and boundary tests. */
export function shellModeForWidth(width: number): ShellMode {
  return shellModeForViewport(width, Number.POSITIVE_INFINITY, false);
}

// matchMedia-backed subscription. Both queries share one listener set so a
// resize, rotation, or primary-pointer change produces one snapshot change.
let queries: { compact: MediaQueryList; phone: MediaQueryList } | null = null;

function ensureQueries(): { compact: MediaQueryList; phone: MediaQueryList } | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  if (!queries) {
    queries = {
      compact: window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`),
      phone: window.matchMedia(
        `(max-width: ${PHONE_MAX_WIDTH}px), `
        + `(max-height: ${PHONE_LANDSCAPE_MAX_HEIGHT}px) and (pointer: coarse)`,
      ),
    };
  }
  return queries;
}

function snapshot(): ShellMode {
  const q = ensureQueries();
  if (!q) return "wide";
  if (q.phone.matches) return "phone";
  if (q.compact.matches) return "compact";
  return "wide";
}

function subscribe(onChange: () => void): () => void {
  const q = ensureQueries();
  if (!q) return () => {};
  q.compact.addEventListener("change", onChange);
  q.phone.addEventListener("change", onChange);
  return () => {
    q.compact.removeEventListener("change", onChange);
    q.phone.removeEventListener("change", onChange);
  };
}

/** Reactive shell mode; re-renders when a shell media boundary is crossed. */
export function useShellMode(): ShellMode {
  return useSyncExternalStore(subscribe, snapshot, () => "wide" as ShellMode);
}
