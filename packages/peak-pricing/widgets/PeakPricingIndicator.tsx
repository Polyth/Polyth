// One quiet chip on the composer's configuration row: the selected route's
// time-of-day price. Green while off-peak, red while peak; the arc around the
// dot is the progress through the current phase. Hover (or keyboard focus)
// reveals the countdown, and a click opens the full pricing card — which is
// also the touch path, where hover does not exist.
//
// The person picks how much of it shows (Settings → Peak pricing): the state
// and countdown, the state only, or only the dot beside the model name.
//
// It never guesses a provider: a route without a time-of-day schedule renders
// nothing, and the schedule is provider identity, not harness identity.
import "./styles.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ModelDescriptor } from "@polyth/contracts";
import { Popover, Tooltip } from "@polyth/web/ui";
import { useShellMode } from "@polyth/web/responsive-shell";
import {
  formatLocalTime,
  formatRemaining,
  priceStateAt,
  pricingRouteFor,
  type PricingSchedule,
} from "../src/schedule.ts";
import { CHINA_HOLIDAY_CALENDARS } from "../src/holidays.ts";
import { createPeakPricingCopy, fill } from "./copy.ts";
import { useDocumentLocale } from "./locale.ts";
import PeakPricingChip, { type PeakPricingSurface } from "./PeakPricingChip.tsx";
import { usePeakPricingPrefs, type PeakPricingDisplay } from "./prefs.ts";

/** What the chip needs to know about a route. The composer passes its catalog
 *  row; the status bar has only the session's or draft's model reference. */
export type PeakPricingModel = Pick<ModelDescriptor, "providerID" | "modelID">
  & Partial<Pick<ModelDescriptor, "name" | "harnessId" | "providerName">>;

export interface PeakPricingIndicatorProps {
  /** The route that would run the next turn, from the composer's slot context. */
  model?: PeakPricingModel;
  /** Resolved harness of that route; widens provider matching to `<family>-<account>`. */
  harnessId?: string;
  /** The composer chip (default) or a status-bar segment. The segment's
   *  presence is the bar's own layout, so "Show the chip" does not hide it. */
  surface?: PeakPricingSurface;
}

/** A visible countdown (full chip, open summary or card) moves every second. */
const TICK_MS = 1000;
/** Without one, only the arc moves; half a minute is below what it can show. */
const IDLE_TICK_MS = 30_000;

/** How often the chip must repaint for what is on screen. The phase edge
 *  itself is always scheduled exactly, so this only paces the arc/countdown. */
export function tickIntervalFor(display: PeakPricingDisplay, countdownVisible: boolean): number {
  return display === "full" || countdownVisible ? TICK_MS : IDLE_TICK_MS;
}

