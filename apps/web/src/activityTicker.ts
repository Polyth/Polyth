import { useEffect, useRef, useState } from "react";
import { timelineLiftMotionDisabled } from "./timelineLift.ts";

/**
 * Timing of the activity block's live line (components/ActivityTicker.tsx).
 * A step that lands and is answered within a few frames still reads: every
 * line stays at least one dwell before the next may take its place — with
 * motion off too, where the words only change in place — and a burst skips
 * straight to its newest step instead of queueing a backlog. A hidden tab
 * swaps at once: nobody is reading.
 */

/** How long a line stays before the next one may replace it. */
export const ACTIVITY_TICKER_DWELL_MS = 900;
/** Matches `activity-ticker-out` in styles.css: the leaving line's lifetime. */
export const ACTIVITY_TICKER_EXIT_MS = 200;

export interface TickerState {
  shown: string;
  leaving: string | null;
  /** The shown line arrived by a swap (not with the block), so it rises in. */
  entered: boolean;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

export function useTickerKey(target: string): TickerState {
  const [state, setState] = useState<TickerState>(() => ({ shown: target, leaving: null, entered: false }));
  const shownAt = useRef(Date.now());
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    if (state.shown === target) return;
    const swap = () => {
      const next = latest.current;
      shownAt.current = Date.now();
      // Motion off (reduced motion, low resource, hidden tab): the line
      // changes in place, with nothing leaving.
      if (timelineLiftMotionDisabled()) {
        setState((current) => current.shown === next && current.leaving === null ? current : { shown: next, leaving: null, entered: false });
        return;
      }
      setState((current) => current.shown === next ? current : { shown: next, leaving: current.shown, entered: true });
    };
    const wait = ACTIVITY_TICKER_DWELL_MS - (Date.now() - shownAt.current);
    if (wait <= 0 || documentHidden()) {
      swap();
      return;
    }
    const timer = window.setTimeout(swap, wait);
    return () => window.clearTimeout(timer);
  }, [target, state.shown]);
  useEffect(() => {
    if (state.leaving === null) return;
    const timer = window.setTimeout(() => {
      setState((current) => current.leaving === null ? current : { ...current, leaving: null });
    }, ACTIVITY_TICKER_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [state.leaving, state.shown]);
  return state;
}

/** True once `on` has held for `delayMs`; false at once when it drops. A
 *  control that only matters for long work (a command's Stop) then never
 *  flashes in and out for steps that finish within a beat. */
export function useSettledFlag(on: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!on) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [on, delayMs]);
  return on && settled;
}
