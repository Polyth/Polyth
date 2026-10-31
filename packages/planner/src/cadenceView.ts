// Browser-safe cadence view-model. Widgets and Node tests share this file.
// It must not import `cron.ts` (cron-parser) or any filesystem API.
//
// Daily/weekly/monthly expressions we generate are 5-field cron with integer
// minute/hour and `m h * * *`, `m h * * dow` or `m h dom * *`. Anything else —
// ranges, steps, names, mixed DOM+DOW — stays `legacy-cron` so a no-op save
// cannot rewrite it.

import type { PlannerCadence } from "./model.ts";

export type { PlannerCadence };

export type CadenceView =
  | { mode: "once"; at: number }
  | { mode: "daily"; hour: number; minute: number; timeZone: string }
  | { mode: "weekly"; days: number[]; hour: number; minute: number; timeZone: string }
  | { mode: "monthly"; dayOfMonth: number; hour: number; minute: number; timeZone: string }
  | { mode: "interval"; everyMinutes: number }
  | { mode: "legacy-cron"; expression: string; timeZone: string; description: string };

export interface CadenceViewValidation {
  ok: boolean;
  error?: string;
}

const INT = /^\d+$/;
const SUNDAY_UTC = Date.UTC(2024, 0, 7); // a known Sunday

function isIntInRange(raw: string, min: number, max: number): number | null {
  if (!INT.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function uniqueSorted(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function compactZoneChoices(current?: string): string[] {
  const zones = [localTimeZone(), "UTC"];
  if (current?.trim()) zones.push(current.trim());
  return [...new Set(zones)];
}

/** Cron DOW: 0 = Sunday … 6 = Saturday (same numbering as `cron.ts`). */
export function weekdayNames(locale: string, style: "short" | "long" | "narrow" = "short"): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, day) => formatter.format(new Date(SUNDAY_UTC + day * 86_400_000)));
}

export function formatWeekdays(days: number[], locale: string, style: "short" | "long" = "short"): string {
  const names = weekdayNames(locale, style);
  const labels = uniqueSorted(days).map((day) => names[day] ?? String(day));
  try {
    return new Intl.ListFormat(locale, { style: "narrow", type: "conjunction" }).format(labels);
  } catch {
    return labels.join(", ");
  }
}

export function formatClock(hour: number, minute: number, locale: string): string {
  const stamp = Date.UTC(2024, 0, 1, hour, minute);
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(stamp));
}

function zonedParts(at: number, timeZone: string): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(read("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(read("minute"));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[read("weekday")] ?? 0;
  return {
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    weekday,
  };
}

/** Best-effort isomorphic summary. UI may wrap this with a "Custom schedule" label. */
export function describeCronExpression(expression: string, locale = "en"): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const clock = isIntInRange(min, 0, 59) !== null && isIntInRange(hour, 0, 23) !== null
    ? formatClock(Number(hour), Number(min), locale)
    : `${hour}:${min}`;
  const bits = [clock];
  if (dow !== "*") {
    const days = parseDowList(dow);
    bits.push(days ? formatWeekdays(days, locale) : dow);
  }
  if (dom !== "*") bits.push(dom);
  if (month !== "*") bits.push(month);
  return bits.join(" · ");
}

function parseDowList(spec: string): number[] | null {
  const parts = spec.split(",");
  const days: number[] = [];
  for (const part of parts) {
    const n = isIntInRange(part, 0, 6);
    if (n === null) return null;
    days.push(n);
  }
  return days.length > 0 ? uniqueSorted(days) : null;
}

function parseDailyCron(expression: string, timeZone: string): Extract<CadenceView, { mode: "daily" }> | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (dom !== "*" || month !== "*" || dow !== "*") return null;
  const minute = isIntInRange(min, 0, 59);
  const hourN = isIntInRange(hour, 0, 23);
  if (minute === null || hourN === null) return null;
  return { mode: "daily", hour: hourN, minute, timeZone };
}

function parseWeeklyCron(expression: string, timeZone: string): Extract<CadenceView, { mode: "weekly" }> | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (dom !== "*" || month !== "*") return null;
  const minute = isIntInRange(min, 0, 59);
  const hourN = isIntInRange(hour, 0, 23);
  const days = parseDowList(dow);
  if (minute === null || hourN === null || !days) return null;
  return { mode: "weekly", days, hour: hourN, minute, timeZone };
}

