import { useEffect, useState } from "react";
import type { WorkflowDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { createSession, openSession } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { getState, setActiveView, setUiError } from "../store.ts";
import { handOffWorkflowLaunch } from "../workflowLaunch.ts";
import { publishWorkflowRun } from "../workflowMonitor.ts";
import { Icon } from "../icons.tsx";
import Dialog from "./a11y/Dialog.tsx";

export interface WorkflowLauncherProps {
  projectId?: string;
  sessionId?: string;
  draftText: string;
  attachmentCount?: number;
  consumeDraft: () => void;
}

export default function WorkflowLauncher({
  projectId,
  sessionId,
  draftText,
  attachmentCount = 0,
  consumeDraft,
}: WorkflowLauncherProps) {
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [task, setTask] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) setTask(draftText);
  }, [open]);

  useEffect(() => {
    if (!open || !projectId) return;
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    void api.listWorkflows(projectId)
      .then((items) => { if (active) setWorkflows(items); })
      .catch((cause) => {
        if (active) {
          setWorkflows([]);
          setLoadFailed(true);
          setError(friendlyError("Couldn’t load workflows", cause));
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, projectId, loadAttempt]);

  const close = () => {
    if (!busyId) setOpen(false);
  };

  const openLauncher = () => {
    if (!projectId) return;
    setTask(draftText);
    setOpen(true);
  };

  const openBuilder = (workflowId?: string) => {
    if (!projectId || busyId) return;
    handOffWorkflowLaunch({
      projectId,
      ...(sessionId ? { sessionId } : {}),
      input: task,
      ...(workflowId ? { workflowId } : {}),
    });
    setOpen(false);
    setActiveView("workflow");
  };

  const run = async (workflow: WorkflowDto) => {
    if (!projectId || !task.trim() || busyId) return;
    setBusyId(workflow.id);
    setError("");
    try {
      let parentSessionId = sessionId;
      if (!parentSessionId) {
        await createSession(projectId, { title: `${workflow.name} workflow` });
        parentSessionId = getState().activeSessionId ?? undefined;
      }
      if (!parentSessionId) throw new Error("The parent session could not be created.");
      const started = await api.runWorkflow(workflow.id, parentSessionId, task.trim());
      // Consume immediately after the server accepts the run. openSession()
      // and workflow-run publication can remount Composer; clearing through
      // the old launcher's callback after either remount would leave the
      // replacement composer showing the submitted draft.
      consumeDraft();
      publishWorkflowRun(started);
      await openSession(parentSessionId, { showChat: false }).catch((cause) => {
        setUiError(friendlyError("Workflow started, but the parent timeline couldn’t refresh", cause));
      });
      handOffWorkflowLaunch({
        projectId,
        sessionId: parentSessionId,
        workflowId: workflow.id,
        input: task.trim(),
        run: started,
      });
      setOpen(false);
      setActiveView("workflow");
    } catch (cause) {
      setError(friendlyError("Couldn’t start the workflow", cause));
    } finally {
      setBusyId("");
    }
  };

  const hasDraft = draftText.trim().length > 0;
  return (
    <>
      <button
        type="button"
        className={`header-action composer-workflow${open ? " on" : ""}`}
        disabled={!projectId}
        onClick={openLauncher}
        title={!projectId
          ? "Open a project to use workflows"
          : hasDraft
            ? "Choose a workflow for this draft"
            : "Browse and run workflows"}
        aria-label={hasDraft ? "Run draft with a workflow" : "Browse workflows"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon.workflow /><span>{hasDraft ? "Run workflow" : "Workflows"}</span>
      </button>
      {open && (
        <Dialog
          title="Run a workflow"
          onClose={close}
          className="workflow-launch-dialog"
          backdropClassName="workflow-launch-backdrop"
          initialFocus="textarea"
          ariaDescribedBy="workflow-launch-description"
        >
          <header className="workflow-launch-heading">
            <span className="workflow-page-icon" aria-hidden="true"><Icon.workflow /></span>
            <div>
              <h2>Run a workflow</h2>
              <p id="workflow-launch-description">Choose a saved pipeline. Your draft becomes the shared task for every node.</p>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close workflow launcher"
              disabled={!!busyId}
              title={busyId ? "Wait for the workflow to start" : "Close workflow launcher"}
              onClick={close}
            >
              <Icon.close />
            </button>
          </header>
          <label className="workflow-field workflow-launch-task">
            <span>Task</span>
            <textarea
              rows={4}
              value={task}
              placeholder="Describe the task for this workflow…"
              disabled={!!busyId}
              aria-describedby="workflow-launch-task-help"
              onChange={(event) => { setTask(event.target.value); setError(""); }}
            />
            <small id="workflow-launch-task-help">This text is not sent as a normal chat message. It is logged as the workflow input.</small>
            {attachmentCount > 0 && (
              <small className="workflow-launch-attachment-note" role="note">
                {attachmentCount} {attachmentCount === 1 ? "attachment stays" : "attachments stay"} in this chat draft and will not be shared with workflow nodes.
              </small>
            )}
          </label>
          {error && !loadFailed && <div className="form-error workflow-error" role="alert">{error}</div>}
          {loading ? (
            <div className="workflow-list-state" role="status">
              <span className="workflow-spinner" aria-hidden="true" />Loading workflows…
            </div>
          ) : loadFailed ? (
            <div className="workflow-launch-empty workflow-launch-failed">
              <strong>Workflows couldn’t be loaded</strong>
              <span role="alert">{error} Your task is still here.</span>
              <button
                type="button"
                className="small-btn workflow-button"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                Retry
              </button>
            </div>
          ) : workflows.length > 0 ? (
            <ul className="workflow-launch-list" aria-label="Saved workflows">
              {workflows.map((workflow) => (
                <li key={workflow.id} className="workflow-launch-row">
                  <span className="workflow-definition-icon" aria-hidden="true"><Icon.workflow /></span>
                  <span>
                    <strong>{workflow.name}</strong>
                    <small>{workflow.nodes.length} {workflow.nodes.length === 1 ? "node" : "nodes"} · {workflow.defaults?.permissions === "manual" ? "manual approval" : "auto approve"}</small>
                  </span>
                  <button
                    type="button"
                    className="small-btn workflow-button"
                    disabled={!!busyId}
                    aria-label={`Edit ${workflow.name} workflow`}
                    onClick={() => openBuilder(workflow.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="primary-btn workflow-button"
                    disabled={!task.trim() || !!busyId}
                    title={!task.trim() ? "Enter a task before running" : `Run ${workflow.name}`}
                    aria-label={`Run ${workflow.name} workflow`}
                    aria-busy={busyId === workflow.id}
                    onClick={() => void run(workflow)}
                  >
                    {busyId === workflow.id ? "Starting…" : "Run"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="workflow-launch-empty">
              <strong>No workflows saved yet</strong>
              <span>Build a reusable agent pipeline, then return here to run it from Chat.</span>
            </div>
          )}
          <footer className="workflow-launch-footer">
            <button type="button" className="small-btn workflow-button" disabled={!!busyId} onClick={() => openBuilder()}>
              <Icon.plus />{workflows.length ? "Open workflow builder" : "Create workflow"}
            </button>
            <span aria-live="polite">
              {busyId
                ? "Starting workflow…"
                : !task.trim() && workflows.length > 0
                  ? "Enter a task to enable Run."
                  : ""}
            </span>
          </footer>
        </Dialog>
      )}
    </>
  );
}
