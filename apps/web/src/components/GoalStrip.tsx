// Goal strip above the timeline: collapsible objective + progress checklist.
import { useState, useEffect, useCallback } from "react";
import { api, type GoalState } from "../api.ts";
import { useStore } from "../store.ts";
import { goalChecklist } from "../utils.ts";
import Dialog from "./a11y/Dialog.tsx";
import EmptyState from "./EmptyState.tsx";
import { formatNumber, tr } from "../i18n/index.ts";

export function GoalStrip({ forceOpen = false }: { forceOpen?: boolean }) {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const model = useStore((s) => {
    if (!s.activeSessionId) return null;
    const evts = s.events[s.activeSessionId];
    if (!evts) return null;
    for (let i = evts.length - 1; i >= 0; i--) {
      const e = evts[i]!;
      if (e.type.startsWith("goal/")) return e;
    }
    return null;
  });

  const [goal, setGoal] = useState<GoalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);

  const refresh = useCallback(async () => {
    if (!activeSessionId) { setGoal(null); return; }
    try {
      const g = await api.goalGet(activeSessionId);
      setGoal(g);
    } catch {
      setGoal(null);
    }
  }, [activeSessionId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (model && model.type.startsWith("goal/")) void refresh();
  }, [model, refresh]);

  if (!goal) {
    return forceOpen
      ? <EmptyState title={tr("goalstrip.noGoalAttached")} description={tr("goalstrip.attachAnObjectiveFromTheSessionActions")} />
      : null;
  }

  const pause = async () => { setBusy(true); await api.goalPause(activeSessionId!); setBusy(false); void refresh(); };
  const resume = async () => { setBusy(true); await api.goalResume(activeSessionId!); setBusy(false); void refresh(); };
  const stop = async () => { setBusy(true); await api.goalStop(activeSessionId!); setBusy(false); void refresh(); };

  const isActive = goal.status === "active";
  const items = goalChecklist(goal.objective, goal.status);
  const doneCount = items.filter((i) => i.done).length;
  const expanded = forceOpen || open;
  const objective = goal.objective.length > 80 ? goal.objective.slice(0, 77) + "…" : goal.objective;

  return (
    <div className={`goal-strip ${expanded ? "open" : "collapsed"}`}>
      <button className="goal-toggle" onClick={() => setOpen((v) => !v)} disabled={forceOpen}>
        <span className="goal-label">{tr("goalstrip.goal")}</span>
        <span className={`goal-pill goal-pill-${goal.status}`}>{goal.status}</span>
        <span className="goal-objective">{objective}</span>
        <span className="goal-progress">{doneCount}/{items.length || 1}</span>
        {!forceOpen && <span className="goal-chevron">{expanded ? "▾" : "▸"}</span>}
      </button>
      {expanded && (
        <>
          {items.length > 0 && (
            <ul className="goal-check">
              {items.map((it, i) => (
                <li key={i} className={it.done ? "done" : ""}>{it.text}</li>
              ))}
            </ul>
          )}
          <div className="goal-stats">
            <span className="goal-stat">{tr("goalstrip.cont")}{" "}{goal.continuations}/{goal.maxContinuations}</span>
            <span className="goal-stat">
              {tr("goalstrip.tok")}{" "}{goal.tokensUsed > 0 ? `${fmtK(goal.tokensUsed)}` : "0"}
              {goal.budgetTokens > 0 ? `/${fmtK(goal.budgetTokens)}` : ""}
            </span>
            {goal.lastVerdict && (
              <span className={`goal-stat goal-verdict-${goal.lastVerdict}`}>{tr("goalstrip.verdict")}{" "}{goal.lastVerdict}</span>
            )}
          </div>
          <div className="goal-actions">
            {isActive ? (
              <button className="small-btn" onClick={() => void pause()} disabled={busy}>{tr("common.pause")}</button>
            ) : goal.status === "paused" ? (
              <button className="small-btn" onClick={() => void resume()} disabled={busy}>{tr("common.resume")}</button>
            ) : null}
            {(isActive || goal.status === "paused") && (
              <button className="small-btn danger-btn" onClick={() => void stop()} disabled={busy}>{tr("common.stop")}</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function GoalAttachForm({ onDone }: { onDone: () => void }) {
  const activeSessionId = useStore((s) => s.activeSessionId);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [maxCont, setMaxCont] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const limitError = (value: string, label: string) => {
    if (!value) return "";
    const number = Number(value);
    return Number.isFinite(number) && Number.isInteger(number) && number > 0
      ? ""
      : `${label} must be a positive whole number.`;
  };
  const budgetError = limitError(budget, "Token budget");
  const continuationError = limitError(maxCont, "Max continuations");

  const submit = async () => {
    if (!activeSessionId || !objective.trim() || budgetError || continuationError) return;
    setBusy(true);
    setServerError("");
    try {
      await api.goalAttach(
        activeSessionId,
        objective.trim(),
        budget ? Number(budget) : undefined,
        maxCont ? Number(maxCont) : undefined,
      );
      onDone();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : tr("goalstrip.couldnTAttachTheGoal"));
    }
    setBusy(false);
  };

  return (
    <Dialog title={tr("goalstrip.sessionGoal")} onClose={onDone} className="goal-dialog" initialFocus="textarea">
      <div className="goal-dialog-head">
        <span className="goal-dialog-mark" aria-hidden="true">◎</span>
        <div>
          <h2>{tr("goalstrip.setAClearSessionGoal")}</h2>
          <p>{tr("goalstrip.polythWillKeepTheObjectiveAndIts")}</p>
        </div>
        <button className="icon-btn" aria-label={tr("goalstrip.closeGoalDialog")} onClick={onDone}>{tr("goalstrip.message")}</button>
      </div>
      <div className="goal-attach">
        <label className="goal-attach-label goal-objective-field">
          <span>{tr("goalstrip.objective")}</span>
          <textarea
            rows={4}
            placeholder={tr("goalstrip.whatShouldThisSessionAccomplishOneItem")}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
        </label>
        <div className="goal-attach-row">
          <label className="goal-attach-label">
            <span>{tr("goalstrip.tokenBudget")}{" "}<small>{tr("goalstrip.optional")}</small></span>
            <input
              type="number"
              min={1}
              step={1}
              placeholder="500000"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              aria-invalid={budgetError ? true : undefined}
              aria-describedby={budgetError ? "goal-budget-error" : undefined}
            />
            {budgetError && <span id="goal-budget-error" className="form-error">{budgetError}</span>}
          </label>
          <label className="goal-attach-label">
            <span>{tr("goalstrip.maxContinuations")}{" "}<small>{tr("goalstrip.optional")}</small></span>
            <input
              type="number"
              min={1}
              step={1}
              placeholder="12"
              value={maxCont}
              onChange={(e) => setMaxCont(e.target.value)}
              aria-invalid={continuationError ? true : undefined}
              aria-describedby={continuationError ? "goal-continuations-error" : undefined}
            />
            {continuationError && <span id="goal-continuations-error" className="form-error">{continuationError}</span>}
          </label>
        </div>
        {serverError && <div className="form-error goal-dialog-error" role="alert">{serverError}</div>}
        <div className="goal-dialog-actions">
          <button className="small-btn" onClick={onDone}>{tr("common.cancel")}</button>
          <button className="primary-btn goal-attach-submit" onClick={() => void submit()} disabled={busy || !objective.trim() || !!budgetError || !!continuationError}>
            {busy ? tr("goalstrip.attaching") : tr("goalstrip.attachGoal")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function fmtK(n: number): string {
  if (n >= 1_000_000) {
    return `${formatNumber(n / 1_000_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
  }
  if (n >= 1_000) {
    return `${formatNumber(n / 1_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  }
  return formatNumber(n);
}
