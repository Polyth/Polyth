// One shared one-second clock for labels that show elapsed time.
//
// A list with running rows must not re-render as a whole every second: only
// the label that shows the time subscribes here. One interval drives every
// subscriber and stops as soon as the last one leaves, so an app with nothing
// running schedules no timer at all. While the page is hidden the labels are
// left alone.
import { useState, useSyncExternalStore } from "react";

let tickerTimer: ReturnType<typeof setInterval> | null = null;
let tickerNow = Date.now();
const tickerSubscribers = new Set<() => void>();

const pageHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";

function tick(): void {
  tickerNow = Date.now();
  for (const notify of tickerSubscribers) notify();
}

// Nobody reads a clock on a page that is not shown. Its labels stand still
// there and catch up in one step when the page comes back.
function onVisibilityChange(): void {
  if (!pageHidden()) tick();
}

function subscribeTicker(onChange: () => void): () => void {
  tickerSubscribers.add(onChange);
  if (tickerTimer === null) {
    tickerNow = Date.now();
    tickerTimer = setInterval(() => { if (!pageHidden()) tick(); }, 1_000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
  }
  return () => {
    tickerSubscribers.delete(onChange);
    if (tickerSubscribers.size === 0 && tickerTimer !== null) {
      clearInterval(tickerTimer);
      tickerTimer = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

const subscribeNothing = () => () => {};

/** The current time, refreshed every second while `enabled`. */
export function useNowTick(enabled: boolean): number {
  const tick = useSyncExternalStore(enabled ? subscribeTicker : subscribeNothing, () => tickerNow);
  // The clock stands still while nobody listens. A label that mounts then
  // starts from its own mount time, not from that old reading.
  const [mountedAt] = useState(Date.now);
  return Math.max(tick, mountedAt);
}

/** Test seam: how many labels the clock is driving. */
export function nowTickSubscriberCount(): number {
  return tickerSubscribers.size;
}
