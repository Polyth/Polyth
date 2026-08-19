import { useState } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { GoalAttachForm } from "./GoalStrip.tsx";
import { getState, useActiveModel, useStore } from "../store.ts";
import { registerSlot } from "../slots.ts";
import { api } from "../api.ts";
import { goalChecklist } from "../utils.ts";

// Sessions carrying a goal get a pill in the session list.
registerSlot("session.list.badges", "builtin.goal", (props) => {
  const session = props.session as SessionProjection | undefined;
  if (!session) return null;
  const evs = getState().events[session.id] ?? [];
  if (!evs.some((e) => e.type === "goal/attached")) return null;
  const closed = evs.some((e) => e.type === "goal/completed" || e.type === "goal/stopped");
  return <span className={`goal-pill goal-pill-${closed ? "completed" : "active"}`}>goal</span>;
}, 10);

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

const VERDICT_COLOR: Record<string, string> = {
  keep: "var(--green)",
  done: "var(--blue)",
  stuck: "var(--red)",
};

const NO_EVENTS: never[] = [];

export default function GoalsView() {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  const model = useActiveModel();
  const goal = model.goal;
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!sessionId) return <div className="view-empty">Open a session to attach a goal.</div>;

  const audits = events
    .filter((e) => e.type === "goal/audit")
    .map((e) => ({
      id: e.id,
      time: new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      verdict: String((e.data as Record<string, unknown>).verdict ?? "keep"),
      note: String((e.data as Record<string, unknown>).note ?? ""),
    }));

  const act = async (fn: (id: string) => Promise<unknown>) => {
    setBusy(true);
    await fn(sessionId).catch(() => {});
    setBusy(false);
  };

  const pct = goal && goal.budgetTokens > 0 ? Math.min(100, Math.round((goal.tokensUsed / goal.budgetTokens) * 100)) : 0;
  const checklist = goal ? goalChecklist(goal.objective, goal.status) : [];

  return (
    <div className="view-page goals-page">
      <div className="goals-head">
        <div>
          <h1 className="view-title">Session Goals</h1>
          <p className="view-sub">Autonomous loop: attach an objective, let the auditor drive continuations to completion.</p>
        </div>
        <span className="header-spacer" />
        {!goal && !form && <button className="small-btn" onClick={() => setForm(true)}>Attach goal</button>}
      </div>

      {form && <GoalAttachForm onDone={() => setForm(false)} />}
      {!goal && !form && <div className="view-empty">No goal attached to this session.</div>}

      {goal && (
        <>
          <div className="goal-card">
            <div className="goal-card-row">
              <span className="goal-label">Objective</span>
              <span className={`goal-pill goal-pill-${goal.status}`}>{goal.status}</span>
            </div>
            <div className="goal-card-objective">{goal.objective}</div>
            {checklist.length > 1 && (
              <>
                <div className="goal-budget-row">
                  <span>Progress</span>
                  <span className="goal-progress">{checklist.filter((c) => c.done).length}/{checklist.length}</span>
                </div>
                <ul className="goal-check">
                  {checklist.map((c, i) => <li key={i} className={c.done ? "done" : ""}>{c.text}</li>)}
                </ul>
              </>
            )}
            <div>
              <div className="goal-budget-row">
                <span>Token budget</span>
                <span className="mono">{fmtK(goal.tokensUsed)}{goal.budgetTokens > 0 ? ` / ${fmtK(goal.budgetTokens)}` : ""} tok</span>
              </div>
              <div className="goal-budget-track">
                <div className="goal-budget-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <div className="goal-stat-grid">
              <div className="goal-stat-cell">
                <div className="goal-stat-k">Continuations</div>
                <div className="goal-stat-v mono">{goal.continuations} / {goal.maxContinuations}</div>
              </div>
              <div className="goal-stat-cell">
                <div className="goal-stat-k">Tokens</div>
                <div className="goal-stat-v mono">{fmtK(goal.tokensUsed)}</div>
              </div>
              <div className="goal-stat-cell">
                <div className="goal-stat-k">Status</div>
                <div className="goal-stat-v">{goal.status}</div>
              </div>
              <div className="goal-stat-cell">
                <div className="goal-stat-k">Last verdict</div>
                <div className="goal-stat-v" style={{ color: goal.lastVerdict ? VERDICT_COLOR[goal.lastVerdict] : undefined }}>
                  {goal.lastVerdict ?? "—"}
                </div>
              </div>
            </div>
            <div className="goal-actions">
              {goal.status === "active" && (
                <button className="small-btn" disabled={busy} onClick={() => void act(api.goalPause)}>Pause</button>
              )}
              {goal.status === "paused" && (
                <button className="small-btn" disabled={busy} onClick={() => void act(api.goalResume)}>Resume</button>
              )}
              {(goal.status === "active" || goal.status === "paused") && (
                <button className="small-btn danger-btn" disabled={busy} onClick={() => void act(api.goalStop)}>Stop</button>
              )}
            </div>
          </div>

          <div>
            <div className="stat-label">Audit trail</div>
            <div className="audit-list">
              {audits.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No audits yet — the auditor runs after each continuation.</div>}
              {audits.map((a) => (
                <div key={a.id} className="audit-row">
                  <span className="audit-time mono">{a.time}</span>
                  <span className="audit-verdict" style={{ color: VERDICT_COLOR[a.verdict] ?? "var(--muted)" }}>{a.verdict}</span>
                  <span className="audit-note">{a.note}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