function parseMonthlyCron(expression: string, timeZone: string): Extract<CadenceView, { mode: "monthly" }> | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (month !== "*" || dow !== "*") return null;
  const minute = isIntInRange(min, 0, 59);
  const hourN = isIntInRange(hour, 0, 23);
  const dayOfMonth = isIntInRange(dom, 1, 31);
  if (minute === null || hourN === null || dayOfMonth === null) return null;
  return { mode: "monthly", dayOfMonth, hour: hourN, minute, timeZone };
}

export function cadenceToView(cadence: PlannerCadence | undefined | null, locale = "en"): CadenceView {
  if (!cadence) return { mode: "legacy-cron", expression: "", timeZone: localTimeZone(), description: "" };
  if (cadence.kind === "at") return { mode: "once", at: cadence.at };
  if (cadence.kind === "every") return { mode: "interval", everyMinutes: cadence.everyMinutes };
  const daily = parseDailyCron(cadence.expression, cadence.timeZone);
  if (daily) return daily;
  const weekly = parseWeeklyCron(cadence.expression, cadence.timeZone);
  if (weekly) return weekly;
  const monthly = parseMonthlyCron(cadence.expression, cadence.timeZone);
  if (monthly) return monthly;
  return {
    mode: "legacy-cron",
    expression: cadence.expression,
    timeZone: cadence.timeZone,
    description: describeCronExpression(cadence.expression, locale),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function viewToCadence(view: CadenceView): PlannerCadence {
  if (view.mode === "once") return { kind: "at", at: view.at };
  if (view.mode === "interval") return { kind: "every", everyMinutes: view.everyMinutes };
  if (view.mode === "legacy-cron") {
    return { kind: "cron", expression: view.expression, timeZone: view.timeZone };
  }
  if (view.mode === "daily") {
    return { kind: "cron", expression: `${view.minute} ${view.hour} * * *`, timeZone: view.timeZone };
  }
  if (view.mode === "weekly") {
    const days = uniqueSorted(view.days);
    return {
      kind: "cron",
      expression: `${view.minute} ${view.hour} * * ${days.join(",")}`,
      timeZone: view.timeZone,
    };
  }
  return {
    kind: "cron",
    expression: `${view.minute} ${view.hour} ${view.dayOfMonth} * *`,
    timeZone: view.timeZone,
  };
}

export function validateCadenceView(view: CadenceView): CadenceViewValidation {
  if (view.mode === "once") {
    if (typeof view.at !== "number" || !Number.isFinite(view.at)) {
      return { ok: false, error: "at (epoch ms) is required for one-shot tasks" };
    }
    return { ok: true };
  }
  if (view.mode === "interval") {
    if (!Number.isFinite(view.everyMinutes) || view.everyMinutes < 1) {
      return { ok: false, error: "everyMinutes must be a finite number >= 1" };
    }
    return { ok: true };
  }
  if (view.mode === "legacy-cron") {
    const fields = view.expression.trim().split(/\s+/);
    if (fields.length !== 5) return { ok: false, error: "expected 5 fields" };
    if (!view.timeZone.trim()) return { ok: false, error: "time zone is required" };
    return { ok: true };
  }
  if (view.hour < 0 || view.hour > 23 || !Number.isInteger(view.hour)) {
    return { ok: false, error: "hour must be 0–23" };
  }
  if (view.minute < 0 || view.minute > 59 || !Number.isInteger(view.minute)) {
    return { ok: false, error: "minute must be 0–59" };
  }
  if (!view.timeZone.trim()) return { ok: false, error: "time zone is required" };
  if (view.mode === "daily") return { ok: true };
  if (view.mode === "weekly") {
    const days = uniqueSorted(view.days);
    if (days.length === 0 || days.some((day) => day < 0 || day > 6 || !Number.isInteger(day))) {
      return { ok: false, error: "pick at least one weekday" };
    }
    return { ok: true };
  }
  if (!Number.isInteger(view.dayOfMonth) || view.dayOfMonth < 1 || view.dayOfMonth > 31) {
    return { ok: false, error: "day of month must be 1–31" };
  }
  return { ok: true };
}

/**
 * Read-only view for labels: weekday ranges ("1-5") and 7-as-Sunday are
 * expanded so "0 9 * * 1-5" reads as weekdays. The editor keeps using
 * `cadenceToView`, which never rewrites an expression it cannot round-trip.
 */
export function cadenceToDisplayView(cadence: PlannerCadence | undefined | null, locale = "en"): CadenceView {
  const view = cadenceToView(cadence, locale);
  if (view.mode !== "legacy-cron") return view;
  const fields = view.expression.trim().split(/\s+/);
  if (fields.length !== 5) return view;
  const days: number[] = [];
  for (const part of fields[4]!.split(",")) {
    const bounds = part.split("-");
    if (bounds.length > 2) return view;
    const start = isIntInRange(bounds[0]!, 0, 7);
    const end = isIntInRange(bounds[1] ?? bounds[0]!, 0, 7);
    if (start === null || end === null || end < start) return view;
    for (let day = start; day <= end; day++) days.push(day % 7);
  }
  fields[4] = uniqueSorted(days).join(",");
  const expanded = cadenceToView({ kind: "cron", expression: fields.join(" "), timeZone: view.timeZone }, locale);
  return expanded.mode === "weekly" ? expanded : view;
}

export function cadencesEqual(a: PlannerCadence, b: PlannerCadence): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "at" && b.kind === "at") return a.at === b.at;
  if (a.kind === "every" && b.kind === "every") return a.everyMinutes === b.everyMinutes;
  if (a.kind === "cron" && b.kind === "cron") {
    if (a.timeZone !== b.timeZone) return false;
    if (a.expression.trim() === b.expression.trim()) return true;
    const left = cadenceToView(a);
    const right = cadenceToView(b);
    if (left.mode === "daily" && right.mode === "daily") {
      return left.hour === right.hour && left.minute === right.minute;
    }
    if (left.mode === "weekly" && right.mode === "weekly") {
      return left.hour === right.hour
        && left.minute === right.minute
        && uniqueSorted(left.days).join(",") === uniqueSorted(right.days).join(",");
    }
    if (left.mode === "monthly" && right.mode === "monthly") {
      return left.hour === right.hour
        && left.minute === right.minute
        && left.dayOfMonth === right.dayOfMonth;
    }
    return false;
  }
  return false;
}

