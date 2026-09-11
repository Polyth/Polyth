import type { CoachHomeDto } from "./api.ts";
import { t } from "./strings.ts";

const clock = (minuteOfDay?: number): string | null =>
  minuteOfDay === undefined
    ? null
    : `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;

/**
 * One short secondary line for the sidebar entry, chosen by what is most worth
 * knowing right now. The sidebar is navigation, not a dashboard: exactly one
 * phrase, or nothing at all.
 *
 * Kept in a plain `.ts` module (no JSX) so node:test can cover the priority
 * order directly, the same way the shell keeps its DOM-free logic testable.
 */
export function coachNavStatus(home: CoachHomeDto | undefined): string | null {
  if (!home) return null;
  if (home.profile.onboardingState !== "complete") return null;
  if (home.attention.overdueTotal > 0) return t("coach.attention.overdue", { count: home.attention.overdueTotal });
  if (home.suggestionCount > 0) return `${home.suggestionCount} ${t("coach.review.suggestions").toLowerCase()}`;
  if (home.reviewDue) return t("coach.review.weeklyTitle");
  if (home.today.focus) return home.today.focus.title;
  const nextRoutine = home.today.routines.find((due) => !due.status);
  const at = clock(nextRoutine?.routine.preferredMinuteOfDay);
  if (nextRoutine && at) return `${nextRoutine.routine.title} · ${at}`;
  if (home.today.total === 0) return t("coach.today.clear");
  return null;
}
