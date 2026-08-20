// Scheduled prompts: once, every N minutes, or cron with an IANA time zone.
// Tasks target an existing session, a fresh session per run, or a dedicated
// session. Loop files under .agents/loops appear here with a "loop" badge.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ScheduleCadenceDto, type ScheduleRunDto, type ScheduleTaskDto } from "../api.ts";
import { useStore } from "../store.ts";
import { ago } from "../format.ts";
import { normalizeScheduleList } from "../scheduleData.ts";
import EmptyState from "./EmptyState.tsx";

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
  if (c?.kind === "every") return `every ${c.everyMinutes} min`;
  if (c?.kind === "at") return new Date(c.at).toLocaleString();
  if (t.kind === "every") return `every ${t.everyMinutes} min`;
  return t.at ? new Date(t.at).toLocaleString() : "—";
}

function fmtNext(t: ScheduleTaskDto): string {
  if (!t.enabled) return "paused";
  if (t.nextRunAt === null) return "done";
  const delta = t.nextRunAt - Date.now();
  if (delta <= 0) return "due now";
  return `in ${ago(Date.now() - delta)}`;
}

function targetLabel(t: ScheduleTaskDto): string {
  const mode = t.target?.mode ?? (t.sessionId ? "existing-session" : "new-session-per-run");
  if (mode === "existing-session") return "into existing session";
  if (mode === "dedicated-session") return "dedicated session";
  return "new session per run";
}

