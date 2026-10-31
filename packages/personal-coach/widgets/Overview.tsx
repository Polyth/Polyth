import type { ReactNode } from "react";
import type { CoachCommitmentDto, CoachHomeDto } from "./api.ts";
import {
  ActionControls,
  ActionRow,
  CheckIn,
  RoutineRow,
  formatEstimate,
  formatWhen,
  isPrimaryGoal,
  startOfToday,
  type CoachUiProps,
} from "./parts.tsx";
import { useCoach } from "./store.ts";
import { t } from "./strings.ts";

function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return t("coach.greeting.morning");
  if (hour < 18) return t("coach.greeting.afternoon");
  return t("coach.greeting.evening");
}

function longDate(key: string): string {
  // The projection's date is already the user's local day; render it without
  // re-applying a timezone, which would shift it a second time.
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return key;
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
      .format(new Date(year, month - 1, day));
  } catch {
    return key;
  }
}

/** A panel renders nothing at all when it has nothing to say. Empty states
 *  collapse instead of reserving decorative boxes. */
function Panel({ title, action, children }: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return <section className="coach-panel" aria-label={title}>
    <header className="coach-panel-head">
      <h3>{title}</h3>
      {action}
    </header>
    {children}
  </section>;
}

function Focus({ home, props }: { home: CoachHomeDto; props: CoachUiProps }) {
  const { client, ui } = props;
  const focus = home.today.focus;
  const goal = focus?.goalId ? home.activeGoals.find((item) => item.id === focus.goalId) : undefined;
  if (!focus) {
    return <section className="coach-focus coach-focus--clear" aria-label={t("coach.today.focus")}>
      <span className="coach-kicker">{t("coach.today.focus")}</span>
      <h2>{t("coach.today.clear")}</h2>
      <p className="coach-meta">{t("coach.today.clearHint")}</p>
    </section>;
  }
  const meta = [
    goal ? t("coach.today.towards", { title: goal.title }) : null,
    formatEstimate(focus.estimateMinutes),
    formatWhen(focus.dueAt ?? focus.plannedFor, home.profile.timeZone),
  ].filter(Boolean);
  return <section className="coach-focus" aria-label={t("coach.today.focus")}>
    <span className="coach-kicker">{t("coach.today.focus")}</span>
    <h2>{focus.title}</h2>
    {meta.length > 0 && <p className="coach-meta">{meta.join(" · ")}</p>}
    <ActionControls item={focus} client={client} ui={ui} />
  </section>;
}

function UpcomingItem({ item, props, timeZone }: {
  item: CoachCommitmentDto;
  props: CoachUiProps;
  timeZone?: string;
}) {
  const { client, ui } = props;
  const { Button } = ui;
  const { busy } = useCoach(client);
  const when = formatWhen(item.dueAt ?? item.plannedFor, timeZone) ?? t("coach.upcoming.unscheduled");
  return <div className="coach-row coach-row--quiet">
    <div className="coach-row-copy">
      <span className="coach-row-title">{item.title}</span>
      <span className="coach-meta">{when}</span>
    </div>
    <Button
      size="sm"
      variant="ghost"
      disabled={busy.has(`commitment:${item.id}`)}
      onClick={() => void client.reschedule(item.id, startOfToday())}
    >{t("coach.upcoming.moveToToday")}</Button>
  </div>;
}