/** Next local hour, minutes zeroed. 14:11 → 15:00; 23:40 → 00:00 the next day. */
export function defaultOnceView(now = Date.now()): Extract<CadenceView, { mode: "once" }> {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(0);
  next.setHours(next.getHours() + 1);
  return { mode: "once", at: next.getTime() };
}

export function formatOnceDate(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(at));
}

export function formatOnceTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

export function formatOnceSummary(at: number, locale: string): string {
  return `${formatOnceDate(at, locale)} · ${formatOnceTime(at, locale)}`;
}

export function toDateValue(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function combineDateAndTime(dateValue: string, timeValue: string): number {
  return fromDatetimeLocalValue(`${dateValue}T${timeValue}`);
}

export function defaultWeeklyView(
  now = Date.now(),
  timeZone = localTimeZone(),
): Extract<CadenceView, { mode: "weekly" }> {
  const parts = zonedParts(now, timeZone);
  return {
    mode: "weekly",
    days: [parts.weekday],
    hour: parts.hour,
    minute: parts.minute,
    timeZone,
  };
}

/** Inherit a Once instant when switching Once → Every (weekday + clock, not "now"). */
export function weeklyViewFromOnce(
  at: number,
  timeZone = localTimeZone(),
): Extract<CadenceView, { mode: "weekly" }> {
  const parts = zonedParts(at, timeZone);
  return {
    mode: "weekly",
    days: [parts.weekday],
    hour: parts.hour,
    minute: parts.minute,
    timeZone,
  };
}

/** Days 29–31 do not fire in every month; summaries must not say "every month". */
export function monthlyDayNeedsApplicableMonthsCopy(dayOfMonth: number): boolean {
  return dayOfMonth > 28;
}

export function defaultMonthlyView(
  now = Date.now(),
  timeZone = localTimeZone(),
): Extract<CadenceView, { mode: "monthly" }> {
  const parts = zonedParts(now, timeZone);
  const day = new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" }).format(new Date(now));
  const dayOfMonth = Math.min(31, Math.max(1, Number(day) || 1));
  return {
    mode: "monthly",
    dayOfMonth,
    hour: parts.hour,
    minute: parts.minute,
    timeZone,
  };
}

export function toDatetimeLocalValue(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fromDatetimeLocalValue(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

export function toTimeValue(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function fromTimeValue(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export type CadenceMode = CadenceView["mode"];

/** The clock a view fires at, read in the browser's zone for a one-shot. */
export function clockOfView(view: CadenceView, now = Date.now()): { hour: number; minute: number } {
  if (view.mode === "daily" || view.mode === "weekly" || view.mode === "monthly") {
    return { hour: view.hour, minute: view.minute };
  }
  const at = new Date(view.mode === "once" ? view.at : now);
  if (view.mode !== "once") {
    at.setMinutes(0, 0, 0);
    at.setHours(at.getHours() + 1);
  }
  return { hour: at.getHours(), minute: at.getMinutes() };
}

/** The next moment the chosen clock comes round (today, else tomorrow). */
export function onceAtClock(hour: number, minute: number, now = Date.now()): Extract<CadenceView, { mode: "once" }> {
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return Number.isFinite(at.getTime()) ? { mode: "once", at: at.getTime() } : defaultOnceView(now);
}

/** Mode switch that carries the chosen clock (and a one-shot's day) across
 *  modes, so flipping between them never resets what was already picked. */
export function switchCadenceMode(view: CadenceView, mode: CadenceMode, now = Date.now()): CadenceView {
  if (mode === view.mode) return view;
  const { hour, minute } = clockOfView(view, now);
  const timeZone = "timeZone" in view && view.timeZone ? view.timeZone : localTimeZone();
  const anchor = view.mode === "once" ? new Date(view.at) : new Date(now);
  if (mode === "once") return onceAtClock(hour, minute, now);
  if (mode === "daily") return { mode, hour, minute, timeZone };
  if (mode === "weekly") {
    const days = view.mode === "weekly" ? view.days : [anchor.getDay()];
    return { mode, days, hour, minute, timeZone };
  }
  if (mode === "monthly") return { mode, dayOfMonth: anchor.getDate(), hour, minute, timeZone };
  if (mode === "interval") return { mode, everyMinutes: view.mode === "interval" ? view.everyMinutes : 60 };
  const base = view.mode === "daily" || view.mode === "weekly" || view.mode === "monthly" ? viewToCadence(view) : null;
  const expression = base?.kind === "cron" ? base.expression : `${minute} ${hour} * * *`;
  return { mode: "legacy-cron", expression, timeZone, description: "" };
}

export type OncePreset = "in-hour" | "this-evening" | "tomorrow-morning" | "next-monday";

/** Quick one-shot times. "This evening" rolls to tomorrow once 19:00 passed. */
export function oncePresetAt(preset: OncePreset, now = Date.now()): number {
  const at = new Date(now);
  at.setSeconds(0, 0);
  if (preset === "in-hour") {
    at.setMinutes(at.getMinutes() + 60);
    return at.getTime();
  }
  if (preset === "this-evening") return onceAtClock(19, 0, now).at;
  if (preset === "tomorrow-morning") {
    at.setDate(at.getDate() + 1);
    at.setHours(9, 0, 0, 0);
    return at.getTime();
  }
  const days = ((8 - at.getDay()) % 7) || 7;
  at.setDate(at.getDate() + days);
  at.setHours(9, 0, 0, 0);
  return at.getTime();
}

/** Interval split for the editor: whole hours read as hours. */
export function intervalParts(everyMinutes: number): { value: number; unit: "minutes" | "hours" } {
  return everyMinutes >= 60 && everyMinutes % 60 === 0
    ? { value: everyMinutes / 60, unit: "hours" }
    : { value: everyMinutes, unit: "minutes" };
}

/** "in 2 hours", "in 5 minutes", "2 days ago" — the largest whole unit. */
export function formatRelative(target: number, now: number, locale: string): string {
  const diff = target - now;
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  let format: Intl.RelativeTimeFormat;
  try {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
  for (const [unit, size] of units) {
    if (abs >= size || unit === "minute") {
      const value = Math.round(diff / size);
      return format.format(value === 0 ? 0 : value, unit);
    }
  }
  return format.format(0, "minute");
}