function RunHistory({ taskId }: { taskId: string }) {
  const [runs, setRuns] = useState<ScheduleRunDto[] | null>(null);
  useEffect(() => { void api.scheduleRuns(taskId).then(setRuns); }, [taskId]);
  if (runs === null) return <div className="muted" style={{ fontSize: 12 }}>Loading runs…</div>;
  if (runs.length === 0) return <div className="muted" style={{ fontSize: 12 }}>No runs recorded yet.</div>;
  return (
    <div className="sched-runs">
      {runs.map((r) => (
        <div key={r.runId} className={`sched-run status-${r.status}`}>
          <span className={`sched-run-dot ${r.status}`} />
          <span className="mono">{new Date(r.startedAt).toLocaleString()}</span>
          <span>{r.status}</span>
          {r.finishedAt !== undefined && <span className="muted">{Math.max(0, Math.round((r.finishedAt - r.startedAt) / 1000))}s</span>}
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
        setError(`Could not load scheduled prompts: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
  }, [projectId]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to schedule prompts." />;

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
    if (!cadence) throw new Error("Pick a valid time, interval, or cron expression first.");
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
        <h2 className="view-title">Schedule</h2>
        <p className="view-sub">Send a prompt once, on an interval, or on a cron cadence with a time zone. Loop files in <code>.agents/loops</code> appear here too. Runs while the Polyth server is up.</p>
      </div>

      <div className="sched-form">
        <textarea rows={2} value={prompt} placeholder="Prompt to send, e.g. “Summarize overnight CI failures”" onChange={(e) => setPrompt(e.target.value)} />
        <div className="view-toolbar-row">
          <div className="seg">
            <button className={kind === "at" ? "on" : ""} onClick={() => setKind("at")}>Once at</button>
            <button className={kind === "every" ? "on" : ""} onClick={() => setKind("every")}>Every</button>
            <button className={kind === "cron" ? "on" : ""} onClick={() => setKind("cron")}>Cron</button>
          </div>
          {kind === "at" && <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
          {kind === "every" && (
            <label className="sched-every">
              <input type="number" min={1} value={every} onChange={(e) => setEvery(Math.max(1, Number(e.target.value)))} style={{ width: 72 }} />
              minutes
            </label>
          )}
          {kind === "cron" && (
            <>
              <input className="mono" style={{ width: 160 }} value={cronExpr} placeholder="0 9 * * 1-5" onChange={(e) => setCronExpr(e.target.value)} />
              <select value={timeZone} onChange={(e) => setTimeZone(e.target.value)} style={{ maxWidth: 220 }}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </>
          )}
        </div>
        <div className="view-toolbar-row">
          <select value={targetMode} onChange={(e) => { setTargetMode(e.target.value as TargetMode); if (e.target.value !== "existing-session") setSessionId(""); }}>
            <option value="new-session-per-run">New session per run</option>
            <option value="existing-session">Existing session</option>
            <option value="dedicated-session">Dedicated session (reused across runs)</option>
          </select>
          {targetMode === "existing-session" && (
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">Pick a session…</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}
            </select>
          )}
          <label className="sched-every">
            If still running:
            <select value={overlap} onChange={(e) => setOverlap(e.target.value as Overlap)}>
              <option value="skip">Skip this run</option>
              <option value="queue">Queue after</option>
              <option value="parallel">Run in parallel</option>
            </select>
          </label>
          <span className="header-spacer" />
          <button className="primary-btn" disabled={!canCreate} onClick={create}>Schedule</button>
        </div>
        {previewError && <div className="form-error">{previewError}</div>}
        {preview && (
          <div className="sched-preview">
            <div className="sched-preview-desc">{preview.description}</div>
            {preview.runs.length > 0 && (
              <div className="sched-preview-runs">
                Next: {preview.runs.map((ms) => new Date(ms).toLocaleString()).join("  ·  ")}
              </div>
            )}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>

      <div className="view-toolbar-row">
        <span className="stat-label" style={{ margin: 0 }}>Tasks</span>
        <span className="header-spacer" />
        <button className="small-btn" title="Rescan .agents/loops for Markdown-managed tasks" onClick={rescan}>Rescan loops</button>
      </div>
      {loopErrors.length > 0 && (
        <div className="form-error">
          {loopErrors.map((e) => <div key={e.path}><span className="mono">{e.path}</span>: {e.error}</div>)}
        </div>
      )}

      {tasks.length === 0 && <EmptyState title="Nothing scheduled" description="Create a one-time, interval, or cron prompt with the form." />}
      {tasks.map((t) => (
        <div key={t.id} className={`sched-card ${t.enabled ? "" : "paused"}`}>
          <div className="sched-card-main">
            <div className="sched-prompt">
              {t.source === "loop-file" && <span className="sched-loop-badge" title={t.sourcePath ?? "Managed by a loop file"}>loop</span>}
              {t.title ? <strong>{t.title}: </strong> : null}
              {t.prompt}
            </div>
            <div className="sched-meta">
              <span className="mono">{fmtWhen(t)}</span>
              <span>·</span>
              <span>{fmtNext(t)}</span>
              {t.runs > 0 && <><span>·</span><span>{t.runs} run{t.runs === 1 ? "" : "s"}{t.lastRunAt ? `, last ${ago(t.lastRunAt)} ago` : ""}</span></>}
              <span>·</span>
              <span>{targetLabel(t)}</span>
              {t.overlapPolicy && t.overlapPolicy !== "parallel" && <><span>·</span><span>overlap: {t.overlapPolicy}</span></>}
            </div>
            {t.parseError && <div className="form-error">Loop file problem: {t.parseError}</div>}
            {t.lastError && <div className="form-error">Last run failed: {t.lastError}</div>}
            {historyFor === t.id && <RunHistory taskId={t.id} />}
          </div>
          <div className="sched-actions">
            <button className="small-btn" onClick={() => setHistoryFor(historyFor === t.id ? null : t.id)}>
              {historyFor === t.id ? "Hide runs" : "Runs"}
            </button>
            <button className="small-btn" onClick={() => void run(() => api.scheduleRun(t.id))}>Run now</button>
            {t.source !== "loop-file" && (
              <>
                <button className="small-btn" onClick={() => void run(() => api.schedulePause(t.id, t.enabled))}>
                  {t.enabled ? "Pause" : "Resume"}
                </button>
                <button className="small-btn danger-btn" onClick={() => void run(() => api.scheduleDelete(t.id))}>Delete</button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
