import { useCallback, useEffect, useState } from "react";
import type { TrackDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { ago } from "../../../apps/web/src/format.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { parseTrackSteps } from "../../../apps/web/src/trackForm.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, EmptyState, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";

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
    return <EmptyState title={tr("trackspanel.openAProjectToCreateASpec")} />;
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
      <div className="view-toolbar-row knowledge-toolbar">
        <div>
          <strong>{tr("trackspanel.specDrivenTracks")}</strong>
          <div className="muted tracks-intro">{tr("trackspanel.eachVerifiedPlanStepBecomesOneGit")}</div>
        </div>
        <span className="header-spacer knowledge-toolbar-spacer" />
        <Button size="sm" onClick={() => setCreating((value) => !value)}>
          {creating ? tr("common.cancel") : tr("trackspanel.newTrack")}
        </Button>
      </div>

      {creating && (
        <div className="track-create-form">
          <label>
            {tr("trackspanel.trackTitle")}<TextInput value={title} placeholder={tr("trackspanel.addOfflineSync")} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            {tr("trackspanel.featureSpec")}<Textarea
              rows={7}
              value={spec}
              placeholder={tr("trackspanel.problemDesiredBehaviorConstraintsAndAcceptanceCriteria")}
              onChange={(event) => setSpec(event.target.value)}
            />
          </label>
          <label>
            {tr("trackspanel.planSteps")}<Textarea
              rows={5}
              value={stepLines}
              placeholder={tr("trackspanel.oneStepPerLineOptionalTitleDetailed")}
              onChange={(event) => setStepLines(event.target.value)}
            />
          </label>
          <label>
            {tr("trackspanel.testCommandForEveryStep")}<TextInput
              className="mono"
              value={testCommand}
              placeholder={tr("trackspanel.nodeTestPackagesExampleTestExampleTest")}
              onChange={(event) => setTestCommand(event.target.value)}
            />
          </label>
          <div className="view-toolbar-row knowledge-toolbar">
            <span className="muted">{steps.length} {tr("trackspanel.step")}{steps.length === 1 ? "" : tr("trackspanel.s")}</span>
            <span className="header-spacer knowledge-toolbar-spacer" />
            <Button variant="primary" busy={busy === "create"} disabled={!canCreate} onClick={create}>
              {busy === "create" ? tr("trackspanel.creating") : tr("trackspanel.createSpecPlan")}
            </Button>
          </div>
        </div>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="form-success" role="status">{notice}</div>}
      {tracks.length === 0 && !creating && (
        <EmptyState title={tr("trackspanel.noTracksYetCreateOneToSave")} />
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
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!sessionId || busy === track.id}
                  title={sessionId ? tr("trackspanel.startValueInThisSession", {
                    value: active?.title ?? tr("trackspanel.nextStep"),
                  }) : tr("trackspanel.openASessionFirst")}
                  onClick={() => sessionId && void run(track.id, () => api.trackStart(track.id, sessionId), tr("trackspanel.trackStarted"))}
                >
                  {tr("trackspanel.startNextStep")}</Button>
              )}
              {track.status === "blocked" && (
                <Button
                  size="sm"
                  disabled={!sessionId || busy === track.id}
                  onClick={() => sessionId && void run(track.id, () => api.trackRetry(track.id, sessionId), tr("trackspanel.stepRetryStarted"))}
                >
                  {tr("trackspanel.retryStep")}</Button>
              )}
              {track.status === "running" && (
                <Button
                  size="sm"
                  disabled={busy === track.id}
                  title={tr("trackspanel.normallyAutomaticAfterTheGoalAuditorReports")}
                  onClick={() => void run(track.id, () => api.trackCompleteStep(track.id), tr("trackspanel.stepVerifiedAndCommitted"))}
                >
                  {tr("trackspanel.finalizeCompletedGoal")}</Button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
