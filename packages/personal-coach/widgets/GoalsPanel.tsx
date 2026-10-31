import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import type { CoachCommitmentDto, CoachGoalDto, CoachRoutineDto } from "./api.ts";
import {
  ActionRow,
  CoachError,
  cadenceKindLabel,
  formatClock,
  formatWhen,
  goalStatusLabel,
  isPrimaryGoal,
  startOfToday,
  type CoachUiProps,
} from "./parts.tsx";
import { PendingRows, usePendingAdds } from "./pendingAdds.tsx";
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
  /** Local change ahead of the server (optimistic edits and their rollback). */
  patchGoals(revise: (goal: CoachGoalDto) => CoachGoalDto): void;
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
  return {
    data,
    error,
    reload: () => setAttempt((n) => n + 1),
    patchGoals: (revise) => setData((current) => current ? { ...current, goals: current.goals.map(revise) } : current),
  };
}

interface GoalDraft {
  title: string;
  desiredOutcome: string;
  why: string;
}

/** Edits the server refused after their goal was left: reopened with it. */
const refusedGoalEdits = new Map<string, { draft: GoalDraft; error: string }>();

function GoalEditor({ goal, draft, onSave, onCancel, props }: {
  goal: CoachGoalDto;
  draft: GoalDraft | null;
  onSave(draft: GoalDraft): void;
  onCancel(): void;
  props: CoachUiProps;
}) {
  const { ui } = props;
  const { TextInput, Textarea, Button } = ui;
  const [title, setTitle] = useState(draft?.title ?? goal.title);
  const [outcome, setOutcome] = useState(draft?.desiredOutcome ?? goal.desiredOutcome ?? "");
  const [why, setWhy] = useState(draft?.why ?? goal.why ?? "");
  const id = useId();
  return <form className="coach-form" onSubmit={(event) => {
    event.preventDefault();
    if (!title.trim()) return;
    onSave({ title: title.trim(), desiredOutcome: outcome.trim(), why: why.trim() });
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
      <Button type="submit" size="sm" disabled={!title.trim()}>{t("coach.goal.save")}</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>{t("coach.goal.cancel")}</Button>
    </div>
  </form>;
}

/** A next action toward a goal is unscheduled by default. Committing it to a
 *  day stays an explicit, separate decision. */
function AddNextAction({ goalId, reload, props }: { goalId: string; reload(): void; props: CoachUiProps }) {
  const { api, client, ui, friendlyError } = props;
  const { Button, TextInput } = ui;
  const adds = usePendingAdds(friendlyError);
  const id = useId();
  return <form className="coach-add" onSubmit={(event) => {
    event.preventDefault();
    adds.submit(
      t("coach.error.addAction"),
      (title) => api.createCommitment({ title, goalId }),
      async () => { await client.refresh(); reload(); },
    );
  }}>
    <PendingRows items={adds.pending} ui={ui} onEdit={adds.edit} onDismiss={adds.dismiss} />
    <label className="coach-field" htmlFor={id}>
      <span>{t("coach.goal.nextActionLabel")}</span>
      <TextInput {...{ id, maxLength: 240 }} value={adds.text} placeholder={t("coach.goal.nextActionPlaceholder")}
        onChange={(event) => adds.setText(event.target.value)} />
    </label>
    <Button type="submit" size="sm" disabled={!adds.text.trim()}>{t("coach.goal.addNextAction")}</Button>
    <p className="coach-meta">{t("coach.goal.nextActionHint")}</p>
    {adds.error && <CoachError message={adds.error} ui={ui} />}
  </form>;
}

function GoalDetail({ goal, data, onBack, reload, patchGoals, props }: {
  goal: CoachGoalDto;
  data: GoalsData;
  onBack(): void;
  reload(): void;
  patchGoals(revise: (goal: CoachGoalDto) => CoachGoalDto): void;
  props: CoachUiProps;
}) {
  const { api, client, ui, friendlyError } = props;
  const { Button, Menu } = ui;
  const snapshot = useCoach(client);
  // An edit the server refused after this goal was left comes back here.
  const [refused] = useState(() => refusedGoalEdits.get(goal.id));
  const [editing, setEditing] = useState(refused !== undefined);
  const [draft, setDraft] = useState<GoalDraft | null>(refused?.draft ?? null);
  const [error, setError] = useState(refused?.error ?? "");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    refusedGoalEdits.delete(goal.id);
    return () => { mounted.current = false; };
  }, [goal.id]);
  const actions = data.commitments.filter((item) => item.goalId === goal.id);
  const routines = data.routines.filter((item) => item.goalId === goal.id);
  const timeZone = snapshot.home?.profile.timeZone;

  // Every goal control shows its result at once. A rejection puts back only
  // what this change set (not a newer change) and reports. Sent once.
  const run = (
    label: string,
    work: () => Promise<unknown>,
    apply: (goal: CoachGoalDto) => CoachGoalDto,
    revert: (goal: CoachGoalDto) => CoachGoalDto,
  ) => {
    setError("");
    patchGoals(apply);
    void work()
      .then(async () => { await client.refresh(); reload(); })
      .catch((cause) => {
        patchGoals(revert);
        if (mounted.current) setError(friendlyError(label, cause));
      });
  };
  const setStatus = (status: CoachGoalDto["status"]) => {
    const before = goal.status;
    run(
      t("coach.error.updateGoal"),
      () => api.updateGoal(goal.id, { status }),
      (item) => item.id === goal.id ? { ...item, status } : item,
      (item) => item.id === goal.id && item.status === status ? { ...item, status: before } : item,
    );
  };
  const setPrimary = (primary: boolean) => {
    // The server keeps one goal in the top band: making one primary demotes
    // the previous; clearing demotes it to the band below.
    const priorities = new Map(data.goals.map((item) => [item.id, item.priority]));
    const target = (item: CoachGoalDto): CoachGoalDto["priority"] =>
      primary && item.id === goal.id ? 3 : item.priority === 3 ? 2 : item.priority;
    run(
      t("coach.error.setPrimary"),
      () => primary ? api.setPrimaryGoal(goal.id) : api.clearPrimaryGoal(),
      (item) => ({ ...item, priority: target(item) }),
      (item) => {
        const before = priorities.get(item.id);
        return before !== undefined && item.priority === target({ ...item, priority: before })
          ? { ...item, priority: before }
          : item;
      },
    );
  };
  const saveEdit = (next: GoalDraft) => {
    const before = { title: goal.title, desiredOutcome: goal.desiredOutcome, why: goal.why };
    setEditing(false);
    setDraft(null);
    setError("");
    patchGoals((item) => item.id === goal.id ? { ...item, ...next } : item);
    void api.updateGoal(goal.id, next)
      .then(async () => { await client.refresh(); reload(); })
      .catch((cause) => {
        patchGoals((item) => item.id === goal.id && item.title === next.title
          ? { ...item, title: before.title, desiredOutcome: before.desiredOutcome, why: before.why }
          : item);
        const message = friendlyError(t("coach.error.saveGoal"), cause);
        // The typed edit is never lost: back in the editor, or kept for the
        // next time this goal opens.
        if (mounted.current) {
          setDraft(next);
          setEditing(true);
          setError(message);
        } else {
          refusedGoalEdits.set(goal.id, { draft: next, error: message });
        }
      });
  };

  const menuEntries = [
    { id: "edit", label: t("coach.goal.edit"), onSelect: () => setEditing(true) },
    isPrimaryGoal(goal)
      ? { id: "unprimary", label: t("coach.goals.clearPrimary"), onSelect: () => setPrimary(false) }
      : { id: "primary", label: t("coach.goals.makePrimary"), disabled: goal.status !== "active", onSelect: () => setPrimary(true) },
    goal.status === "active"
      ? { id: "pause", label: t("coach.goal.pause"), onSelect: () => setStatus("paused") }
      : { id: "resume", label: t("coach.goal.resume"), onSelect: () => setStatus("active") },
    { id: "complete", label: t("coach.goal.complete"), onSelect: () => setStatus("completed") },
    { id: "archive", label: t("coach.goal.archive"), danger: true, onSelect: () => setStatus("cancelled") },
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
            <Button {...trigger} size="sm" variant="ghost">{t("coach.action.more")}</Button>
          )}
        </Menu>
      </div>
    </div>

    {editing ? <GoalEditor
      goal={goal}
      draft={draft}
      props={props}
      onSave={saveEdit}
      onCancel={() => { setEditing(false); setDraft(null); }}
    /> : <>
      <header className="coach-goal-head">
        <div className="coach-goal-title">
          <h2>{goal.title}</h2>
          {isPrimaryGoal(goal) && <span className="coach-badge">{t("coach.goals.primary")}</span>}
          {goal.status !== "active" && <span className="coach-badge coach-badge--quiet">{goalStatusLabel(goal.status)}</span>}
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
      {goal.status === "active" && <AddNextAction goalId={goal.id} reload={reload} props={props} />}
    </section>

    {routines.length > 0 && (
      <section className="coach-panel" aria-label={t("coach.goal.routines")}>
        <header className="coach-panel-head"><h3>{t("coach.goal.routines")}</h3></header>
        <div className="coach-list">
          {routines.map((routine) => (
            <div key={routine.id} className="coach-row coach-row--quiet">
              <div className="coach-row-copy">
                <span className="coach-row-title">{routine.title}</span>
                <span className="coach-meta">{formatClock(routine.preferredMinuteOfDay) ?? cadenceKindLabel(routine.cadence.kind)}</span>
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
  const { data, error, reload, patchGoals } = useGoalsData(props);
  const [filter, setFilter] = useState("active");
  const adds = usePendingAdds(friendlyError);
  const id = useId();

  const selected = selectedGoalId ? data?.goals.find((goal) => goal.id === selectedGoalId) : undefined;
  if (selected && data) {
    return <GoalDetail
      key={selected.id}
      goal={selected}
      data={data}
      props={props}
      reload={reload}
      patchGoals={patchGoals}
      onBack={() => onSelectGoal(null)}
    />;
  }

  const goals = data?.goals.filter((goal) => filter === "all" || goal.status === filter) ?? [];
  return <div className="coach-stack">
    <form className="coach-add" onSubmit={(event) => {
      event.preventDefault();
      if (!adds.text.trim()) return;
      // A new goal is active: show the list it lands in.
      setFilter("active");
      adds.submit(
        t("coach.error.addGoal"),
        (title) => api.createGoal({ title }),
        async () => { await client.refresh(); reload(); },
      );
    }}>
      <label className="coach-field" htmlFor={id}>
        <span>{t("coach.goals.addLabel")}</span>
        <TextInput {...{ id, maxLength: 240 }} value={adds.text}
          placeholder={t("coach.goals.addPlaceholder")} onChange={(event) => adds.setText(event.target.value)} />
      </label>
      <Button type="submit" size="sm" disabled={!adds.text.trim()}>{t("coach.goals.add")}</Button>
      <PendingRows items={adds.pending} ui={ui} onEdit={adds.edit} onDismiss={adds.dismiss} />
      {adds.error && <CoachError message={adds.error} ui={ui} />}
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
              {goal.status !== "active" && <span className="coach-badge coach-badge--quiet">{goalStatusLabel(goal.status)}</span>}
            </span>
          </button>;
        })}
      </div>
    </section>
  </div>;
}
