// Wall-clock arithmetic in one IANA time zone. Pure and browser-safe. Times are
// "HH:MM"; days are 0 (Sunday) to 6, and an empty list means every day.
const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterOf = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

export function localParts(at: number, timeZone: string): LocalParts {
  const out: Record<string, string> = {};
  for (const part of formatterOf(timeZone).formatToParts(at)) out[part.type] = part.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday!] ?? 0,
  };
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 100) return false;
  try {
    formatterOf(timeZone);
    return true;
  } catch {
    return false;
  }
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isClockTime = (value: unknown): value is string => typeof value === "string" && TIME.test(value);

/** Minutes after local midnight. */
export const clockMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** The instant a wall-clock time falls on. A skipped time (spring forward) maps
 *  just past the gap; a repeated one (autumn) to its first occurrence. */
export function localTimeToUtc(year: number, month: number, day: number, minutes: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const offsetAt = (instant: number): number => {
    const parts = localParts(instant, timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
  };
  // The earlier of the day's two possible offsets gives the first occurrence.
  const candidates = [wall - offsetAt(wall - DAY_MS), wall - offsetAt(wall + DAY_MS)];
  const exact = candidates.filter((at) => at + offsetAt(at) === wall).sort((a, b) => a - b);
  return exact[0] ?? Math.max(...candidates);
}

/** The first occurrence of any of `times` at or after `from`. Null without times
 *  or days, or for a malformed zone. */
export function nextOccurrence(times: readonly string[], days: readonly number[], timeZone: string, from: number): number | null {
  if (times.length === 0 || !isValidTimeZone(timeZone)) return null;
  const minutes = times.map(clockMinutes);
  const first = localParts(from, timeZone);
  // Whole calendar days, not 24 h steps, which skip a date around a clock change.
  // Eight covers a weekly list from any instant of the first day.
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
    if (days.length > 0 && !days.includes(date.getUTCDay())) continue;
    const found = minutes
      .map((value) => localTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), value, timeZone))
      .filter((at) => at >= from)
      .sort((a, b) => a - b)[0];
    if (found !== undefined) return found;
  }
  return null;
}

/** Whether `at` falls in a local daily range; `until` before `from` wraps past midnight. */
export function insideDailyRange(at: number, from: string, until: string, timeZone: string): boolean {
  const parts = localParts(at, timeZone);
  const now = parts.hour * 60 + parts.minute;
  const start = clockMinutes(from);
  const end = clockMinutes(until);
  if (start === end) return true;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
