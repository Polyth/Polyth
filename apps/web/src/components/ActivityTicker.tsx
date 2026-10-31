import type { ReactNode } from "react";
import type { TickerState } from "../activityTicker.ts";

export { ACTIVITY_TICKER_DWELL_MS, ACTIVITY_TICKER_EXIT_MS, useTickerKey } from "../activityTicker.ts";

/**
 * The activity block's one line.
 *
 * While its block is the live tail of a working turn, the line names the step
 * in progress, and each new step takes the line's place in it: the old words
 * rise away as the new ones rise in. Once the agent moves on, the line settles
 * on the block's summary the same way. The block never adds or removes a row
 * while it works, so nothing around it moves.
 *
 * The owner keeps the ticker state (`useTickerKey`), so everything that
 * describes the line — its accessible name, the Stop beside it — follows the
 * words actually on screen, not the newest event.
 */

/** Renders `ticker.shown` (and, for one beat, `ticker.leaving`) through
 *  `render`, swapping lines in place. `render` must still describe a key that
 *  has just left (its words fade out with it); an unknown key renders the
 *  summary. */
export default function ActivityTicker({ ticker, render }: {
  ticker: TickerState;
  render: (key: string) => ReactNode;
}) {
  const { shown, leaving, entered } = ticker;
  return (
    <span className="activity-ticker" data-ticker-entry={shown}>
      {leaving !== null && (
        <span key={`leaving:${leaving}`} className="activity-ticker-line leaving" aria-hidden="true">{render(leaving)}</span>
      )}
      <span key={shown} className={`activity-ticker-line${entered ? " entering" : ""}`}>{render(shown)}</span>
    </span>
  );
}
