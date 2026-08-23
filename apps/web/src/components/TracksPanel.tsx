import { useCallback, useEffect, useState } from "react";
import type { TrackDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { ago } from "../format.ts";
import { useStore } from "../store.ts";
import { parseTrackSteps } from "../trackForm.ts";

export default function TracksPanel() {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const [tracks, setTracks] = useState<TrackDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [stepLines, setStepLines] = useState("");
  const [testCommand, setTestCommand] = useState("npm test");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(() => {
    if (!projectId) {
      setTracks([]);
      return;
    }
    void api.trackList(projectId).then(setTracks);
  }, [projectId]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!tracks.some((track) => track.status === "running")) return;
    const timer = setInterval(reload, 3_000);
    return () => clearInterval(timer);
  }, [reload, tracks]);

  if (!projectId) {
    return <div className="rail-empty">Open a project to create a spec-driven track.</div>;
  }

  const steps = parseTrackSteps(stepLines, testCommand);
  const canCreate = title.trim().length > 0 && spec.trim().length > 0 && steps.length > 0;

  const run = async (key: string, action: () => Promise<unknown>, message = "") => {
    setBusy(key);
    setError("");
    try {
      await action();
      reload();
      if (message) {
        setNotice(message);
        setTimeout(() => setNotice(""), 3_000);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const create = () => void run("create", async () => {
    await api.trackCreate({
      projectId,
      title: title.trim(),
      spec: spec.trim(),
      steps,
    });
    setTitle("");
    setSpec("");
    setStepLines("");
    setCreating(false);
  }, "Track created with a saved feature spec and plan.");

  return (
    <div className="tracks-panel">
      <div className="view-toolbar-row">
        <div>
          <strong>Spec-driven tracks</strong>
          <div className="muted tracks-intro">Each verified plan step becomes one Git commit.</div>
        </div>
        <span className="header-spacer" />
        <button className="small-btn" onClick={() => setCreating((value) => !value)}>
          {creating ? "Cancel" : "New track"}
        </button>
      </div>

      {creating && (
        <div className="track-create-form">
          <label>
            Track title
            <input value={title} placeholder="Add offline sync" onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Feature spec
            <textarea
              rows={7}
              value={spec}
              placeholder="Problem, desired behavior, constraints, and acceptance criteria…"
              onChange={(event) => setSpec(event.target.value)}
            />
          </label>
          <label>
            Plan steps
            <textarea
              rows={5}
              value={stepLines}
              placeholder={"One step per line\nOptional title :: detailed instructions"}
              onChange={(event) => setStepLines(event.target.value)}
            />
          </label>
          <label>
            Test command for every step
            <input
              className="mono"
              value={testCommand}
              placeholder="node --test packages/example/test/example.test.ts"
              onChange={(event) => setTestCommand(event.target.value)}
            />
          </label>
          <div className="view-toolbar-row">
            <span className="muted">{steps.length} step{steps.length === 1 ? "" : "s"}</span>
            <span className="header-spacer" />
            <button className="primary-btn" disabled={!canCreate || busy === "create"} onClick={create}>
              {busy === "create" ? "Creating…" : "Create spec + plan"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="knowledge-notice" role="status">{notice}</div>}
      {tracks.length === 0 && !creating && (
        <div className="rail-empty">No tracks yet. Create one to save a feature spec and sequential implementation plan.</div>
      )}

      {tracks.map((track) => {
        const completed = track.steps.filter((step) => step.status === "completed").length;
        const active = track.steps[track.currentStep];
        return (
          <section className={`track-card track-${track.status}`} key={track.id}>
            <div className="knowledge-card-head">
              <span className={`track-status track-status-${track.status}`}>{track.status}</span>
              <span className="knowledge-title">{track.title}</span>
            </div>
            <div className="track-progress">
              <span>{completed}/{track.steps.length} steps</span>
              <span>·</span>
              <span>updated {ago(track.updatedAt)} ago</span>
            </div>
            <ol className="track-steps">
              {track.steps.map((step, index) => (
                <li key={step.id} className={`track-step track-step-${step.status}`}>
                  <span className="track-step-marker" aria-hidden="true">
                    {step.status === "completed" ? "✓" : step.status === "running" ? "●" : step.status === "failed" ? "!" : index + 1}
                  </span>
                  <span className="track-step-content">
                    <strong>{step.title}</strong>
                    <small className="mono">{step.testCommand}</small>
                    {step.commitSha && <small>commit <code>{step.commitSha.slice(0, 12)}</code></small>}
                    {step.error && <small className="form-error">{step.error}</small>}
                    {step.test?.output && step.status === "failed" && (
                      <details>
                        <summary>Test output</summary>
                        <pre>{step.test.output}</pre>
                      </details>
                    )}
                  </span>
                </li>
              ))}
            </ol>
            <div className="track-docs">
              Feature spec and managed plan are saved in Knowledge · plan rev {track.planRevision}
            </div>
            <div className="knowledge-actions">
              {track.status === "draft" && (
                <button
                  className="small-btn primary-btn"
                  disabled={!sessionId || busy === track.id}
                  title={sessionId ? `Start ${active?.title ?? "next step"} in this session` : "Open a session first"}
                  onClick={() => sessionId && void run(track.id, () => api.trackStart(track.id, sessionId), "Track started.")}
                >
                  Start next step
                </button>
              )}
              {track.status === "blocked" && (
                <button
                  className="small-btn"
                  disabled={!sessionId || busy === track.id}
                  onClick={() => sessionId && void run(track.id, () => api.trackRetry(track.id, sessionId), "Step retry started.")}
                >
                  Retry step
                </button>
              )}
              {track.status === "running" && (
                <button
                  className="small-btn"
                  disabled={busy === track.id}
                  title="Normally automatic after the goal auditor reports done"
                  onClick={() => void run(track.id, () => api.trackCompleteStep(track.id), "Step verified and committed.")}
                >
                  Finalize completed goal
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
