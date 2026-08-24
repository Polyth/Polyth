import { useEffect, useState } from "react";
import type { WorkflowDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { createSession } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { getState, setActiveView } from "../store.ts";
import { handOffWorkflowLaunch } from "../workflowLaunch.ts";
import { Icon } from "../icons.tsx";
import Dialog from "./a11y/Dialog.tsx";

export interface WorkflowLauncherProps {
  projectId?: string;
  sessionId?: string;
  draftText: string;
  consumeDraft: () => void;
}

export default function WorkflowLauncher({
  projectId,
  sessionId,
  draftText,
  consumeDraft,
}: WorkflowLauncherProps) {
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [task, setTask] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !projectId) return;
    let active = true;
    setTask(draftText);
    setLoading(true);
    setError("");
    void api.listWorkflows(projectId)
      .then((items) => { if (active) setWorkflows(items); })
      .catch((cause) => {
        if (active) setError(friendlyError("Couldn’t load workflows", cause));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, projectId]);

  const openBuilder = (workflowId?: string) => {
    if (!projectId) return;
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
      consumeDraft();
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
        onClick={() => setOpen(true)}
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
          onClose={() => setOpen(false)}
          className="workflow-launch-dialog"
          initialFocus="textarea"
        >
          <header className="workflow-launch-heading">
            <span className="workflow-page-icon" aria-hidden="true"><Icon.workflow /></span>
            <div>
              <h2>Run a workflow</h2>
              <p>Choose a saved pipeline. Your draft becomes the shared task for every node.</p>
            </div>
            <button type="button" className="icon-btn" aria-label="Close workflow launcher" onClick={() => setOpen(false)}>
              <Icon.close />
            </button>
          </header>
          <label className="workflow-field workflow-launch-task">
            <span>Task</span>
            <textarea
              rows={4}
              value={task}
              placeholder="Describe the task for this workflow…"
              onChange={(event) => { setTask(event.target.value); setError(""); }}
            />
            <small>This text is not sent as a normal chat message. It is logged as the workflow input.</small>
          </label>
          {error && <div className="form-error workflow-error" role="alert">{error}</div>}
          {loading ? (
            <div className="workflow-list-state" role="status">
              <span className="workflow-spinner" aria-hidden="true" />Loading workflows…
            </div>
          ) : workflows.length > 0 ? (
            <div className="workflow-launch-list" aria-label="Saved workflows">
              {workflows.map((workflow) => (
                <article key={workflow.id} className="workflow-launch-row">
                  <span className="workflow-definition-icon" aria-hidden="true"><Icon.workflow /></span>
                  <span>
                    <strong>{workflow.name}</strong>
                    <small>{workflow.nodes.length} {workflow.nodes.length === 1 ? "node" : "nodes"} · {workflow.defaults?.permissions === "manual" ? "manual approval" : "auto approve"}</small>
                  </span>
                  <button type="button" className="small-btn" disabled={!!busyId} onClick={() => openBuilder(workflow.id)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={!task.trim() || !!busyId}
                    title={!task.trim() ? "Enter a task before running" : `Run ${workflow.name}`}
                    onClick={() => void run(workflow)}
                  >
                    {busyId === workflow.id ? "Starting…" : "Run"}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="workflow-launch-empty">
              <strong>No workflows saved yet</strong>
              <span>Build a reusable agent pipeline, then return here to run it from Chat.</span>
            </div>
          )}
          <footer className="workflow-launch-footer">
            <button type="button" className="small-btn" onClick={() => openBuilder()}>
              <Icon.plus />{workflows.length ? "Open workflow builder" : "Create workflow"}
            </button>
            {!task.trim() && workflows.length > 0 && <span>Enter a task to enable Run.</span>}
          </footer>
        </Dialog>
      )}
    </>
  );
}
