import type { ReactNode } from "react";
import type { CoachUi } from "./parts.tsx";
import { CheckIn, formatEstimate, formatWhen, isPrimaryGoal } from "./parts.tsx";
import type { CoachClient } from "./store.ts";
import { useCoach } from "./store.ts";
import { t } from "./strings.ts";

/**
 * The small dashboard widgets. They are glances, not a second Coach app: each
 * shows one fact and at most one deterministic action, and every one of them
 * reads the same shared projection as the workspace.
 */
function WidgetShell({ children, label }: { children: ReactNode; label: string }) {
  return <section className="personal-coach-root coach-widget" aria-label={label}>{children}</section>;
}

function Status({ client, ui, label }: { client: CoachClient; ui: CoachUi; label: string }) {
  const { error } = useCoach(client);
  const { EmptyState } = ui;
  return <WidgetShell label={label}>
    {error
      ? <EmptyState title={t("coach.workspace.refreshFailed")} description={error}
          actionLabel={t("coach.workspace.retry")} onAction={() => void client.refresh()} />
      : <div className="coach-loading" role="status">{t("coach.workspace.loading")}</div>}
  </WidgetShell>;
}

export function TodayWidget({ client, ui }: { client: CoachClient; ui: CoachUi }) {
  const snapshot = useCoach(client);
  const { Button } = ui;
  if (!snapshot.home) return <Status client={client} ui={ui} label={t("coach.tab.today")} />;
  const home = snapshot.home;
  const focus = home.today.focus;
  return <WidgetShell label={t("coach.tab.today")}>
    <div className="coach-widget-label">{t("coach.today.focus")}</div>
    <strong className="coach-widget-focus">{focus?.title ?? t("coach.today.clear")}</strong>
    {focus && <span className="coach-meta">
      {formatEstimate(focus.estimateMinutes) ?? formatWhen(focus.dueAt ?? focus.plannedFor, home.profile.timeZone) ?? ""}
    </span>}
    <div className="coach-widget-actions">
      {focus && <Button size="sm" busy={snapshot.busy.has(`commitment:${focus.id}`)}
        onClick={() => void client.complete(focus.id)}>{t("coach.action.done")}</Button>}
      <Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")}
        onClick={() => void client.talk()}>{t("coach.ask.label")}</Button>
    </div>
  </WidgetShell>;
}

export function NextActionWidget({ client, ui }: { client: CoachClient; ui: CoachUi }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <Status client={client} ui={ui} label={t("coach.upcoming.title")} />;
  const home = snapshot.home;
  const next = home.upcoming.next;
  return <WidgetShell label={t("coach.upcoming.title")}>
    <div className="coach-widget-label">{t("coach.upcoming.title")}</div>
    <strong className="coach-widget-focus">{next?.title ?? t("coach.upcoming.empty")}</strong>
    {next && <span className="coach-meta">
      {formatWhen(next.dueAt ?? next.plannedFor, home.profile.timeZone) ?? t("coach.upcoming.unscheduled")}
    </span>}
  </WidgetShell>;
}

export function AttentionWidget({ client, ui }: { client: CoachClient; ui: CoachUi }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <Status client={client} ui={ui} label={t("coach.attention.title")} />;
  const home = snapshot.home;
  const parts = [
    home.attention.overdueTotal > 0 ? t("coach.attention.overdue", { count: home.attention.overdueTotal }) : null,
    home.suggestionCount > 0 ? t("coach.review.suggestions") : null,
  ].filter(Boolean);
  return <WidgetShell label={t("coach.attention.title")}>
    <div className="coach-widget-label">{t("coach.attention.title")}</div>
    <strong className="coach-widget-focus">{parts.length ? parts.join(" · ") : t("coach.review.empty")}</strong>
  </WidgetShell>;
}

export function GoalWidget({ client, ui }: { client: CoachClient; ui: CoachUi }) {
  const snapshot = useCoach(client);
  const { Button } = ui;
  if (!snapshot.home) return <Status client={client} ui={ui} label={t("coach.goals.title")} />;
  const goal = snapshot.home.activeGoals.find(isPrimaryGoal) ?? snapshot.home.activeGoals[0];
  return <WidgetShell label={t("coach.goals.title")}>
    <div className="coach-widget-label">{goal && isPrimaryGoal(goal) ? t("coach.goals.primary") : t("coach.goals.title")}</div>
    <strong className="coach-widget-focus">{goal?.title ?? t("coach.goals.empty")}</strong>
    {goal?.desiredOutcome && <span className="coach-meta">{goal.desiredOutcome}</span>}
    {!goal && <Button size="sm" variant="ghost" busy={snapshot.busy.has("talk")}
      onClick={() => void client.talk()}>{t("coach.ask.label")}</Button>}
  </WidgetShell>;
}

export function CheckInWidget({ client, ui }: { client: CoachClient; ui: CoachUi }) {
  const snapshot = useCoach(client);
  if (!snapshot.home) return <Status client={client} ui={ui} label={t("coach.checkin.title")} />;
  return <WidgetShell label={t("coach.checkin.title")}>
    <div className="coach-widget-label">{t("coach.checkin.title")}</div>
    <CheckIn client={client} ui={ui} />
  </WidgetShell>;
}
