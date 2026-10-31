// The DeepSeek API's time-of-day pricing windows, evaluated in UTC (the
// provider publishes them in UTC, so evaluation never depends on the device's
// zone).
//
// Source: https://api-docs.deepseek.com/quick_start/pricing — "Peak hours are
// 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding
// Chinese public holidays. All other hours are off-peak, including weekends
// and Chinese public holidays in full. Off-peak rates are half of the peak
// rates." The Chinese page states the same windows in Beijing time
// (09:00–12:00 and 14:00–18:00), and the holiday notice is China's calendar,
// so holiday dates are matched in Asia/Shanghai rather than UTC.
//
// Windows are half-open `[start, end)` minutes from 00:00 UTC. A window may
// wrap midnight (for example 22:00–02:00); the edge model and phase test below
// keep that case correct even though DeepSeek's current notice does not use it.
import { CHINA_HOLIDAY_CALENDARS, type HolidayCalendar } from "./holidays.ts";

export interface PeakWindow {
  /** Minutes from 00:00 UTC, inclusive. */
  startMinute: number;
  /** Minutes from 00:00 UTC, exclusive. */
  endMinute: number;
}

export const DEEPSEEK_PEAK_WINDOWS: readonly PeakWindow[] = [
  { startMinute: 1 * 60, endMinute: 4 * 60 },
  { startMinute: 6 * 60, endMinute: 10 * 60 },
];

/** ISO weekday numbers that are peak; Saturday (6) and Sunday (7) never are. */
export const DEEPSEEK_PEAK_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** A provider whose price depends on the time of day. */
export interface PricingSchedule {
  id: string;
  /** Provider ids that route to this schedule (lower-case, as the catalog
   *  reports them). Matched exactly, or as a `<family>-<account>` harness id. */
  providers: readonly string[];
  peakWindows: readonly PeakWindow[];
  peakWeekdays: readonly number[];
  /** Chinese public holidays are off-peak in full. */
  excludesChineseHolidays: boolean;
  /** Shown verbatim in the details surface. */
  source: string;
  sourceUrl: string;
}

export const DEEPSEEK_PRICING: PricingSchedule = {
  id: "deepseek",
  // `deepseek-official` is the route the shipped DeepSeek Harness profiles use;
  // custom dsh profiles may keep another provider id, so the harness family is
  // matched too (see scheduleForProvider).
  providers: ["deepseek", "deepseek-official", "deepseek-platform"],
  peakWindows: DEEPSEEK_PEAK_WINDOWS,
  peakWeekdays: DEEPSEEK_PEAK_WEEKDAYS,
  excludesChineseHolidays: true,
  source: "DeepSeek API pricing: peak 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, excluding Chinese public holidays",
  sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
};

export const PRICING_SCHEDULES: readonly PricingSchedule[] = [DEEPSEEK_PRICING];

const DAY_MS = 24 * 60 * 60_000;

/** The provider family a harness id belongs to (`deepseek-work` →
 *  `deepseek`), mirroring how the harness registry names extra logins. */
function harnessFamily(harnessId: string | undefined): string | undefined {
  const value = harnessId?.trim().toLowerCase();
  if (!value) return undefined;
  const match = /^([a-z]+)-[a-z0-9][a-z0-9-]*$/.exec(value);
  return match?.[1];
}

export interface PricingRoute {
  schedule: PricingSchedule;
  /**
   * `provider` when the schedule is that provider's own API (the rate shown is
   * the amount billed). `model` when a DeepSeek model is served by another
   * provider: the clock still describes DeepSeek's API, but that route bills
   * its own price, so the UI says so instead of implying a discount.
   */
  billing: "provider" | "model";
}

const DEEPSEEK_MODEL = /(^|[/:\s-])deepseek([/:\s-]|$)/i;

/**
 * The schedule for a route, if one applies.
 *
 * Provider identity decides first: DeepSeek's own routes, plus any
 * `<family>-<account>` harness login. A DeepSeek model served by another
 * provider is a *reference* match — the clock is DeepSeek's published one, and
 * the details surface names the actual biller.
 */
