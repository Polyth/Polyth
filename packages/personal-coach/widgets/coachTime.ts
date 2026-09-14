const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

export type CoachMoveTarget = "today" | "later" | "tomorrow" | "week";

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let value = dateFormatters.get(timeZone);
  if (value) return value;
  value = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dateFormatters.set(timeZone, value);
  return value;
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let value = offsetFormatters.get(timeZone);
  if (value) return value;
  value = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  offsetFormatters.set(timeZone, value);
  return value;
}

function part(parts: Intl.DateTimeFormatPart[], type: string): number {
  return Number(parts.find((item) => item.type === type)?.value);
}

export function coachLocalDateKey(epochMs: number, timeZone: string): string {
  const parts = dateFormatter(timeZone).formatToParts(epochMs);
  const year = part(parts, "year");
  const month = part(parts, "month");
  const day = part(parts, "day");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function offsetAt(epochMs: number, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(epochMs);
  const asUtc = Date.UTC(
    part(parts, "year"),
    part(parts, "month") - 1,
    part(parts, "day"),
    part(parts, "hour"),
    part(parts, "minute"),
    part(parts, "second"),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) throw new Error("invalid Coach date");
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

/** Resolve a wall-clock time in the Coach profile timezone to an epoch value.
 * Two offset passes keep targets correct across DST boundaries without making
 * the package depend on the browser/device timezone. */
export function coachLocalEpoch(dateKey: string, minuteOfDay: number, timeZone: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) throw new Error("invalid Coach date");
  const minute = Math.max(0, Math.min(1439, Math.trunc(minuteOfDay)));
  const guess = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

/**
 * Targets behind the Move menu are Coach-calendar decisions, not browser-clock
 * decisions. `today` deliberately uses the current instant: it is guaranteed
 * to belong to the current local day in every timezone and avoids inventing an
 * arbitrary hour. Tomorrow/next week resolve 09:00 in the Coach timezone.
 */
export function coachMoveTarget(
  timeZone: string,
  target: CoachMoveTarget,
  now = Date.now(),
): number {
  if (target === "today") return now;
  try {
    const today = coachLocalDateKey(now, timeZone);
    if (target === "tomorrow") return coachLocalEpoch(addDays(today, 1), 9 * 60, timeZone);
    if (target === "week") return coachLocalEpoch(addDays(today, 7), 9 * 60, timeZone);

    const candidate = now + 3 * 60 * 60 * 1000;
    if (coachLocalDateKey(candidate, timeZone) === today) return candidate;
    const endOfDay = coachLocalEpoch(today, 23 * 60 + 30, timeZone);
    return endOfDay > now ? endOfDay : now;
  } catch {
    if (target === "tomorrow") return now + 24 * 60 * 60 * 1000;
    if (target === "week") return now + 7 * 24 * 60 * 60 * 1000;
    return now + 3 * 60 * 60 * 1000;
  }
}
