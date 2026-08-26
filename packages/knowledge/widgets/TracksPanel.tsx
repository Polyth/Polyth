import { useCallback, useEffect, useState } from "react";
import type { TrackDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { ago } from "../../../apps/web/src/format.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { parseTrackSteps } from "../../../apps/web/src/trackForm.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

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
    return <div className="rail-empty">{tr("trackspanel.openAProjectToCreateASpec")}</div>;
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
          <strong>{tr("trackspanel.specDrivenTracks")}</strong>
          <div className="muted tracks-intro">{tr("trackspanel.eachVerifiedPlanStepBecomesOneGit")}</div>
        </div>
        <span className="header-spacer" />
        <button className="small-btn" onClick={() => setCreating((value) => !value)}>
          {creating ? tr("common.cancel") : tr("trackspanel.newTrack")}
        </button>
      </div>

      {creating && (
        <div className="track-create-form">
          <label>
            {tr("trackspanel.trackTitle")}<input value={title} placeholder={tr("trackspanel.addOfflineSync")} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            {tr("trackspanel.featureSpec")}<textarea
              rows={7}
              value={spec}
              placeholder={tr("trackspanel.problemDesiredBehaviorConstraintsAndAcceptanceCriteria")}
              onChange={(event) => setSpec(event.target.value)}
            />
          </label>
          <label>
            {tr("trackspanel.planSteps")}<textarea
              rows={5}
              value={stepLines}
              placeholder={tr("trackspanel.oneStepPerLineOptionalTitleDetailed")}
              onChange={(event) => setStepLines(event.target.value)}
            />
          </label>
          <label>
            {tr("trackspanel.testCommandForEveryStep")}<input
              className="mono"
              value={testCommand}
              placeholder={tr("trackspanel.nodeTestPackagesExampleTestExampleTest")}
              onChange={(event) => setTestCommand(event.target.value)}
            />
          </label>
          <div className="view-toolbar-row">
            <span className="muted">{steps.length} {tr("trackspanel.step")}{steps.length === 1 ? "" : tr("trackspanel.s")}</span>
            <span className="header-spacer" />
            <button className="primary-btn" disabled={!canCreate || busy === "create"} onClick={create}>
              {busy === "create" ? tr("trackspanel.creating") : tr("trackspanel.createSpecPlan")}
            </button>
          </div>
        </div>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="knowledge-notice" role="status">{notice}</div>}
      {tracks.length === 0 && !creating && (
        <div className="rail-empty">{tr("trackspanel.noTracksYetCreateOneToSave")}</div>
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
              <span>{completed}/{track.steps.length} {tr("trackspanel.steps")}</span>
              <span>·</span>
              <span>{tr("trackspanel.updated")}{" "}{ago(track.updatedAt)} {tr("trackspanel.ago")}</span>
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
                    {step.commitSha && <small>{tr("trackspanel.commit")}{" "}<code>{step.commitSha.slice(0, 12)}</code></small>}
                    {step.error && <small className="form-error">{step.error}</small>}
                    {step.test?.output && step.status === "failed" && (
                      <details>
                        <summary>{tr("trackspanel.testOutput")}</summary>
                        <pre>{step.test.output}</pre>
                      </details>
                    )}
                  </span>
                </li>
              ))}
            </ol>
            <div className="track-docs">
              {tr("trackspanel.featureSpecAndManagedPlanAreSaved")}{" "}{track.planRevision}
            </div>
            <div className="knowledge-actions">
              {track.status === "draft" && (
                <button
                  className="small-btn primary-btn"
                  disabled={!sessionId || busy === track.id}
                  title={sessionId ? tr("trackspanel.startValueInThisSession", {
                    value: active?.title ?? tr("trackspanel.nextStep"),
                  }) : tr("trackspanel.openASessionFirst")}
                  onClick={() => sessionId && void run(track.id, () => api.trackStart(track.id, sessionId), tr("trackspanel.trackStarted"))}
                >
                  {tr("trackspanel.startNextStep")}</button>
              )}
              {track.status === "blocked" && (
                <button
                  className="small-btn"
                  disabled={!sessionId || busy === track.id}
                  onClick={() => sessionId && void run(track.id, () => api.trackRetry(track.id, sessionId), tr("trackspanel.stepRetryStarted"))}
                >
                  {tr("trackspanel.retryStep")}</button>
              )}
              {track.status === "running" && (
                <button
                  className="small-btn"
                  disabled={busy === track.id}
                  title={tr("trackspanel.normallyAutomaticAfterTheGoalAuditorReports")}
                  onClick={() => void run(track.id, () => api.trackCompleteStep(track.id), tr("trackspanel.stepVerifiedAndCommitted"))}
                >
                  {tr("trackspanel.finalizeCompletedGoal")}</button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
