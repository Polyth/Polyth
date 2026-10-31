import type { UsageBucket, UsageRangePreset, UsageStatsQuery } from "./contracts.ts";

const DAY_MS = 24 * 60 * 60_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const localDayCache = new Map<string, string>();
const LOCAL_DAY_CACHE_LIMIT = 20_000;

export function isValidTimeZone(timezone: string): boolean {
  const value = timezone.trim();
  if (!value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(timestamp: number, timezone: string): ZonedDateParts {
  const result: ZonedDateParts = { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN, second: NaN };
  for (const part of partsFormatter(timezone).formatToParts(timestamp)) {
    if (part.type in result) result[part.type as keyof ZonedDateParts] = Number(part.value);
  }
  for (const [type, value] of Object.entries(result)) {
    if (!Number.isFinite(value)) throw new Error(`timezone formatter omitted ${type}`);
  }
  return result;
}

export function zonedTimeToUtc(
  parts: Pick<ZonedDateParts, "year" | "month" | "day" | "hour" | "minute" | "second">,
  timezone: string,
): number {
  const wallUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
  let candidate = wallUtc;
  // Convert wall-clock fields to an instant. Iterating resolves offsets around
  // DST transitions without depending on the host machine's local timezone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(candidate, timezone);
    const actualWallUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = actualWallUtc - wallUtc;
    if (correction === 0) return candidate;
    candidate -= correction;
  }
  return candidate;
}

export function startOfLocalDay(timestamp: number, timezone: string): number {
  const date = zonedParts(timestamp, timezone);
  return zonedTimeToUtc({ ...date, hour: 0, minute: 0, second: 0 }, timezone);
}

export function addLocalDays(timestamp: number, days: number, timezone: string): number {
  const date = zonedParts(timestamp, timezone);
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return zonedTimeToUtc({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  }, timezone);
}

export function localDateKey(timestamp: number, timezone: string): string {
  const cacheKey = `${timezone}:${timestamp}`;
  const cached = localDayCache.get(cacheKey);
  if (cached) return cached;
  const date = zonedParts(timestamp, timezone);
  const result = `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
  if (localDayCache.size >= LOCAL_DAY_CACHE_LIMIT) {
    const oldest = localDayCache.keys().next().value as string | undefined;
    if (oldest) localDayCache.delete(oldest);
  }
  localDayCache.set(cacheKey, result);
  return result;
}

// Every modern UTC offset and transition instant is a multiple of 15 minutes,
// so a local date is constant inside an aligned 15-minute slot unless the slot
// straddles a transition. A slot whose two ends disagree falls back to an exact
// per-timestamp conversion, so this stays calendar-correct either way.
const DATE_SLOT_MS = 15 * 60_000;

/**
 * Local `YYYY-MM-DD` keys for one report. Usage history holds tens of
 * thousands of distinct timestamps; formatting each one through `Intl` used to
 * dominate report time, while their slots number only in the low thousands.
 */
export function createLocalDateKeyer(timezone: string): (timestamp: number) => string {
  const slots = new Map<number, string | null>();
  return (timestamp) => {
    const slot = Math.floor(timestamp / DATE_SLOT_MS);
    let key = slots.get(slot);
    if (key === undefined) {
      const start = localDateKey(slot * DATE_SLOT_MS, timezone);
      key = start === localDateKey((slot + 1) * DATE_SLOT_MS - 1, timezone) ? start : null;
      slots.set(slot, key);
    }
    return key ?? localDateKey(timestamp, timezone);
  };
}

export function startOfLocalBucket(timestamp: number, bucket: UsageBucket, timezone: string): number {
  const date = zonedParts(timestamp, timezone);
  if (bucket === "hour") {
    return zonedTimeToUtc({ ...date, minute: 0, second: 0 }, timezone);
  }
  if (bucket === "day") return startOfLocalDay(timestamp, timezone);
  if (bucket === "week") {
    const dateOnly = zonedTimeToUtc({ ...date, hour: 0, minute: 0, second: 0 }, timezone);
    const local = zonedParts(dateOnly, timezone);
    // Date.UTC treats Sunday as 0 and Monday as 1; normalize both to Monday.
    const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    return addLocalDays(dateOnly, weekday === 0 ? -6 : 1 - weekday, timezone);
  }
  return zonedTimeToUtc({
    year: date.year,
    month: date.month,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  }, timezone);
}

export function nextLocalBucket(timestamp: number, bucket: UsageBucket, timezone: string): number {
  const date = zonedParts(timestamp, timezone);
  if (bucket === "hour") {
    return zonedTimeToUtc({ ...date, hour: date.hour + 1, minute: 0, second: 0 }, timezone);
  }
  if (bucket === "day") return addLocalDays(timestamp, 1, timezone);
  if (bucket === "week") return addLocalDays(timestamp, 7, timezone);
  const shifted = new Date(Date.UTC(date.year, date.month, 1));
  return zonedTimeToUtc({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  }, timezone);
}

export function chooseUsageBucket(from: number, to: number, requested?: UsageBucket): UsageBucket {
  if (requested) return requested;
  const days = Math.max(0, (to - from) / DAY_MS);
  if (days <= 2) return "hour";
  if (days <= 45) return "day";
  if (days <= 180) return "week";
  return "month";
}

function namedRangeDays(range: Exclude<UsageRangePreset, "all" | "custom">): number {
  return range === "7d" ? 7 : range === "30d" ? 30 : 90;
}

export function presetDays(range: UsageRangePreset): number | null {
  if (range === "7d" || range === "30d" || range === "90d") return namedRangeDays(range);
  return null;
}

export function resolveUsageRange(
  query: UsageStatsQuery,
  now: number,
): { range: UsageRangePreset; from: number; to: number } {
  if (query.range === "custom") {
    if (!Number.isFinite(query.from) || !Number.isFinite(query.to) || query.from! >= query.to!) {
      throw Object.assign(new Error("custom usage range requires from < to"), { code: "invalid-input" });
    }
    return { range: "custom", from: query.from!, to: query.to! };
  }
  if (query.range === "all") return { range: "all", from: 0, to: now + 1 };
  const days = namedRangeDays(query.range);
  const today = startOfLocalDay(now, query.timezone);
  const from = addLocalDays(today, -(days - 1), query.timezone);
  const to = addLocalDays(today, 1, query.timezone);
  return { range: query.range, from, to };
}

export function precedingEquivalentRange(
  range: UsageRangePreset,
  from: number,
  to: number,
  timezone: string,
): { from: number; to: number } | null {
  const namedDays = presetDays(range);
  if (namedDays !== null) {
    return { from: addLocalDays(from, -namedDays, timezone), to: from };
  }
  if (range === "all") return null;
  // Custom date ranges are shifted by local calendar days. Using the host's
  // 24-hour arithmetic here would mis-size ranges across DST transitions.
  const startDay = startOfLocalDay(from, timezone);
  const endDay = startOfLocalDay(to, timezone);
  const start = zonedParts(startDay, timezone);
  const end = zonedParts(endDay, timezone);
  const calendarDays = Math.max(1, Math.round(
    (Date.UTC(end.year, end.month - 1, end.day) -
      Date.UTC(start.year, start.month - 1, start.day)) / DAY_MS,
  ));
  return { from: addLocalDays(from, -calendarDays, timezone), to: from };
}

export function usageBucketLabel(start: number, bucket: UsageBucket, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = bucket === "month"
    ? { month: "short", year: "numeric" }
    : bucket === "week"
      ? { month: "short", day: "numeric" }
      : bucket === "day"
        ? { month: "short", day: "numeric" }
        : { hour: "numeric" };
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...options }).format(start);
}
