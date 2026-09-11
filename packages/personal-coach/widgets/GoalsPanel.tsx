import { useEffect, useId, useState, type ChangeEvent } from "react";
import type { CoachCommitmentDto, CoachGoalDto, CoachRoutineDto } from "./api.ts";
import {
  ActionRow,
  CoachError,
  formatClock,
  formatWhen,
  isPrimaryGoal,
  startOfToday,
  type CoachUiProps,
} from "./parts.tsx";
import { useCoach } from "./store.ts";
import { t } from "./strings.ts";

interface GoalsData {
  goals: CoachGoalDto[];
  commitments: CoachCommitmentDto[];
  routines: CoachRoutineDto[];
}

/** One shared load for the whole Goals area: the list and every detail view
 *  read the same snapshot rather than each firing its own request. */
function useGoalsData(props: CoachUiProps): {
  data: GoalsData | null;
  error: string;
  reload(): void;
} {
  const { api, client, friendlyError } = props;
  const snapshot = useCoach(client);
  const [data, setData] = useState<GoalsData | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    void Promise.all([api.goals(), api.commitments(), api.routines()])
      .then(([goals, commitments, routines]) => { if (live) setData({ goals, commitments, routines }); })
      .catch((cause) => { if (live) setError(friendlyError(t("coach.error.loadGoals"), cause)); });
    return () => { live = false; };
  }, [api, friendlyError, snapshot.home?.revision, attempt]);
  return { data, error, reload: () => setAttempt((n) => n + 1) };
}

function GoalEditor({ goal, onDone, props }: { goal: CoachGoalDto; onDone(): void; props: CoachUiProps }) {
  const { api, client, ui, friendlyError } = props;
  const { TextInput, Textarea, Button } = ui;
  const [title, setTitle] = useState(goal.title);
  const [outcome, setOutcome] = useState(goal.desiredOutcome ?? "");
  const [why, setWhy] = useState(goal.why ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  return <form className="coach-form" onSubmit={(event) => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true); setError("");
    void api.updateGoal(goal.id, { title: title.trim(), desiredOutcome: outcome.trim(), why: why.trim() })
      .then(async () => { await client.refresh(); onDone(); })
      .catch((cause) => setError(friendlyError(t("coach.error.saveGoal"), cause)))
      .finally(() => setBusy(false));
  }}>
    <label className="coach-field" htmlFor={`${id}-title`}>
      <span>{t("coach.goal.titleLabel")}</span>
      <TextInput {...{ id: `${id}-title`, maxLength: 240 }} value={title} onChange={(event) => setTitle(event.target.value)} />
    </label>
    <label className="coach-field" htmlFor={`${id}-outcome`}>
      <span>{t("coach.goal.outcome")}</span>
      <Textarea id={`${id}-outcome`} rows={2} maxLength={1000} value={outcome}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setOutcome(event.target.value)} />
    </label>
    <label className="coach-field" htmlFor={`${id}-why`}>
      <span>{t("coach.goal.why")}</span>
      <Textarea id={`${id}-why`} rows={2} maxLength={1000} value={why}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setWhy(event.target.value)} />
    </label>
    <div className="coach-row-actions">
      <Button type="submit" size="sm" busy={busy} disabled={!title.trim()}>{t("coach.goal.save")}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>{t("coach.goal.cancel")}</Button>
    </div>
    {error && <CoachError message={error} ui={ui} />}
  </form>;
}

/** A next action toward a goal is unscheduled by default. Committing it to a
 *  day stays an explicit, separate decision. */
function AddNextAction({ goalId, props }: { goalId: string; props: CoachUiProps }) {
  const { api, client, ui, friendlyError } = props;
  const { Button, TextInput } = ui;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useId();
  return <form className="coach-add" onSubmit={(event) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    void api.createCommitment({ title: text.trim(), goalId })
      .then(async () => { setText(""); await client.refresh(); })
      .catch((cause) => setError(friendlyError(t("coach.error.addAction"), cause)))
      .finally(() => setBusy(false));
  }}>
    <label className="coach-field" htmlFor={id}>
      <span>{t("coach.goal.nextActionLabel")}</span>
      <TextInput {...{ id, maxLength: 240 }} value={text} placeholder={t("coach.goal.nextActionPlaceholder")}
        disabled={busy} onChange={(event) => setText(event.target.value)} />
    </label>
    <Button type="submit" size="sm" busy={busy} disabled={!text.trim()}>{t("coach.goal.addNextAction")}</Button>
    <p className="coach-meta">{t("coach.goal.nextActionHint")}</p>
    {error && <CoachError message={error} ui={ui} />}
  </form>;
}

