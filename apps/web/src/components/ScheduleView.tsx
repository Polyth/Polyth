// Scheduled prompts: once, every N minutes, or cron with an IANA time zone.
// Tasks target an existing session, a fresh session per run, or a dedicated
// session. Loop files under .agents/loops appear here with a "loop" badge.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ScheduleCadenceDto, type ScheduleRunDto, type ScheduleTaskDto } from "../api.ts";
import { useStore } from "../store.ts";
import { ago } from "../format.ts";
import { normalizeScheduleList } from "../scheduleData.ts";
import EmptyState from "./EmptyState.tsx";
import { getLocale, tr } from "../i18n/index.ts";

type CadenceKind = "at" | "every" | "cron";
type TargetMode = "new-session-per-run" | "existing-session" | "dedicated-session";
type Overlap = "skip" | "queue" | "parallel";

function localZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function zoneChoices(): string[] {
  const base = [localZone(), "UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Australia/Sydney"];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) return [...new Set([...base, ...supported])];
  } catch { /* older runtimes lack supportedValuesOf */ }
  return [...new Set(base)];
}

function fmtWhen(t: ScheduleTaskDto): string {
  const c = t.cadence;
  if (c?.kind === "cron") return `cron ${c.expression} (${c.timeZone})`;
  if (c?.kind === "every") return tr("scheduleview.everyMinutesValue", { minutes: c.everyMinutes });
  if (c?.kind === "at") return new Date(c.at).toLocaleString(getLocale());
  if (t.kind === "every") return tr("scheduleview.everyMinutesValue", { minutes: t.everyMinutes });
  return t.at ? new Date(t.at).toLocaleString(getLocale()) : "—";
}

function fmtNext(t: ScheduleTaskDto): string {
  if (!t.enabled) return tr("scheduleview.paused");
  if (t.nextRunAt === null) return tr("common.done");
  const delta = t.nextRunAt - Date.now();
  if (delta <= 0) return tr("scheduleview.dueNow");
  return tr("scheduleview.inValue", { value: ago(Date.now() - delta) });
}

function targetLabel(t: ScheduleTaskDto): string {
  const mode = t.target?.mode ?? (t.sessionId ? "existing-session" : "new-session-per-run");
  if (mode === "existing-session") return tr("scheduleview.existingSession");
  if (mode === "dedicated-session") return tr("scheduleview.dedicatedSessionReusedAcrossRuns");
  return tr("scheduleview.newSessionPerRun");
}

