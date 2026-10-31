// One shared second tick for every running clock an agent shows — its row
// in the navigator, its page's status line and its conversation's live turn — so all of them
// read the same second, the way a working chat's clocks do.
import { useSyncExternalStore } from "react";

let tick = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    tick = Date.now();
    timer = setInterval(() => {
      tick = Date.now();
      for (const notify of [...listeners]) notify();
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}
const subscribeNothing = () => () => {};

/** The current second while `ticking`, else 0: nothing is counting. */
export const useNow = (ticking: boolean): number =>
  useSyncExternalStore(ticking ? subscribe : subscribeNothing, () => (ticking ? tick : 0), () => 0);
