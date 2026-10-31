// When an agent wakes and why it stopped, in the reader's language.
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";

/** "today 08:30", "tomorrow 08:30", or "Tue, 14 Oct 08:30". */
export function formatWake(at: number, now = Date.now()): string {
  const locale = getLocale();
  const date = new Date(at);
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return tr("agents.todayAtValue", { time });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return tr("agents.tomorrowAtValue", { time });
  return `${date.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** Why a tripped agent stopped. */
export function trippedLine(task: ScheduleTaskDto): string {
  if (task.tripped?.reason === "budget") return tr("agents.trippedBudget");
  if (task.tripped?.reason === "failures") return tr("agents.trippedFailures", { count: task.pauseAfterFailures ?? 0 });
  return tr("agents.stateTripped");
}
