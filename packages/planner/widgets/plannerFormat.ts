import type { PlannerCadence } from "../src/model.ts";
import {
  cadenceToDisplayView,
  formatClock,
  formatOnceSummary,
  formatRelative,
  formatWeekdays,
  intervalParts,
} from "../src/cadenceView.ts";
import { t } from "./plannerText.ts";

const sameDays = (days: readonly number[], expected: readonly number[]) =>
  days.length === expected.length && expected.every((day) => days.includes(day));

/** Human cadence: "Weekdays at 09:00", "Every 2 h", "Once · Oct 15, 09:00".
 *  `short` drops the clock — list rows show it in their own column. */
export function cadenceSummary(cadence: PlannerCadence | null | undefined, locale: string, short = false): string {
  const view = cadenceToDisplayView(cadence ?? undefined, locale);
  if (view.mode === "once") return short ? t("summary.onceShort") : t("summary.once", { when: formatOnceSummary(view.at, locale) });
  if (view.mode === "interval") {
    const { value, unit } = intervalParts(view.everyMinutes);
    return t(unit === "hours" ? "summary.everyHours" : "summary.everyMinutes", { count: value });
  }
  if (view.mode === "legacy-cron") {
    if (short || !view.description) return t("summary.customShort");
    return t("summary.custom", { description: view.description });
  }
  const time = formatClock(view.hour, view.minute, locale);
  if (view.mode === "daily") return short ? t("summary.dailyShort") : t("summary.daily", { time });
  if (view.mode === "weekly") {
    if (view.days.length === 7) return short ? t("summary.dailyShort") : t("summary.daily", { time });
    if (sameDays(view.days, [1, 2, 3, 4, 5])) return short ? t("summary.weekdaysShort") : t("summary.weekdays", { time });
    if (sameDays(view.days, [0, 6])) return short ? t("summary.weekendsShort") : t("summary.weekends", { time });
    const days = formatWeekdays(view.days, locale, view.days.length === 1 ? "long" : "short");
    return short ? days : t("summary.weekly", { days, time });
  }
  return short
    ? t("summary.monthlyShort", { day: view.dayOfMonth })
    : t("summary.monthly", { day: view.dayOfMonth, time });
}

export function formatClockAt(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

const dayKey = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** The day of a run as a chat says it: "Today", "Tomorrow", a weekday within
 *  the coming week, else the date. */
export function formatRunDay(at: number, now: number, locale: string): string {
  if (dayKey(at) === dayKey(now)) return t("list.today");
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dayKey(at) === dayKey(tomorrow.getTime())) return t("list.tomorrow");
  const format = at - now < 6 * 86_400_000 ? { weekday: "short" } as const : { day: "numeric", month: "short" } as const;
  const day = new Intl.DateTimeFormat(locale, format).format(new Date(at));
  // It heads a time like "Today" does: "Пн", not "пн".
  return day.charAt(0).toLocaleUpperCase(locale) + day.slice(1);
}

/** When a planned run arrives, at a glance: "Due now", "in 12 minutes"
 *  within the hour, else "Tomorrow, 09:00". */
export function formatRunWhen(at: number, now: number, locale: string): string {
  if (at <= now + 30_000) return t("list.dueNow");
  if (at - now < 3_600_000) return formatRelative(at, now, locale);
  return t("chat.at", { day: formatRunDay(at, now, locale), time: formatClockAt(at, locale) });
}

export function formatDayHeading(dateKey: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "short", day: "numeric" })
    .format(new Date(`${dateKey}T12:00:00`));
}

export function formatPreviewRun(at: number, now: number, locale: string): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatDuration(ms: number, locale: string): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const unit = (value: number, name: "second" | "minute" | "hour") => {
    try {
      return new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
    } catch {
      return `${value}${name[0]}`;
    }
  };
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(minutes, "minute");
  return `${unit(Math.floor(minutes / 60), "hour")} ${unit(minutes % 60, "minute")}`;
}