function GoalDetail({ goal, data, onBack, reload, props }: {
  goal: CoachGoalDto;
  data: GoalsData;
  onBack(): void;
  reload(): void;
  props: CoachUiProps;
}) {
  const { api, client, ui, friendlyError } = props;
  const { Button, Menu } = ui;
  const snapshot = useCoach(client);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const actions = data.commitments.filter((item) => item.goalId === goal.id);
  const routines = data.routines.filter((item) => item.goalId === goal.id);
  const timeZone = snapshot.home?.profile.timeZone;

  const run = async (label: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await work(); await client.refresh(); reload(); }
    catch (cause) { setError(friendlyError(label, cause)); }
    finally { setBusy(false); }
  };

  const menuEntries = [
    { id: "edit", label: t("coach.goal.edit"), disabled: busy, onSelect: () => setEditing(true) },
    isPrimaryGoal(goal)
      ? { id: "unprimary", label: t("coach.goals.clearPrimary"), disabled: busy, onSelect: () => void run(t("coach.error.setPrimary"), () => api.clearPrimaryGoal()) }
      : { id: "primary", label: t("coach.goals.makePrimary"), disabled: busy || goal.status !== "active", onSelect: () => void run(t("coach.error.setPrimary"), () => api.setPrimaryGoal(goal.id)) },
    goal.status === "active"
      ? { id: "pause", label: t("coach.goal.pause"), disabled: busy, onSelect: () => void run(t("coach.error.updateGoal"), () => api.updateGoal(goal.id, { status: "paused" })) }
      : { id: "resume", label: t("coach.goal.resume"), disabled: busy, onSelect: () => void run(t("coach.error.updateGoal"), () => api.updateGoal(goal.id, { status: "active" })) },
    { id: "complete", label: t("coach.goal.complete"), disabled: busy, onSelect: () => void run(t("coach.error.updateGoal"), () => api.updateGoal(goal.id, { status: "completed" })) },
    { id: "archive", label: t("coach.goal.archive"), danger: true, disabled: busy, onSelect: () => void run(t("coach.error.updateGoal"), () => api.updateGoal(goal.id, { status: "cancelled" })) },
  ];

  return <div className="coach-stack coach-goal-detail">
    <div className="coach-detail-head">
      <Button size="sm" variant="ghost" onClick={onBack}>{t("coach.goals.back")}</Button>
      <div className="coach-detail-actions">
        <Button
          size="sm"
          variant="ghost"
          busy={snapshot.busy.has("talk")}
          onClick={() => void client.talk(
            `Let's look at goal ${goal.id}: ${goal.title}. Read its stored details and open actions first, then help me choose one realistic next step. Strategic changes need my approval.`,
          )}
        >{t("coach.ask.aboutGoal", { title: goal.title })}</Button>
        <Menu label={t("coach.action.moreFor", { title: goal.title })} title={goal.title} entries={menuEntries}>
          {(trigger: Record<string, unknown>) => (
            <Button {...trigger} size="sm" variant="ghost" disabled={busy}>{t("coach.action.more")}</Button>
          )}
        </Menu>
      </div>
    </div>

    {editing ? <GoalEditor goal={goal} props={props} onDone={() => { setEditing(false); reload(); }} /> : <>
      <header className="coach-goal-head">
        <div className="coach-goal-title">
          <h2>{goal.title}</h2>
          {isPrimaryGoal(goal) && <span className="coach-badge">{t("coach.goals.primary")}</span>}
          {goal.status !== "active" && <span className="coach-badge coach-badge--quiet">{goal.status}</span>}
        </div>
        {goal.desiredOutcome && <p className="coach-lead">{goal.desiredOutcome}</p>}
        {goal.why && <p className="coach-meta">{goal.why}</p>}
        {goal.targetAt && <p className="coach-meta">{formatWhen(goal.targetAt, timeZone, false)}</p>}
      </header>
    </>}

    {error && <CoachError message={error} ui={ui} />}

    <section className="coach-panel" aria-label={t("coach.goal.upcomingActions")}>
      <header className="coach-panel-head"><h3>{t("coach.goal.upcomingActions")}</h3></header>
      {actions.length === 0
        ? <p className="coach-quiet">{t("coach.goal.noActions")}</p>
        : <div className="coach-list">
            {actions.map((item) => (
              <ActionRow
                key={item.id}
                item={item}
                client={client}
                ui={ui}
                {...(timeZone ? { timeZone } : {})}
                trailing={item.plannedFor || item.dueAt ? undefined : (
                  <div className="coach-row-actions">
                    <Button size="sm" disabled={snapshot.busy.has(`commitment:${item.id}`)}
                      onClick={() => void client.reschedule(item.id, startOfToday())}>
                      {t("coach.upcoming.moveToToday")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={snapshot.busy.has(`commitment:${item.id}`)}
                      onClick={() => void client.complete(item.id)}>
                      {t("coach.action.done")}
                    </Button>
                  </div>
                )}
              />
            ))}
          </div>}
      {goal.status === "active" && <AddNextAction goalId={goal.id} props={props} />}
    </section>

    {routines.length > 0 && (
      <section className="coach-panel" aria-label={t("coach.goal.routines")}>
        <header className="coach-panel-head"><h3>{t("coach.goal.routines")}</h3></header>
        <div className="coach-list">
          {routines.map((routine) => (
            <div key={routine.id} className="coach-row coach-row--quiet">
              <div className="coach-row-copy">
                <span className="coach-row-title">{routine.title}</span>
                <span className="coach-meta">{formatClock(routine.preferredMinuteOfDay) ?? routine.cadence.kind}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    )}
  </div>;
}

export default function GoalsPanel(props: CoachUiProps & {
  selectedGoalId: string | null;
  onSelectGoal(id: string | null): void;
}) {
  const { api, client, ui, friendlyError, selectedGoalId, onSelectGoal } = props;
  const { Button, TextInput, Select } = ui;
  const { data, error, reload } = useGoalsData(props);
  const [filter, setFilter] = useState("active");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const id = useId();

  const selected = selectedGoalId ? data?.goals.find((goal) => goal.id === selectedGoalId) : undefined;
  if (selected && data) {
    return <GoalDetail goal={selected} data={data} props={props} reload={reload} onBack={() => onSelectGoal(null)} />;
  }

  const goals = data?.goals.filter((goal) => filter === "all" || goal.status === filter) ?? [];
  return <div className="coach-stack">
    <form className="coach-add" onSubmit={(event) => {
      event.preventDefault();
      if (!title.trim() || busy) return;
      setBusy(true); setAddError("");
      void api.createGoal({ title: title.trim() })
        .then(async () => { setTitle(""); setFilter("active"); await client.refresh(); reload(); })
        .catch((cause) => setAddError(friendlyError(t("coach.error.addGoal"), cause)))
        .finally(() => setBusy(false));
    }}>
      <label className="coach-field" htmlFor={id}>
        <span>{t("coach.goals.addLabel")}</span>
        <TextInput {...{ id, maxLength: 240 }} value={title} disabled={busy}
          placeholder={t("coach.goals.addPlaceholder")} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <Button type="submit" size="sm" busy={busy} disabled={!title.trim()}>{t("coach.goals.add")}</Button>
      {addError && <CoachError message={addError} ui={ui} />}
    </form>

    <section className="coach-panel" aria-label={t("coach.goals.heading")}>
      <header className="coach-panel-head">
        <h3>{t("coach.goals.heading")}</h3>
        <Select label={t("coach.goals.filter")} ariaLabel={t("coach.goals.filter")} value={filter} onChange={setFilter} options={[
          { value: "active", label: t("coach.goals.statusActive") },
          { value: "paused", label: t("coach.goals.statusPaused") },
          { value: "completed", label: t("coach.goals.statusCompleted") },
          { value: "all", label: t("coach.goals.statusAll") },
        ]} />
      </header>
      {error && <CoachError message={error} ui={ui} onRetry={reload} />}
      {!data && !error && <p className="coach-meta" role="status">{t("coach.workspace.loading")}</p>}
      {data && goals.length === 0 && (
        <p className="coach-quiet">{filter === "active" ? t("coach.goals.empty") : t("coach.goals.emptyFiltered")}</p>
      )}
      <div className="coach-list">
        {goals.map((goal) => {
          const next = data?.commitments.find((item) => item.goalId === goal.id);
          return <button
            key={goal.id}
            type="button"
            className="coach-row coach-row--button"
            aria-label={t("coach.goals.open", { title: goal.title })}
            onClick={() => onSelectGoal(goal.id)}
          >
            <span className="coach-row-copy">
              <span className="coach-row-title">{goal.title}</span>
              {goal.desiredOutcome && <span className="coach-meta">{goal.desiredOutcome}</span>}
              {next && <span className="coach-meta">{t("coach.goal.nextAction")}: {next.title}</span>}
            </span>
            <span className="coach-row-tags">
              {isPrimaryGoal(goal) && <span className="coach-badge">{t("coach.goals.primary")}</span>}
              {goal.status !== "active" && <span className="coach-badge coach-badge--quiet">{goal.status}</span>}
            </span>
          </button>;
        })}
      </div>
    </section>
  </div>;
}
