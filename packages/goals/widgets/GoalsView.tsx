import { useState } from "react";
import { GoalAttachForm } from "./GoalStrip.tsx";
import { useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { api } from "@polyth/session/web-api";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { formatNumber, getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button } from "../../../apps/web/src/components/ui/index.ts";

function fmtK(n: number): string {
  if (n >= 1_000_000) {
    return `${formatNumber(n / 1_000_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
  }
  if (n >= 1_000) {
    return `${formatNumber(n / 1_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  }
  return formatNumber(n);
}

const NO_EVENTS: never[] = [];

export default function GoalsView() {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  const model = useActiveModel();
  const goal = model.goal;
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!sessionId) {
    return <EmptyState title={tr("goalsview.noSessionOpen")} description={tr("goalsview.openASessionToAttachAGoal")} />;
  }

  const audits = events
    .filter((e) => e.type === "goal/audit")
    .map((e) => ({
      id: e.id,
      time: new Date(e.time).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" }),
      verdict: String((e.data as Record<string, unknown>).verdict ?? "keep"),
      note: String((e.data as Record<string, unknown>).note ?? ""),
    }));

  const act = async (fn: (id: string) => Promise<unknown>) => {
    setBusy(true);
    await fn(sessionId).catch(() => {});
    setBusy(false);
  };

  const pct = goal && goal.budgetTokens > 0 ? Math.min(100, Math.round((goal.tokensUsed / goal.budgetTokens) * 100)) : 0;

  return (
    <div className="view-page goals-page">
      {/* Title, description and the single close control now come from the
          shared ModuleView frame (WorkspaceHost). The empty state below still
          offers "Attach goal"; a redundant header button was removed. */}
      {form && <GoalAttachForm onDone={() => setForm(false)} />}
      {!goal && !form && (
        <EmptyState
          title={tr("goalsview.noGoalYet")}
          description={tr("goalsview.giveThisSessionAnObjectivePolythKeeps")}
          actionLabel={tr("goalsview.attachGoal")}
          onAction={() => setForm(true)}
        />
      )}

      {goal && (
        <>
          <div className="goal-card">
            <div className="goal-card-row">
              <span className="goal-label">{tr("goalsview.objective")}</span>
              <span className={`goal-pill goal-pill-${goal.status}`}>{goal.status}</span>
            </div>
            <div className="goal-card-objective">{goal.objective}</div>
            <div>
              <div className="goal-budget-row">
                <span>{tr("goalsview.tokenBudget")}</span>
                <span className="mono">{fmtK(goal.tokensUsed)}{goal.budgetTokens > 0 ? ` / ${fmtK(goal.budgetTokens)}` : ""}</span>
              </div>
              <div className="goal-budget-track">
                <div className="goal-budget-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <div className="goal-stat-grid">
              <div className="goal-stat-cell">
                <div className="goal-stat-k">{tr("goalsview.continuations")}</div>
                <div className="goal-stat-v mono">{goal.continuations} / {goal.maxContinuations}</div>
              </div>
              <div className="goal-stat-cell">
                <div className="goal-stat-k">{tr("goalsview.tokens")}</div>
                <div className="goal-stat-v mono">{fmtK(goal.tokensUsed)}</div>
              </div>
              <div className="goal-stat-cell">
                <div className="goal-stat-k">{tr("goalsview.status")}</div>
                <div className="goal-stat-v">{goal.status}</div>
              </div>
              <div className="goal-stat-cell">
                <div className="goal-stat-k">{tr("goalsview.lastVerdict")}</div>
                <div className="goal-stat-v" data-verdict={goal.lastVerdict ?? undefined}>
                  {goal.lastVerdict ?? "—"}
                </div>
              </div>
            </div>
            <div className="goal-actions">
              {goal.status === "active" && (
                <Button size="sm" disabled={busy} onClick={() => void act(api.goalPause)}>{tr("common.pause")}</Button>
              )}
              {goal.status === "paused" && (
                <Button size="sm" disabled={busy} onClick={() => void act(api.goalResume)}>{tr("common.resume")}</Button>
              )}
              {(goal.status === "active" || goal.status === "paused") && (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void act(api.goalStop)}>{tr("common.stop")}</Button>
              )}
            </div>
          </div>

          <div>
            <div className="stat-label">{tr("goalsview.auditTrail")}</div>
            <div className="audit-list">
              {audits.length === 0 && <div className="muted goal-audit-empty">{tr("goalsview.noAuditsYetTheAuditorRunsAfter")}</div>}
              {audits.map((a) => (
                <div key={a.id} className="audit-row">
                  <span className="audit-time mono">{a.time}</span>
                  <span className="audit-verdict" data-verdict={a.verdict}>{a.verdict}</span>
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
