import type { ScheduleCadenceDto, ScheduleTaskDto } from "@polyth/session/web-api";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  cadenceToView,
  formatClock,
  formatOnceSummary,
  formatWeekdays,
  monthlyDayNeedsApplicableMonthsCopy,
  type PlannerCadence,
} from "../src/cadenceView.ts";
import { formatPlannerRowTime, type PlannerGroupKind } from "../src/plannerList.ts";
import { cadenceOfTask as cadenceOfTaskSource } from "../src/plannerTask.ts";

export function cadenceOfTask(task: ScheduleTaskDto): PlannerCadence | null {
  return cadenceOfTaskSource(task);
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

export function formatTaskTime(
  nextRunAt: number,
  _now: number,
  groupKind: PlannerGroupKind = "date",
): string {
  if (groupKind === "paused" || groupKind === "unscheduled" || groupKind === "completed") return "";
  return formatPlannerRowTime(nextRunAt, groupKind, getLocale());
}

export function formatOnceWhen(at: number): string {
  return formatOnceSummary(at, getLocale());
}

export function isLoopFile(task: Pick<ScheduleTaskDto, "source">): boolean {
  return task.source === "loop-file";
}
