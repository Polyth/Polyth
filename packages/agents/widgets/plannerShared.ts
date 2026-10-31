import type { ScheduleCadenceDto, ScheduleTaskDto } from "@polyth/session/web-api";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  cadenceToView,
  formatClock,
  formatWeekdays,
  monthlyDayNeedsApplicableMonthsCopy,
  type PlannerCadence,
} from "../src/cadenceView.ts";
import { cadenceOfTask as cadenceOfTaskSource } from "../src/plannerTask.ts";

export function cadenceOfTask(task: ScheduleTaskDto): PlannerCadence | null {
  return cadenceOfTaskSource(task);
}

/** `m h * * *`: once a day. It stays the cron it was written as (a no-op
 *  save must not rewrite it), but reads like the planner's own daily time. */
function dailyClock(expression: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(expression.trim());
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  return minute <= 59 && hour <= 23 ? { hour, minute } : null;
}

export function recurrenceSummary(
  cadence: ScheduleCadenceDto | PlannerCadence | null | undefined,
  options: { includeTime?: boolean; compact?: boolean } = {},
): string {
  const locale = getLocale();
  const includeTime = options.includeTime !== false;
  const compact = options.compact === true;
  const view = cadenceToView(cadence ?? undefined, locale);
  if (view.mode === "once") return tr("scheduleview.once");
  if (view.mode === "interval") return tr("scheduleview.everyMinutesValue", { minutes: view.everyMinutes });
  const daily = view.mode === "weekly" && new Set(view.days).size === 7 ? view
    : view.mode === "legacy-cron" ? dailyClock(view.expression) : null;
  if (daily) {
    return includeTime
      ? tr("scheduleview.everyDayAtValue", { time: formatClock(daily.hour, daily.minute, locale) })
      : tr("scheduleview.everyDay");
  }
  if (view.mode === "weekly") {
    const days = formatWeekdays(view.days, locale);
    const time = formatClock(view.hour, view.minute, locale);
    if (!includeTime) {
      return view.days.length === 1
        ? tr("scheduleview.everyWeekdayValue", { day: days })
        : days;
    }
    if (compact) return `${days} · ${time}`;
    return tr("scheduleview.weeklyOnValueAtValue", {
      days,
      time,
    });
  }
  if (view.mode === "monthly") {
    const time = formatClock(view.hour, view.minute, locale);
    if (!includeTime) {
      const key = monthlyDayNeedsApplicableMonthsCopy(view.dayOfMonth)
        ? "scheduleview.monthlyOnDayApplicableValue"
        : "scheduleview.monthlyOnDayValue";
      return tr(key, { day: view.dayOfMonth });
    }
    if (compact) {
      if (monthlyDayNeedsApplicableMonthsCopy(view.dayOfMonth)) {
        return tr("scheduleview.monthlyOnDayApplicableAtValue", {
          day: view.dayOfMonth,
          time,
        });
      }
      return `${tr("scheduleview.monthly")} · ${tr("scheduleview.monthlyOnDayValue", { day: view.dayOfMonth })} · ${time}`;
    }
    const key = monthlyDayNeedsApplicableMonthsCopy(view.dayOfMonth)
      ? "scheduleview.monthlyOnDayApplicableAtValue"
      : "scheduleview.monthlyOnDayValueAtValue";
    return tr(key, {
      day: view.dayOfMonth,
      time,
    });
  }
  if (view.description) return tr("scheduleview.customScheduleValue", { description: view.description });
  return tr("scheduleview.customSchedule");
}
