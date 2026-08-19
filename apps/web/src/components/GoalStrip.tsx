// Goal strip above the timeline: collapsible objective + progress checklist.
import { useState, useEffect, useCallback } from "react";
import { api, type GoalState } from "../api.ts";
import { useStore } from "../store.ts";
import { usePrefs } from "../prefs.ts";
import { goalChecklist } from "../utils.ts";
import { useEscape } from "../useEscape.ts";

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

  const prefs = usePrefs();
  const [goal, setGoal] = useState<GoalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const [attaching, setAttaching] = useState(false);

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
    if (forceOpen) return <div className="view-empty">No goal attached to this session.</div>;
    if (!activeSessionId || !prefs.plugins.includes("goals")) return null;
    // Dashed ghost invites attaching a goal without stealing timeline space.
    if (attaching) return <GoalAttachForm onDone={() => { setAttaching(false); void refresh(); }} />;
    return (
      <button className="goal-ghost" onClick={() => setAttaching(true)}>
        + Attach a goal so Polyth can work toward it on its own
      </button>
    );
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
        <span className="goal-label">Goal</span>
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
            <span className="goal-stat">cont {goal.continuations}/{goal.maxContinuations}</span>
            <span className="goal-stat">
              tok {goal.tokensUsed > 0 ? `${fmtK(goal.tokensUsed)}` : "0"}
              {goal.budgetTokens > 0 ? `/${fmtK(goal.budgetTokens)}` : ""}
            </span>
            {goal.lastVerdict && (
              <span className={`goal-stat goal-verdict-${goal.lastVerdict}`}>verdict: {goal.lastVerdict}</span>
            )}
          </div>
          <div className="goal-actions">
            {isActive ? (
              <button className="small-btn" onClick={() => void pause()} disabled={busy}>Pause</button>
            ) : goal.status === "paused" ? (
              <button className="small-btn" onClick={() => void resume()} disabled={busy}>Resume</button>
            ) : null}
            {(isActive || goal.status === "paused") && (
              <button className="small-btn danger-btn" onClick={() => void stop()} disabled={busy}>Stop</button>
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
  useEscape(true, onDone);

  const submit = async () => {
    if (!activeSessionId || !objective.trim()) return;
    setBusy(true);
    try {
      await api.goalAttach(
        activeSessionId,
        objective.trim(),
        budget ? Number(budget) : undefined,
        maxCont ? Number(maxCont) : undefined,
      );
      onDone();
    } catch {
      // show nothing, goal endpoint may not be available
    }
    setBusy(false);
  };

  return (
    <div className="goal-attach project-form">
      <label>Objective <span>one item per line becomes a checklist</span>
        <textarea
          autoFocus
          rows={2}
          placeholder="Ship the login flow…"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
        />
      </label>
      <div className="goal-attach-row">
        <label>Budget tokens <span>optional</span>
          <input type="number" placeholder="500000" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 120 }} />
        </label>
        <label>Max continuations <span>optional</span>
          <input type="number" placeholder="12" value={maxCont} onChange={(e) => setMaxCont(e.target.value)} style={{ width: 130 }} />
        </label>
      </div>
      <div className="form-actions">
        <button className="small-btn" onClick={onDone}>Cancel</button>
        <button className="primary-btn small-btn" onClick={() => void submit()} disabled={busy || !objective.trim()}>
          Attach goal
        </button>
      </div>
    </div>
  );
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
