// UX-A390: the single JavaScript breakpoint seam for the Ember command shelf.
// Width alone selects the shell mode — pointer type, hover capability, user
// agent, and device category must not participate. CSS uses the same literal
// boundaries (820 / 480; the height-only "short" contract lives in CSS as
// max-height: 600px). No durable state: viewport mode is never persisted.
import { useSyncExternalStore } from "react";

/** Widths at or below this are `compact` (drawer sidebar, sheet panels). */
export const COMPACT_MAX_WIDTH = 820;
/** Widths at or below this are `phone` (compact rules + phone header/composer). */
export const PHONE_MAX_WIDTH = 480;

export type ShellMode = "wide" | "compact" | "phone";

/** Pure width classifier shared by every shell-mode decision. */
export function shellModeForWidth(width: number): ShellMode {
  if (width <= PHONE_MAX_WIDTH) return "phone";
  if (width <= COMPACT_MAX_WIDTH) return "compact";
  return "wide";
}

// matchMedia-backed subscription. Both queries share one listener set so a
// resize crossing either boundary produces exactly one snapshot change.
let queries: { compact: MediaQueryList; phone: MediaQueryList } | null = null;

function ensureQueries(): { compact: MediaQueryList; phone: MediaQueryList } | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  if (!queries) {
    queries = {
      compact: window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`),
      phone: window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`),
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

/** Reactive shell mode; re-renders exactly when a width boundary is crossed. */
export function useShellMode(): ShellMode {
  return useSyncExternalStore(subscribe, snapshot, () => "wide" as ShellMode);
}