function RunHistory({ taskId }: { taskId: string }) {
  const [runs, setRuns] = useState<ScheduleRunDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    void api.scheduleRuns(taskId)
      .then((next) => {
        if (active) setRuns(next);
      })
      .catch((cause) => {
        if (active) {
          setRuns([]);
          setLoadError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [taskId, reloadKey]);
  if (loading) {
    return (
      <div className="loading-state" role="status" aria-label={tr("scheduleview.loadingRuns")}>
        <span /><span /><span />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="sched-runs-empty" role="status">
        <EmptyState
          title={tr("scheduleview.couldnTLoadRuns")}
          description={loadError}
          actionLabel={tr("common.retry")}
          onAction={() => setReloadKey((key) => key + 1)}
        />
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="sched-runs-empty">
        <EmptyState title={tr("scheduleview.noRunsRecordedYet")} description={tr("scheduleview.schedule")} />
      </div>
    );
  }
  return (
    <div className="sched-runs">
      {runs.map((r) => (
        <div key={r.runId} className={`sched-run status-${r.status}`}>
          <span className={`sched-run-dot ${r.status}`} />
          <span className="mono">{new Date(r.startedAt).toLocaleString(getLocale())}</span>
          <span>{r.status}</span>
          {r.finishedAt !== undefined && <span className="muted">{Math.max(0, Math.round((r.finishedAt - r.startedAt) / 1000))}{tr("scheduleview.s")}</span>}
          {r.error && <span className="sched-run-error">{r.error}</span>}
        </div>
      ))}
    </div>
  );
}

export default function ScheduleView() {
  const projectId = useStore((s) => s.activeProjectId);
  const allSessions = useStore((s) => s.sessions);
  const sessions = useMemo(
    () => allSessions.filter((session) => session.projectId === projectId && session.status !== "archived"),
    [allSessions, projectId],
  );
  const [tasks, setTasks] = useState<ScheduleTaskDto[]>([]);
  const [error, setError] = useState("");
  const [loopErrors, setLoopErrors] = useState<Array<{ path: string; error: string }>>([]);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  // form
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<CadenceKind>("at");
  const [at, setAt] = useState("");
  const [every, setEvery] = useState(60);
  const [cronExpr, setCronExpr] = useState("0 9 * * 1-5");
  const [timeZone, setTimeZone] = useState(localZone());
  const [targetMode, setTargetMode] = useState<TargetMode>("new-session-per-run");
  const [sessionId, setSessionId] = useState("");
  const [overlap, setOverlap] = useState<Overlap>("skip");
  const [preview, setPreview] = useState<{ runs: number[]; description: string } | null>(null);
  const [previewError, setPreviewError] = useState("");

  const zones = useMemo(zoneChoices, []);

  const cadence: ScheduleCadenceDto | null = useMemo(() => {
    if (kind === "at") { const ms = at ? new Date(at).getTime() : NaN; return Number.isFinite(ms) ? { kind: "at", at: ms } : null; }
    if (kind === "every") return every >= 1 ? { kind: "every", everyMinutes: every } : null;
    return cronExpr.trim() ? { kind: "cron", expression: cronExpr.trim(), timeZone } : null;
  }, [kind, at, every, cronExpr, timeZone]);

  // Preview next runs from the server so UI and executor share one cron path.
  useEffect(() => {
    if (!cadence) { setPreview(null); setPreviewError(""); return; }
    const handle = setTimeout(() => {
      api.schedulePreview(cadence, 5)
        .then((p) => { setPreview(p); setPreviewError(""); })
        .catch((e) => { setPreview(null); setPreviewError(e instanceof Error ? e.message : String(e)); });
    }, 250);
    return () => clearTimeout(handle);
  }, [cadence]);

  const reload = useCallback(() => {
    if (!projectId) { setTasks([]); return; }
    void api.scheduleList(projectId)
      .then((response) => {
        const normalized = normalizeScheduleList(response);
        setTasks(normalized.tasks);
        setLoopErrors(normalized.loopErrors);
      })
      .catch((cause) => {
        setTasks([]);
        setError(tr("scheduleview.couldNotLoadScheduledPromptsValue", { value: cause instanceof Error ? cause.message : String(cause) }));
      });
  }, [projectId]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!projectId) return <EmptyState title={tr("scheduleview.noProjectSelected")} description={tr("scheduleview.openAProjectToSchedulePrompts")} />;

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = () => void run(async () => {
    if (!cadence) throw new Error(tr("scheduleview.pickAValidTimeIntervalOrCron"));
    await api.scheduleCreate({
      projectId,
      prompt,
      cadence,
      target: {
        mode: targetMode,
        ...(targetMode === "existing-session" && sessionId ? { sessionId } : {}),
      },
      overlapPolicy: overlap,
    });
    setPrompt("");
    setAt("");
  });

  const rescan = () => void run(async () => {
    const r = await api.scheduleLoopsRescan(projectId);
    setLoopErrors(r.errors);
  });

  const canCreate = prompt.trim().length > 0 && cadence !== null && !previewError &&
    (targetMode !== "existing-session" || sessionId !== "");

  return (
    <div className="view-page">
      <div>
        <h2 className="view-title">{tr("scheduleview.schedule")}</h2>
        <p className="view-sub">{tr("scheduleview.sendAPromptOnceOnAnInterval")}{" "}<code>.agents/loops</code> {tr("scheduleview.appearHereTooRunsWhileThePolyth")}</p>
      </div>

      <div className="sched-form">
        <textarea rows={2} value={prompt} placeholder={tr("scheduleview.promptToSendEGSummarizeOvernight")} onChange={(e) => setPrompt(e.target.value)} />
        <div className="view-toolbar-row">
          <div className="seg">
            <button className={kind === "at" ? "on" : ""} onClick={() => setKind("at")}>{tr("scheduleview.onceAt")}</button>
            <button className={kind === "every" ? "on" : ""} onClick={() => setKind("every")}>{tr("scheduleview.every")}</button>
            <button className={kind === "cron" ? "on" : ""} onClick={() => setKind("cron")}>{tr("scheduleview.cron")}</button>
          </div>
          {kind === "at" && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
          {kind === "every" && (
            <label className="sched-every">
              <input className="sched-every-value" type="number" min={1} value={every} onChange={(e) => setEvery(Math.max(1, Number(e.target.value)))} />
              {tr("scheduleview.minutes")}</label>
          )}
          {kind === "cron" && (
            <>
              <input className="mono sched-cron-expression" value={cronExpr} placeholder="0 9 * * 1-5" onChange={(e) => setCronExpr(e.target.value)} />
              <select className="sched-time-zone" value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </>
          )}
        </div>
        <div className="view-toolbar-row">
          <select value={targetMode} onChange={(e) => { setTargetMode(e.target.value as TargetMode); if (e.target.value !== "existing-session") setSessionId(""); }}>
            <option value="new-session-per-run">{tr("scheduleview.newSessionPerRun")}</option>
            <option value="existing-session">{tr("scheduleview.existingSession")}</option>
            <option value="dedicated-session">{tr("scheduleview.dedicatedSessionReusedAcrossRuns")}</option>
          </select>
          {targetMode === "existing-session" && (
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">{tr("scheduleview.pickASession")}</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}
            </select>
          )}
          <label className="sched-every">
            {tr("scheduleview.ifStillRunning")}<select value={overlap} onChange={(e) => setOverlap(e.target.value as Overlap)}>
              <option value="skip">{tr("scheduleview.skipThisRun")}</option>
              <option value="queue">{tr("scheduleview.queueAfter")}</option>
              <option value="parallel">{tr("scheduleview.runInParallel")}</option>
            </select>
          </label>
          <span className="header-spacer" />
          <button className="primary-btn" disabled={!canCreate} onClick={create}>{tr("scheduleview.schedule")}</button>
        </div>
        {previewError && <div className="form-error">{previewError}</div>}
        {preview && (
          <div className="sched-preview">
            <div className="sched-preview-desc">{preview.description}</div>
            {preview.runs.length > 0 && (
              <div className="sched-preview-runs">
                {tr("scheduleview.next")}{" "}{preview.runs.map((ms) => new Date(ms).toLocaleString(getLocale())).join("  ·  ")}
              </div>
            )}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>

      <div className="view-toolbar-row">
        <span className="stat-label" style={{ margin: 0 }}>{tr("scheduleview.tasks")}</span>
        <span className="header-spacer" />
        <button className="small-btn" title={tr("scheduleview.rescanAgentsLoopsForMarkdownManagedTasks")} onClick={rescan}>{tr("scheduleview.rescanLoops")}</button>
      </div>
      {loopErrors.length > 0 && (
        <div className="form-error" role="alert">
          {loopErrors.map((e) => (
            <div key={e.path} className="loop-error-row">
              <span><span className="mono">{e.path}</span>: {e.error}</span>
              <button
                className="small-btn"
                title={tr("scheduleview.dismissUntilThisFileSErrorChanges")}
                aria-label={tr("scheduleview.dismissLoopErrorForValue", { path: e.path })}
                onClick={() => void run(() => api.scheduleLoopErrorDismiss(projectId, e.path))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {tasks.length === 0 && <EmptyState title={tr("scheduleview.nothingScheduled")} description={tr("scheduleview.createAOneTimeIntervalOrCron")} />}
      {tasks.map((t) => (
        <div key={t.id} className={`sched-card ${t.enabled ? "" : "paused"}`}>
          <div className="sched-card-main">
            <div className="sched-prompt">
              {t.source === "loop-file" && <span className="sched-loop-badge" title={t.sourcePath ?? tr("scheduleview.managedByLoopFile")}>{tr("scheduleview.loop")}</span>}
              {t.title ? <strong>{t.title}: </strong> : null}
              {t.prompt}
            </div>
            <div className="sched-meta">
              <span className="mono">{fmtWhen(t)}</span>
              <span>·</span>
              <span>{fmtNext(t)}</span>
              {t.runs > 0 && <><span>·</span><span>
                {t.runs === 1
                  ? tr("scheduleview.oneRun")
                  : tr("scheduleview.valueRuns", { count: t.runs })}
                {t.lastRunAt ? tr("scheduleview.lastValueAgo", { value: ago(t.lastRunAt) }) : ""}
              </span></>}
              <span>·</span>
              <span>{targetLabel(t)}</span>
              {t.overlapPolicy && t.overlapPolicy !== "parallel" && <><span>·</span><span>{tr("scheduleview.overlap")}{" "}{t.overlapPolicy}</span></>}
            </div>
            {t.parseError && <div className="form-error">{tr("scheduleview.loopFileProblem")}{" "}{t.parseError}</div>}
            {t.lastError && <div className="form-error">{tr("scheduleview.lastRunFailed")}{" "}{t.lastError}</div>}
            {historyFor === t.id && <RunHistory taskId={t.id} />}
          </div>
          <div className="sched-actions">
            <button className="small-btn" onClick={() => setHistoryFor(historyFor === t.id ? null : t.id)}>
              {historyFor === t.id ? tr("scheduleview.hideRuns") : tr("scheduleview.runs")}
            </button>
            <button className="small-btn" onClick={() => void run(() => api.scheduleRun(t.id))}>{tr("scheduleview.runNow")}</button>
            {t.source !== "loop-file" && (
              <>
                <button className="small-btn" onClick={() => void run(() => api.schedulePause(t.id, t.enabled))}>
                  {t.enabled ? tr("common.pause") : tr("common.resume")}
                </button>
                <button className="small-btn danger-btn" onClick={() => void run(() => api.scheduleDelete(t.id))}>{tr("common.delete")}</button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