/** `HH:MM` in the viewer's zone, then the zone name for the card. */
function zoneLabel(locale: string, now: number): string {
  try {
    const short = new Intl.DateTimeFormat(locale, { timeZoneName: "short" })
      .formatToParts(new Date(now))
      .find((part) => part.type === "timeZoneName")?.value;
    if (short) return short;
  } catch {
    // fall through to the resolved zone
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The schedule's windows on the current UTC day, rendered on the viewer's
 *  clock. Using the current date (not a fixed January Monday) keeps the shown
 *  hour right across daylight-saving changes. */
function localWindows(schedule: PricingSchedule, locale: string, now: number): string {
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return schedule.peakWindows
    .map((window) => `${formatLocalTime(dayStart + window.startMinute * 60_000, locale)}–${formatLocalTime(dayStart + window.endMinute * 60_000, locale)}`)
    .join(", ");
}

function utcWindows(schedule: PricingSchedule): string {
  const clock = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return schedule.peakWindows.map((window) => `${clock(window.startMinute)}–${clock(window.endMinute)}`).join(", ");
}

/** The holiday notice is China's calendar; weekend copy must follow the same
 *  date, not the UTC date (they differ between 16:00 and 24:00 UTC). */
function chinaDate(now: number): Date {
  return new Date(now + 8 * 60 * 60_000);
}

export default function PeakPricingIndicator({ model, harnessId, surface = "composer" }: PeakPricingIndicatorProps) {
  const locale = useDocumentLocale();
  const copy = useMemo(() => createPeakPricingCopy(locale), [locale]);
  const prefs = usePeakPricingPrefs();
  const route = useMemo(
    () => pricingRouteFor({
      providerID: model?.providerID,
      ...(harnessId || model?.harnessId ? { harnessId: harnessId ?? model?.harnessId } : {}),
      modelID: model?.modelID,
      name: model?.name,
    }),
    [model?.providerID, model?.modelID, model?.name, model?.harnessId, harnessId],
  );
  const bar = surface === "statusbar";
  const schedule = prefs.enabled || bar ? route?.schedule : undefined;
  const phone = useShellMode() === "phone";
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  // Pointer or focus inside the chip: the hover summary (when on) shows the
  // live countdown, so it needs the one-second tick even in compact/dot.
  const [revealed, setRevealed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const state = useMemo(() => (schedule ? priceStateAt(now, schedule) : undefined), [now, schedule]);
  const until = state?.until;
  const interval = tickIntervalFor(prefs.display, open || (prefs.tooltip && revealed));

  // Tick only while the chip is mounted and the tab is visible: a background
  // tab has no countdown to paint, and a hidden page must not keep waking.
  // The phase edge gets its own exact timeout, so a slow idle tick can never
  // leave the wrong colour on screen after the price changes.
  useEffect(() => {
    if (!schedule || until === undefined) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let edge: ReturnType<typeof setTimeout> | undefined;
    const armEdge = () => {
      const wait = until - Date.now();
      edge = setTimeout(() => {
        edge = undefined;
        // A timer may fire a hair early on a skewed clock; re-arm until the
        // edge has really passed so the next state is the next phase.
        if (Date.now() < until) armEdge();
        else setNow(Date.now());
      }, Math.max(0, wait));
    };
    const start = () => {
      if (timer !== undefined) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), interval);
      armEdge();
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      if (edge !== undefined) clearTimeout(edge);
      timer = undefined;
      edge = undefined;
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    // Mounting in a background tab must not start a timer that nothing paints.
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [schedule, until, interval]);

  // Dot-only sits 2px after the model chip whatever gap the composer layout
  // puts between its chips (2px, 4px on the hero row, 8px on phones): read
  // the row's own gap and pull in by the difference. Only this element's
  // custom property is written; the row is never touched.
  const dotMode = !bar && prefs.display === "dot" && state !== undefined;
  useLayoutEffect(() => {
    const root = rootRef.current;
    const row = root?.parentElement;
    if (!dotMode || !root || !row) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(row).columnGap);
      root.style.setProperty("--peak-pricing-row-gap", `${Number.isFinite(gap) ? gap : 0}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [dotMode]);

  // A route change must not leave the previous route's card open.
  useEffect(() => setOpen(false), [schedule?.id, route?.billing]);

  if (!schedule || !model || !state) return null;

  const peak = state.phase === "peak";
  const stateLabel = peak ? copy.peak : copy.offPeak;
  const endTime = formatLocalTime(state.until, locale);
  const remaining = formatRemaining(state.until - now, copy.duration);
  const total = Math.max(1, state.until - state.since);
  const progress = Math.min(1, Math.max(0, (now - state.since) / total));
  const ariaLabel = fill(copy.chipLabel, { state: stateLabel, time: endTime });
  const changeLine = fill(copy.changesAt, { time: endTime });
  const localChinaDay = chinaDate(now);
  const calendar = state.calendarYear === undefined ? undefined : CHINA_HOLIDAY_CALENDARS.find((entry) =>
    state.calendarYear !== undefined && entry.from.startsWith(`${state.calendarYear}-`));
  const providerNote = route?.billing === "model"
    ? fill(copy.billedBy, { provider: model.providerName?.trim() || model.providerID })
    : null;
  const holidayNote = state.holiday
    ? fill(copy.holiday, { holiday: state.holiday.name })
    : !peak && !calendar
      ? fill(copy.calendarUnknown, { year: localChinaDay.getUTCFullYear() })
      : !peak && (localChinaDay.getUTCDay() === 0 || localChinaDay.getUTCDay() === 6)
        ? copy.weekend
        : null;

  const tooltip = (
    <span className="peak-pricing-tip">
      <span className="peak-pricing-tip-head">
        <span className="peak-pricing-tip-state" data-phase={state.phase}>{stateLabel}</span>
        <span className="peak-pricing-tip-remaining">{fill(copy.remaining, { state: stateLabel, remaining })}</span>
      </span>
      <span className="peak-pricing-tip-line">{changeLine}</span>
      {holidayNote && <span className="peak-pricing-tip-note">{holidayNote}</span>}
      <span className="peak-pricing-tip-note">{copy.discount}</span>
      {providerNote && <span className="peak-pricing-tip-note">{providerNote}</span>}
    </span>
  );

  const card = (
    <div className="peak-pricing-card">
      <div className="peak-pricing-card-head">
        <span className="peak-pricing-card-dot" data-phase={state.phase} aria-hidden="true" />
        <div className="peak-pricing-card-titles">
          <strong>{peak ? copy.peakTitle : copy.offPeakTitle}</strong>
          <span>{peak ? copy.peakDetail : copy.offPeakDetail}</span>
        </div>
      </div>
      <div className="peak-pricing-card-countdown">
        <span className="peak-pricing-card-clock">{remaining}</span>
        <span className="peak-pricing-card-until">{fill(copy.until, { state: stateLabel, time: endTime })}</span>
      </div>
      {holidayNote && <p className="peak-pricing-card-note">{holidayNote}</p>}
      {providerNote && <p className="peak-pricing-card-note">{providerNote}</p>}
      <dl className="peak-pricing-card-facts">
        <div>
          <dt>{copy.windows}</dt>
          <dd>{utcWindows(schedule)} · {copy.weekdays}</dd>
        </div>
        <div>
          <dt>{fill(copy.zone, { zone: zoneLabel(locale, now) })}</dt>
          <dd>{localWindows(schedule, locale, now)}</dd>
        </div>
        {calendar && (
          <div>
            <dt>{copy.calendarLabel}</dt>
            <dd>{fill(copy.calendarSource, { source: calendar.source })}</dd>
          </div>
        )}
        <div>
          <dd><a href={schedule.sourceUrl} target="_blank" rel="noreferrer noopener">{copy.sourceLink}</a></dd>
        </div>
      </dl>
    </div>
  );

  const chip = (
    <PeakPricingChip
      ref={triggerRef}
      phase={state.phase}
      display={prefs.display}
      progress={progress}
      stateLabel={stateLabel}
      remaining={remaining}
      surface={surface}
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    />
  );

  return (
    <span
      ref={rootRef}
      className="peak-pricing"
      data-display={prefs.display}
      {...(bar ? { "data-surface": surface } : {})}
      onPointerEnter={() => setRevealed(true)}
      onPointerLeave={() => setRevealed(false)}
      onFocus={() => setRevealed(true)}
      onBlur={() => setRevealed(false)}
    >
      {prefs.tooltip ? (
        <Tooltip
          content={tooltip}
          side="up"
          delayMs={phone ? 0 : 160}
          {...(open ? { className: "peak-pricing-tip-hidden" } : {})}
        >
          {chip}
        </Tooltip>
      ) : chip}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        className="peak-pricing-pop"
        ariaLabel={copy.detailsTitle}
        side="up"
        align="start"
      >
        {card}
      </Popover>
    </span>
  );
}