export default function Overview(props: CoachUiProps & { onOpenGoal(id: string): void; onOpenReview(): void }) {
  const { client, ui, onOpenGoal, onOpenReview } = props;
  const { Button } = ui;
  const snapshot = useCoach(client);
  const home = snapshot.home;
  if (!home) return null;

  const upcoming = [...(home.upcoming.next ? [home.upcoming.next] : []), ...home.upcoming.items];
  const alsoToday = home.today.actions.filter((item) => item.id !== home.today.focus?.id);
  const needsReview = home.suggestionCount > 0 || home.reviewDue || Boolean(home.insight);

  return <div className="coach-overview">
    <header className="coach-overview-head">
      <span className="coach-kicker">{greeting(new Date())}</span>
      <h2>{longDate(home.date)}</h2>
    </header>

    <Focus home={home} props={props} />

    {home.attention.overdueTotal > 0 && (
      <Panel title={t("coach.attention.title")}>
        <p className="coach-meta">{t("coach.attention.overdue", { count: home.attention.overdueTotal })}</p>
        <div className="coach-list">
          {home.attention.overdue.map((item) => (
            <ActionRow key={item.id} item={item} client={client} ui={ui} timeZone={home.profile.timeZone} />
          ))}
        </div>
      </Panel>
    )}

    <div className="coach-grid">
      {alsoToday.length > 0 && (
        <Panel
          title={t("coach.today.alsoToday")}
          action={home.today.total > home.today.actions.length
            ? <span className="coach-meta">{t("coach.today.moreCount", { count: home.today.total - home.today.actions.length })}</span>
            : undefined}
        >
          <div className="coach-list">
            {alsoToday.map((item) => (
              <ActionRow key={item.id} item={item} client={client} ui={ui} timeZone={home.profile.timeZone} />
            ))}
          </div>
          {home.attention.overloaded && <p className="coach-meta">{t("coach.attention.overloaded")}</p>}
        </Panel>
      )}

      {upcoming.length > 0 && (
        <Panel
          title={t("coach.upcoming.title")}
          action={home.upcoming.total > upcoming.length
            ? <span className="coach-meta">{t("coach.upcoming.count", { count: home.upcoming.total })}</span>
            : undefined}
        >
          <div className="coach-list">
            {upcoming.map((item) => (
              <UpcomingItem key={item.id} item={item} props={props} timeZone={home.profile.timeZone} />
            ))}
          </div>
        </Panel>
      )}

      {home.activeGoals.length > 0 && (
        <Panel
          title={t("coach.goals.title")}
          action={<span className="coach-meta">{t("coach.goals.count", { count: home.activeGoalTotal })}</span>}
        >
          <div className="coach-list">
            {home.activeGoals.map((goal) => (
              <button
                key={goal.id}
                type="button"
                className="coach-row coach-row--button"
                aria-label={t("coach.goals.open", { title: goal.title })}
                onClick={() => onOpenGoal(goal.id)}
              >
                <span className="coach-row-copy">
                  <span className="coach-row-title">{goal.title}</span>
                  {goal.desiredOutcome && <span className="coach-meta">{goal.desiredOutcome}</span>}
                </span>
                {isPrimaryGoal(goal) && <span className="coach-badge">{t("coach.goals.primary")}</span>}
              </button>
            ))}
          </div>
        </Panel>
      )}

      {home.today.routines.length > 0 && (
        <Panel title={t("coach.routines.title")}>
          <div className="coach-list">
            {home.today.routines.map((due) => (
              <RoutineRow key={due.routine.id} due={due} client={client} ui={ui} />
            ))}
          </div>
        </Panel>
      )}

      <Panel title={t("coach.checkin.title")} action={<span className="coach-meta">{t("coach.checkin.optional")}</span>}>
        <CheckIn client={client} ui={ui} />
      </Panel>

      {needsReview && (
        <Panel
          title={t("coach.review.title")}
          action={home.suggestionCount > 0
            ? <span className="coach-badge">{t("coach.review.badge", { count: home.suggestionCount })}</span>
            : undefined}
        >
          {home.reviewDue && <p className="coach-meta">{t("coach.review.weeklyBody")}</p>}
          {home.insight && <p className="coach-quiet">{home.insight.statement}</p>}
          <Button size="sm" variant="ghost" onClick={onOpenReview}>{t("coach.review.title")}</Button>
        </Panel>
      )}
    </div>
  </div>;
}
