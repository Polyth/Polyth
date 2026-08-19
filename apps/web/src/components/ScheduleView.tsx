// Scheduled prompts: send a prompt at a time or on an interval, into a fresh
// session or an existing one. Backed by @polyth/schedule via /api/schedule.
import { useCallback, useEffect, useState } from "react";
import { api, type ScheduleTaskDto } from "../api.ts";
import { useStore } from "../store.ts";
import { ago } from "../format.ts";

function fmtWhen(t: ScheduleTaskDto): string {
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

export default function ScheduleView() {
  const projectId = useStore((s) => s.activeProjectId);
  const sessions = useStore((s) => s.sessions.filter((x) => x.projectId === s.activeProjectId && x.status !== "archived"));
  const [tasks, setTasks] = useState<ScheduleTaskDto[]>([]);
  const [error, setError] = useState("");

  // form
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"at" | "every">("at");
  const [at, setAt] = useState("");
  const [every, setEvery] = useState(60);
  const [sessionId, setSessionId] = useState("");

  const reload = useCallback(() => {
    if (!projectId) { setTasks([]); return; }
    void api.scheduleList(projectId).then(setTasks);
  }, [projectId]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!projectId) return <div className="view-page"><div className="view-empty">Open a project to schedule prompts.</div></div>;

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
    await api.scheduleCreate({
      projectId,
      prompt,
      kind,
      ...(kind === "at" ? { at: new Date(at).getTime() } : { everyMinutes: every }),
      ...(sessionId ? { sessionId } : {}),
    });
    setPrompt("");
    setAt("");
  });

  return (
    <div className="view-page">
      <div>
        <h2 className="view-title">Schedule</h2>
        <p className="view-sub">Send a prompt at a time or on an interval — into a fresh session or an existing one. Runs while the Polyth server is up.</p>
      </div>

      <div className="sched-form">
        <textarea rows={2} value={prompt} placeholder="Prompt to send, e.g. “Summarize overnight CI failures”" onChange={(e) => setPrompt(e.target.value)} />
        <div className="view-toolbar-row">
          <div className="seg">
            <button className={kind === "at" ? "on" : ""} onClick={() => setKind("at")}>Once at</button>
            <button className={kind === "every" ? "on" : ""} onClick={() => setKind("every")}>Every</button>
          </div>
          {kind === "at" ? (
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          ) : (
            <label className="sched-every">
              <input type="number" min={1} value={every} onChange={(e) => setEvery(Math.max(1, Number(e.target.value)))} style={{ width: 72 }} />
              minutes
            </label>
          )}
          <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            <option value="">New session per run</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}
          </select>
          <span className="header-spacer" />
          <button
            className="primary-btn"
            disabled={!prompt.trim() || (kind === "at" && !at)}
            onClick={create}
          >Schedule</button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>

      {tasks.length === 0 && <div className="view-empty">Nothing scheduled yet.</div>}
      {tasks.map((t) => (
        <div key={t.id} className={`sched-card ${t.enabled ? "" : "paused"}`}>
          <div className="sched-card-main">
            <div className="sched-prompt">{t.prompt}</div>
            <div className="sched-meta">
              <span className="mono">{fmtWhen(t)}</span>
              <span>·</span>
              <span>{fmtNext(t)}</span>
              {t.runs > 0 && <><span>·</span><span>{t.runs} run{t.runs === 1 ? "" : "s"}{t.lastRunAt ? `, last ${ago(t.lastRunAt)} ago` : ""}</span></>}
              <span>·</span>
              <span>{t.sessionId ? "into existing session" : "new session per run"}</span>
            </div>
            {t.lastError && <div className="form-error">Last run failed: {t.lastError}</div>}
          </div>
          <div className="sched-actions">
            <button className="small-btn" onClick={() => void run(() => api.scheduleRun(t.id))}>Run now</button>
            <button className="small-btn" onClick={() => void run(() => api.schedulePause(t.id, t.enabled))}>
              {t.enabled ? "Pause" : "Resume"}
            </button>
            <button className="small-btn danger-btn" onClick={() => void run(() => api.scheduleDelete(t.id))}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
