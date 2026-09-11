import { useId, useState } from "react";
import {
  ActionRow,
  CheckIn,
  CoachError,
  RoutineRow,
  startOfToday,
  type CoachUiProps,
} from "./parts.tsx";
import { useCoach } from "./store.ts";
import { t } from "./strings.ts";

/**
 * Adding here means "for today" and says so. The goal detail surface has its
 * own control which deliberately creates an unscheduled next action instead.
 */
function AddForToday({ api, client, ui, friendlyError }: CoachUiProps) {
  const { Button, TextInput } = ui;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  return <form className="coach-add" onSubmit={(event) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    void api.createCommitment({ title: text.trim(), plannedFor: startOfToday() })
      .then(async () => { setText(""); await client.refresh(); })
      .catch((cause) => setError(friendlyError(t("coach.error.addAction"), cause)))
      .finally(() => setBusy(false));
  }}>
    <label className="coach-field" htmlFor={id}>
      <span>{t("coach.today.addLabel")}</span>
      <TextInput
        {...{ id, maxLength: 240 }}
        value={text}
        placeholder={t("coach.today.addPlaceholder")}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />
    </label>
    <Button type="submit" size="sm" busy={busy} disabled={!text.trim()}>{t("coach.today.add")}</Button>
    {error && <CoachError message={error} ui={ui} />}
  </form>;
}

export default function TodayPanel(props: CoachUiProps) {
  const { client, ui } = props;
  const snapshot = useCoach(client);
  const home = snapshot.home;
  if (!home) return null;
  const goalOf = (goalId?: string) => goalId ? home.activeGoals.find((goal) => goal.id === goalId) : undefined;

  return <div className="coach-stack">
    <AddForToday {...props} />

    <section className="coach-panel" aria-label={t("coach.tab.today")}>
      <header className="coach-panel-head">
        <h3>{t("coach.tab.today")}</h3>
        {home.today.total > home.today.actions.length && (
          <span className="coach-meta">{t("coach.today.moreCount", { count: home.today.total - home.today.actions.length })}</span>
        )}
      </header>
      {home.today.actions.length === 0
        ? <p className="coach-quiet">{t("coach.today.clearHint")}</p>
        : <div className="coach-list">
            {home.today.actions.map((item) => (
              <ActionRow
                key={item.id}
                item={item}
                client={client}
                ui={ui}
                {...(goalOf(item.goalId) ? { goal: goalOf(item.goalId)! } : {})}
                {...(home.profile.timeZone ? { timeZone: home.profile.timeZone } : {})}
              />
            ))}
          </div>}
      {home.attention.overloaded && <p className="coach-meta">{t("coach.attention.overloaded")}</p>}
    </section>

    {home.attention.overdueTotal > 0 && (
      <section className="coach-panel" aria-label={t("coach.attention.title")}>
        <header className="coach-panel-head">
          <h3>{t("coach.attention.title")}</h3>
          <span className="coach-meta">{t("coach.attention.overdue", { count: home.attention.overdueTotal })}</span>
        </header>
        <div className="coach-list">
          {home.attention.overdue.map((item) => (
            <ActionRow key={item.id} item={item} client={client} ui={ui} timeZone={home.profile.timeZone} />
          ))}
        </div>
      </section>
    )}

    {home.today.routines.length > 0 && (
      <section className="coach-panel" aria-label={t("coach.routines.title")}>
        <header className="coach-panel-head"><h3>{t("coach.routines.title")}</h3></header>
        <div className="coach-list">
          {home.today.routines.map((due) => <RoutineRow key={due.routine.id} due={due} client={client} ui={ui} />)}
        </div>
      </section>
    )}

    <section className="coach-panel" aria-label={t("coach.checkin.title")}>
      <header className="coach-panel-head">
        <h3>{t("coach.checkin.prompt")}</h3>
        <span className="coach-meta">{t("coach.checkin.optional")}</span>
      </header>
      <CheckIn client={client} ui={ui} />
      <p className="coach-meta">{t("coach.checkin.note")}</p>
    </section>
  </div>;
}
