// The single JavaScript breakpoint seam for the Ember command shelf.
// Width selects the normal shell mode. A short viewport is also a phone only
// when it has a coarse primary pointer, which catches landscape phones without
// turning a short desktop window into the phone shell. No user-agent/device
// sniffing and no durable state: viewport mode is never persisted.
import { useSyncExternalStore } from "react";

/** Widths at or below this are `compact` (drawer sidebar, sheet panels).
 *  The persistent navigator (SIDEBAR_DEFAULT_WIDTH 332px, user-resizable
 *  280–440) only earns its keep when it still leaves a comfortable primary
 *  workspace beside it: 332 + ~620–628px ≈ 960. Rendered measurement with the
 *  default navigator: at 961px the primary workspace is ~621px and the
 *  conversation lane ~517px (≈1.6× CHAT_FLOOR) — usable, not starved; at 941px
 *  the workspace would be only ~600px, below the budget, so it stays compact.
 *  Every portrait tablet (≤834) and every half-width / half-snapped window
 *  below 960 lands in the drawer shell instead of a cramped three-region
 *  desktop; landscape tablets (≥1080) and real desktop windows keep the
 *  persistent navigator. This is a space decision, not a device one.
 *  960 → 961 is a real shell transition, not a continuous ramp (the navigator
 *  and an ~80px launcher lane enter flow); it is placed where both sides are
 *  intentionally usable. See docs/dev/tablet-ux.md. */
export const COMPACT_MAX_WIDTH = 960;
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

/** Current shell mode for non-React callers (native Back, imperative gestures). */
export function getShellMode(): ShellMode {
  return snapshot();
}

/** Reactive shell mode; re-renders when a shell media boundary is crossed. */
export function useShellMode(): ShellMode {
  return useSyncExternalStore(subscribe, snapshot, () => "wide" as ShellMode);
}

// Viewport-below subscriptions for host thresholds other than the shell seam
// (e.g. a focused profile's `sidebarRailBelow`). One MediaQueryList per width.
const belowQueries = new Map<number, MediaQueryList>();

function belowQuery(width: number): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  let query = belowQueries.get(width);
  if (!query) {
    // `.02` keeps fractional device widths (1599.5) below a whole-pixel bound.
    query = window.matchMedia(`(max-width: ${width - 0.02}px)`);
    belowQueries.set(width, query);
  }
  return query;
}

/** True while the viewport is narrower than `width`; false for null. */
export function useViewportBelow(width: number | null): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = width === null ? null : belowQuery(width);
      if (!query) return () => {};
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => (width === null ? false : belowQuery(width)?.matches ?? false),
    () => false,
  );
}