export function pricingRouteFor(
  route: { providerID?: string; harnessId?: string; modelID?: string; name?: string },
  schedules: readonly PricingSchedule[] = PRICING_SCHEDULES,
): PricingRoute | undefined {
  const provider = route.providerID?.trim().toLowerCase();
  const family = harnessFamily(route.harnessId);
  // The harness family only widens the provider match to a DeepSeek-named
  // login (`deepseek-work`); it never claims an unrelated provider's route.
  const providerInFamily = family !== undefined
    && (provider === family || provider?.startsWith(`${family}-`) === true);
  const byProvider = provider
    ? schedules.find((schedule) => schedule.providers.some((candidate) =>
      candidate === provider || (providerInFamily && candidate === family)))
    : undefined;
  if (byProvider) return { schedule: byProvider, billing: "provider" };
  const model = `${route.modelID ?? ""} ${route.name ?? ""}`.trim();
  if (!model || !DEEPSEEK_MODEL.test(model)) return undefined;
  const byModel = schedules.find((schedule) => schedule.id === "deepseek");
  return byModel ? { schedule: byModel, billing: "model" } : undefined;
}

/** Convenience for callers that only have a provider id. */
export function scheduleForProvider(
  providerID: string | undefined,
  harnessId?: string,
  schedules: readonly PricingSchedule[] = PRICING_SCHEDULES,
): PricingSchedule | undefined {
  return pricingRouteFor({ providerID, harnessId }, schedules)?.schedule;
}

export type PricePhase = "peak" | "off-peak";

export interface PriceState {
  phase: PricePhase;
  /** Epoch ms when this phase began. */
  since: number;
  /** Epoch ms when this phase ends and the next one begins. */
  until: number;
  /** The holiday that makes today off-peak, when one does. */
  holiday?: { name: string };
  /** Year of the published holiday calendar that covered this decision.
   *  Absent outside every published notice, so callers can say the calendar
   *  is not published yet instead of implying certainty. */
  calendarYear?: number;
}

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

const partsOf = (date: Date): CalendarDateParts => {
  const weekday = date.getUTCDay();
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: weekday === 0 ? 7 : weekday,
  };
};

const utcParts = (ms: number): CalendarDateParts => partsOf(new Date(ms));

/** China has observed UTC+8 without DST since 1991. The State Council holiday
 *  notice is written in Beijing dates, so holiday matching uses that calendar
 *  even though the price windows are published in UTC. */
const CHINA_OFFSET_MS = 8 * 60 * 60_000;
const chinaParts = (ms: number): CalendarDateParts => partsOf(new Date(ms + CHINA_OFFSET_MS));

const pad = (value: number): string => String(value).padStart(2, "0");
const dateKey = ({ year, month, day }: CalendarDateParts): string => `${year}-${pad(month)}-${pad(day)}`;
const dayStartMs = ({ year, month, day }: CalendarDateParts): number => Date.UTC(year, month - 1, day);

function calendarFor(parts: CalendarDateParts): HolidayCalendar | undefined {
  const key = dateKey(parts);
  return CHINA_HOLIDAY_CALENDARS.find((calendar) => key >= calendar.from && key <= calendar.to);
}

function holidayFor(parts: CalendarDateParts): { name: string; calendar: HolidayCalendar } | undefined {
  const calendar = calendarFor(parts);
  if (!calendar) return undefined;
  const key = dateKey(parts);
  const range = calendar.ranges.find((entry) => key >= entry.from && key <= entry.to);
  return range ? { name: range.name, calendar } : undefined;
}

/** Half-open, wrapping when the window crosses UTC midnight. */
function windowContains(window: PeakWindow, minuteOfDay: number): boolean {
  return window.startMinute <= window.endMinute
    ? minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute
    : minuteOfDay >= window.startMinute || minuteOfDay < window.endMinute;
}

function phaseAt(ms: number, schedule: PricingSchedule): PricePhase {
  const day = utcParts(ms);
  if (schedule.excludesChineseHolidays && holidayFor(chinaParts(ms))) return "off-peak";
  if (!schedule.peakWeekdays.includes(day.weekday)) return "off-peak";
  const minuteOfDay = (ms - dayStartMs(day)) / 60_000;
  return schedule.peakWindows.some((window) => windowContains(window, minuteOfDay)) ? "peak" : "off-peak";
}

