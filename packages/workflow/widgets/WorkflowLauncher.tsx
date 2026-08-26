import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkflowDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { createSession, openSession } from "../../../apps/web/src/init.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { getState, setActiveView, setUiError } from "../../../apps/web/src/store.ts";
import { handOffWorkflowLaunch } from "./workflowLaunch.ts";
import { publishWorkflowRun } from "./workflowMonitor.ts";
import { requestComposerReplace } from "../../../apps/web/src/composerInsert.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import Dialog from "../../../apps/web/src/components/a11y/Dialog.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { workflowNodeCount } from "./workflowRun.ts";
import WorkflowButtonContent from "../../../apps/web/src/components/WorkflowButtonContent.tsx";

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
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

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
          setError(friendlyError(tr("common.error"), cause));
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, projectId, loadAttempt]);

  const close = () => {
    if (busyId || closing) return;
    const duration = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : 130;
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closeTimer.current = null;
    }, duration);
  };

  const openLauncher = () => {
    if (!projectId) return;
    setTask(draftText);
    setClosing(false);
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
    const submittedTask = task.trim();
    let draftConsumed = false;
    setBusyId(workflow.id);
    setError("");
    try {
      let parentSessionId = sessionId;
      if (!parentSessionId) {
        await createSession(projectId, { title: tr("workflowlauncher.sessionTitleValue", { name: workflow.name }) });
        parentSessionId = getState().activeSessionId ?? undefined;
      }
      if (!parentSessionId) throw new Error(tr("workflowlauncher.parentCouldNotBeCreated"));
      // The server logs and broadcasts workflow/run-started before its HTTP
      // response resolves. Clear first so that event cannot replace the empty
      // hero Composer and seed its replacement with the submitted draft.
      consumeDraft();
      draftConsumed = true;
      const started = await api.runWorkflow(workflow.id, parentSessionId, submittedTask);
      publishWorkflowRun(started);
      await openSession(parentSessionId).catch((cause) => {
        setUiError(friendlyError(tr("workflowlauncher.couldNotStart"), cause));
      });
      setOpen(false);
    } catch (cause) {
      if (draftConsumed) requestComposerReplace(submittedTask);
      setError(friendlyError(tr("workflowlauncher.couldNotStart"), cause));
    } finally {
      setBusyId("");
    }
  };

  return (
    <>
      <button
        type="button"
        className={`header-action composer-workflow${open ? " on" : ""}`}
        disabled={!projectId}
        onClick={openLauncher}
        title={!projectId
          ? tr("workflowlauncher.openProject")
          : draftText.trim()
            ? tr("workflowlauncher.chooseWorkflowDraft")
            : tr("workflowlauncher.chooseWorkflowRun")}
        aria-label={tr("workflowview.runWorkflow")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon.workflow /><span>{tr("workflowview.runWorkflow")}</span>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <Dialog
          title={tr("workflowlauncher.title")}
          onClose={close}
          className="workflow-launch-dialog"
          backdropClassName={`workflow-launch-backdrop${closing ? " is-closing" : ""}`}
          initialFocus="textarea"
          ariaDescribedBy="workflow-launch-description"
        >
          <header className="workflow-launch-heading">
            <span className="workflow-page-icon" aria-hidden="true"><Icon.workflow /></span>
            <div>
              <h2>{tr("workflowlauncher.title")}</h2>
              <p id="workflow-launch-description">{tr("workflowlauncher.chooseSavedPipeline")}</p>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label={tr("workflowlauncher.close")}
              disabled={!!busyId || closing}
              title={busyId ? tr("workflowlauncher.waitToClose") : tr("workflowlauncher.close")}
              onClick={close}
            >
              <Icon.close />
            </button>
          </header>
          <label className="workflow-field workflow-launch-task">
            <span>{tr("workflowlauncher.task")}</span>
            <textarea
              rows={4}
              value={task}
              placeholder={tr("workflowlauncher.taskPlaceholder")}
              disabled={!!busyId}
              aria-describedby="workflow-launch-task-help"
              onChange={(event) => { setTask(event.target.value); setError(""); }}
            />
            <small id="workflow-launch-task-help">{tr("workflowlauncher.taskHelp")}</small>
            {attachmentCount > 0 && (
              <small className="workflow-launch-attachment-note" role="note">
                {tr(attachmentCount === 1
                  ? "workflowlauncher.attachmentOne"
                  : "workflowlauncher.attachmentOther", { count: attachmentCount })}
              </small>
            )}
          </label>
          {error && !loadFailed && <div className="form-error workflow-error" role="alert">{error}</div>}
          {loading ? (
            <ul className="workflow-launch-list workflow-launch-skeleton" role="status" aria-label={tr("workflowlauncher.loading")}>
              {[0, 1, 2].map((item) => (
                <li key={item} className="workflow-launch-row" aria-hidden="true">
                  <span className="workflow-definition-icon workflow-skeleton-block" />
                  <span><strong className="workflow-skeleton-line" /><small className="workflow-skeleton-line short" /></span>
                  <span className="workflow-skeleton-button workflow-skeleton-block" />
                </li>
              ))}
            </ul>
          ) : loadFailed ? (
            <div className="workflow-launch-empty workflow-launch-failed">
              <strong role="alert">{tr("workflowlauncher.couldNotLoad")}</strong>
              <span>{error}. {tr("workflowlauncher.taskStillHere")}</span>
              <button
                type="button"
                className="small-btn workflow-button"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                {tr("common.retry")}
              </button>
            </div>
          ) : workflows.length > 0 ? (
            <ul className="workflow-launch-list" aria-label={tr("workflowlauncher.savedWorkflows")}>
              {workflows.map((workflow) => (
                <li key={workflow.id} className="workflow-launch-row">
                  <span className="workflow-definition-icon" aria-hidden="true"><Icon.workflow /></span>
                  <span>
                    <strong>{workflow.name}</strong>
                    <small>{workflowNodeCount(workflow.nodes.length)} · {workflow.defaults?.permissions === "manual" ? tr("workflowlauncher.manualApproval") : tr("workflowlauncher.autoApprove")}</small>
                  </span>
                  <button
                    type="button"
                    className="small-btn workflow-button"
                    disabled={!!busyId}
                    aria-label={tr("workflowlauncher.editValue", { name: workflow.name })}
                    onClick={() => openBuilder(workflow.id)}
                  >
                    {tr("common.edit")}
                  </button>
                  <button
                    type="button"
                    className="primary-btn workflow-button"
                    disabled={!task.trim() || !!busyId}
                    title={!task.trim() ? tr("workflowlauncher.enterTaskBeforeRunning") : tr("workflowlauncher.runValue", { name: workflow.name })}
                    aria-label={tr("workflowlauncher.runValue", { name: workflow.name })}
                    aria-busy={busyId === workflow.id}
                    onClick={() => void run(workflow)}
                  >
                    <WorkflowButtonContent
                      busy={busyId === workflow.id}
                      idleLabel={tr("workflowlauncher.run")}
                      busyLabel={tr("workflowlauncher.starting")}
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="workflow-launch-empty">
              <strong>{tr("workflowlauncher.noWorkflows")}</strong>
              <span>{tr("workflowlauncher.buildReusablePipeline")}</span>
              <button type="button" className="small-btn workflow-button" disabled={!!busyId} onClick={() => openBuilder()}>
                <Icon.plus />{tr("workflowlauncher.createWorkflow")}
              </button>
            </div>
          )}
          <footer className="workflow-launch-footer">
            {(loading || loadFailed || workflows.length > 0) && (
              <button
                type="button"
                className="small-btn workflow-button"
                disabled={!!busyId}
                aria-busy={false}
                onClick={() => openBuilder()}
              >
                <Icon.plus />{tr("workflowlauncher.openBuilder")}
              </button>
            )}
            <span aria-live="polite">
              {busyId
                ? tr("workflowlauncher.startingWorkflow")
                : !task.trim() && workflows.length > 0
                  ? tr("workflowlauncher.enterTaskToEnable")
                  : ""}
            </span>
          </footer>
        </Dialog>,
        document.body,
      )}
    </>
  );
}
