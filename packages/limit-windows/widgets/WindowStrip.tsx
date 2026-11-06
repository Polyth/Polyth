// The next 26 hours of one account: the window running now, the windows the plan
// would start, and the hours it serves. It draws a forecast; a person's own turn
// can start a window sooner.
import type { ReactNode } from "react";
import type { MeterView } from "../src/types.ts";
import { fill, type LimitWindowsCopy } from "./copy.ts";
import { formatClock } from "./format.ts";

export const STRIP_SPAN_MS = 26 * 60 * 60_000;
/** What separates two windows: the moment one ends and the next opens. */
const WINDOW_GAP = "2px";

const percent = (at: number, now: number): number =>
  Math.min(100, Math.max(0, ((at - now) / STRIP_SPAN_MS) * 100));

export default function WindowStrip({ meter, now, locale, timeZone, copy }: {
  meter: MeterView;
  now: number;
  locale: string;
  timeZone: string;
  copy: LimitWindowsCopy;
}): ReactNode {
  const end = now + STRIP_SPAN_MS;
  const planned = meter.planned.filter((window) => window.from < end);
  const hours = [...new Set(planned.flatMap((window) => window.targetAt !== undefined && window.targetAt < end ? [window.targetAt] : []))];
  const clockOf = (at: number): string => formatClock(at, locale, timeZone);
  const label = [
    copy.stripLabel,
    meter.running ? fill(copy.stripRunning, { at: clockOf(meter.running.to) }) : "",
    planned.length ? fill(copy.stripPlanned, { list: planned.map((window) => clockOf(window.from)).join(", ") }) : "",
    ...hours.map((at) => fill(copy.stripHour, { at: clockOf(at) })),
  ].filter(Boolean).join(" ");
  // A start closer than this to the previous label would collide with it.
  const MIN_LABEL_GAP = 11;
  let lastLabel = -Infinity;
  const starts = planned.flatMap((window) => {
    const left = percent(window.from, now);
    if (left - lastLabel < MIN_LABEL_GAP || left > 94) return [];
    lastLabel = left;
    return [{ at: window.from, left }];
  });
  const firstStart = starts[0]?.left ?? Infinity;
  return (
    <div className="limit-windows-strip" role="img" aria-label={label}>
      <div className="limit-windows-strip-track">
        {meter.running && (
          <span
            className="limit-windows-strip-window"
            data-kind="running"
            style={{ insetInlineStart: "0%", width: `calc(${percent(meter.running.to, now)}% - ${WINDOW_GAP})` }}
          />
        )}
        {planned.map((window) => {
          const left = percent(window.from, now);
          return (
            <span
              key={window.from}
              className="limit-windows-strip-window"
              data-kind="planned"
              style={{ insetInlineStart: `${left}%`, width: `calc(${percent(window.to, now) - left}% - ${WINDOW_GAP})` }}
            />
          );
        })}
        {hours.map((at) => (
          <span key={at} className="limit-windows-strip-hour" style={{ insetInlineStart: `${percent(at, now)}%` }} />
        ))}
      </div>
      <div className="limit-windows-strip-labels" aria-hidden="true">
        {firstStart >= MIN_LABEL_GAP && <span className="limit-windows-strip-label" style={{ insetInlineStart: "0%" }}>{copy.stripNow}</span>}
        {starts.map(({ at, left }) => (
          <span key={at} className="limit-windows-strip-label" style={{ insetInlineStart: `${left}%` }}>{clockOf(at)}</span>
        ))}
      </div>
    </div>
  );
}
