// UX-A390: the single JavaScript breakpoint seam for the Ember command shelf.
// Width selects the normal shell mode. A short viewport is also a phone only
// when it has a coarse primary pointer, which catches landscape phones without
// turning a short desktop window into the phone shell. No user-agent/device
// sniffing and no durable state: viewport mode is never persisted.
import { useSyncExternalStore } from "react";

/** Widths at or below this are `compact` (drawer sidebar, sheet panels).
 *  The persistent navigator (SIDEBAR_DEFAULT_WIDTH 332px, user-resizable
 *  280–440) only earns its keep when it still leaves a usable primary
 *  workspace beside it. Every portrait tablet (≤834) and every half-snapped
 *  desktop window below 900 lands in the drawer shell instead of a cramped
 *  three-region desktop; landscape tablets (≥1080) and real desktop windows
 *  keep the persistent navigator. This is a space decision, not a device one.
 *  Note: 900 → 901 is a real layout step (at 901 the primary workspace is
 *  ~561px, the conversation lane ~457px); the seam is relocated from the old
 *  820 line to a width where the wide shell is at least usable, not removed.
 *  See docs/dev/tablet-ux.md. */
export const COMPACT_MAX_WIDTH = 900;
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