/** Every instant the phase can change on one UTC day: midnight, then each
 *  window edge. A wrapping window contributes its start today and the previous
 *  window's end today, so both are real edges in this day. Sorted, de-duplicated. */
function dayBoundaries(startMs: number, schedule: PricingSchedule): number[] {
  const edges = [0, ...schedule.peakWindows.flatMap((window) => [window.startMinute, window.endMinute])]
    .map((minute) => startMs + minute * 60_000)
    .filter((value) => value >= startMs && value < startMs + DAY_MS);
  return [...new Set(edges)].sort((left, right) => left - right);
}

/** A year is far beyond any real weekly schedule or Chinese holiday run; the
 *  cap only keeps a malformed/custom schedule from looping forever. */
const MAX_TRANSITION_SEARCH_DAYS = 400;

/** The first edge after `now` whose phase differs. Walking day by day, rather
 *  than assuming the next edge is a transition, lets one off-peak run span a
 *  weekend plus a nine-day Spring Festival without a fixed search window. */
function nextTransition(now: number, schedule: PricingSchedule, phase: PricePhase): number {
  const today = dayStartMs(utcParts(now));
  for (let offset = 0; offset <= MAX_TRANSITION_SEARCH_DAYS; offset++) {
    for (const edge of dayBoundaries(today + offset * DAY_MS, schedule)) {
      if (edge <= now) continue;
      if (phaseAt(edge, schedule) !== phase) return edge;
    }
  }
  return now + DAY_MS;
}

/** The most recent edge whose preceding instant had the other phase. */
function previousTransition(now: number, schedule: PricingSchedule, phase: PricePhase): number {
  const today = dayStartMs(utcParts(now));
  for (let offset = 0; offset <= MAX_TRANSITION_SEARCH_DAYS; offset++) {
    const edges = dayBoundaries(today - offset * DAY_MS, schedule);
    for (let index = edges.length - 1; index >= 0; index--) {
      const edge = edges[index]!;
      if (edge > now) continue;
      if (phaseAt(edge - 1, schedule) !== phase) return edge;
    }
  }
  return now;
}

/**
 * Phase at an instant, with the exact edges of the current phase.
 *
 * The phase only changes at a day start or a window edge. One off-peak run can
 * legitimately last over a week (a Friday evening, the weekend, then a
 * nine-day Spring Festival), so transitions are found by walking outward until
 * the phase actually differs instead of assuming the next edge is a change.
 */
export function priceStateAt(now: number, schedule: PricingSchedule = DEEPSEEK_PRICING): PriceState {
  const phase = phaseAt(now, schedule);
  const until = nextTransition(now, schedule, phase);
  const since = previousTransition(now, schedule, phase);
  const calendarDay = chinaParts(now);
  const holiday = schedule.excludesChineseHolidays ? holidayFor(calendarDay) : undefined;
  const calendar = schedule.excludesChineseHolidays ? calendarFor(calendarDay) : undefined;
  return {
    phase,
    since,
    until,
    ...(holiday ? { holiday: { name: holiday.name } } : {}),
    ...(calendar ? { calendarYear: calendarDay.year } : {}),
  };
}

/** How one duration part is written; `{n}` is the number (`{n}h`, `{n} год`). */
export interface DurationUnits {
  day: string;
  hour: string;
  minute: string;
  second: string;
}

export const EN_DURATION_UNITS: DurationUnits = { day: "{n}d", hour: "{n}h", minute: "{n}m", second: "{n}s" };

/** `2d 05h`, `4h 12m`, `12m 30s` or `45s`: one stable shape per magnitude.
 *  `units` localizes the part names; the shape and padding stay the same. */
export function formatRemaining(ms: number, units: DurationUnits = EN_DURATION_UNITS): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const part = (template: string, value: number | string) => template.replace("{n}", String(value));
  if (days > 0) return `${part(units.day, days)} ${part(units.hour, pad(hours))}`;
  if (hours > 0) return `${part(units.hour, hours)} ${part(units.minute, pad(minutes))}`;
  if (minutes > 0) return `${part(units.minute, minutes)} ${part(units.second, pad(seconds))}`;
  return part(units.second, seconds);
}

/** `HH:MM` in the viewer's own zone: the transition is local, not UTC. */
export function formatLocalTime(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
