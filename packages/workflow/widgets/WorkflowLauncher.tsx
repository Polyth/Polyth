import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkflowDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { createSession, openSession } from "../../../apps/web/src/init.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { openWorkspacePane, setUiError } from "../../../apps/web/src/store.ts";
import { handOffWorkflowLaunch } from "./workflowLaunch.ts";
import { publishWorkflowRun } from "./workflowMonitor.ts";
import { requestComposerReplace } from "../../../apps/web/src/composerInsert.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import Dialog from "../../../apps/web/src/components/a11y/Dialog.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { workflowNodeCount } from "./workflowRun.ts";
import { workflowSampleByName } from "../src/sampleCatalog.ts";
import {
  AddIcon,
  Button,
  IconButton,
  Textarea,
  WorkflowIcon,
} from "../../../apps/web/src/components/ui/index.ts";

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
    openWorkspacePane("workflow");
  };

  const run = async (workflow: WorkflowDto) => {
    if (!projectId || busyId) return;
    const enteredTask = task.trim();
    const submittedTask = enteredTask || workflowSampleByName(workflow.name)?.exampleInput || "";
    if (!submittedTask) return;
    let draftConsumed = false;
    setBusyId(workflow.id);
    setError("");
    try {
      let parentSessionId = sessionId;
      if (!parentSessionId) {
        parentSessionId = await createSession(projectId, {
          title: tr("workflowlauncher.sessionTitleValue", { name: workflow.name }),
        });
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
      if (draftConsumed && enteredTask) requestComposerReplace(enteredTask);
      setError(friendlyError(tr("workflowlauncher.couldNotStart"), cause));
    } finally {
      setBusyId("");
    }
  };

  return (
    <>
      <IconButton
        className={`header-action composer-workflow${open ? " on" : ""}`}
        icon={WorkflowIcon}
        size="md"
        variant="ghost"
        disabled={!projectId}
        pressed={open}
        onClick={openLauncher}
        title={!projectId
          ? tr("workflowlauncher.openProject")
          : draftText.trim()
            ? tr("workflowlauncher.chooseWorkflowDraft")
            : tr("workflowlauncher.chooseWorkflowRun")}
        label={tr("workflowview.runWorkflow")}
        aria-haspopup="dialog"
        aria-expanded={open}
      />
      {open && typeof document !== "undefined" && createPortal(
        <Dialog
          title={tr("workflowlauncher.title")}
          onClose={close}
          className="workflow-launch-dialog"
          backdropClassName={`workflow-launch-backdrop${closing ? " is-closing" : ""}`}
          initialFocus="textarea"
          ariaDescribedBy="workflow-launch-description"
          showHeader
          closeLabel={tr("workflowlauncher.close")}
        >
          <p id="workflow-launch-description" className="workflow-launch-description">{tr("workflowlauncher.chooseSavedPipeline")}</p>
          <label className="workflow-field workflow-launch-task">
            <span>{tr("workflowlauncher.task")}</span>
            <Textarea
              minRows={4}
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
              <Button size="sm" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                {tr("common.retry")}
              </Button>
            </div>
          ) : workflows.length > 0 ? (
            <ul className="workflow-launch-list" aria-label={tr("workflowlauncher.savedWorkflows")}>
              {workflows.map((workflow) => {
                const sample = workflowSampleByName(workflow.name);
                const canRun = !!task.trim() || !!sample?.exampleInput;
                return (
                  <li key={workflow.id} className="workflow-launch-row">
                    <span className="workflow-definition-icon" aria-hidden="true"><Icon.workflow /></span>
                    <span>
                      <strong>{workflow.name}</strong>
                      {sample && <small className="workflow-sample-description">{sample.description}</small>}
                      <small>{workflowNodeCount(workflow.nodes.length)} · {workflow.defaults?.permissions === "manual" ? tr("workflowlauncher.manualApproval") : tr("workflowlauncher.autoApprove")}</small>
                    </span>
                    <Button
                      size="sm"
                      disabled={!!busyId}
                      aria-label={tr("workflowlauncher.editValue", { name: workflow.name })}
                      onClick={() => openBuilder(workflow.id)}
                    >
                      {tr("common.edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!canRun || !!busyId}
                      busy={busyId === workflow.id}
                      title={!canRun
                        ? tr("workflowlauncher.enterTaskBeforeRunning")
                        : !task.trim() && sample
                          ? sample.exampleInput
                          : tr("workflowlauncher.runValue", { name: workflow.name })}
                      aria-label={tr("workflowlauncher.runValue", { name: workflow.name })}
                      onClick={() => void run(workflow)}
                    >
                      {tr("workflowlauncher.run")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="workflow-launch-empty">
              <strong>{tr("workflowlauncher.noWorkflows")}</strong>
              <span>{tr("workflowlauncher.buildReusablePipeline")}</span>
              <Button size="sm" iconStart={AddIcon} disabled={!!busyId} onClick={() => openBuilder()}>
                {tr("workflowlauncher.createWorkflow")}
              </Button>
            </div>
          )}
          <footer className="workflow-launch-footer">
            {(loading || loadFailed || workflows.length > 0) && (
              <Button
                size="sm"
                iconStart={AddIcon}
                disabled={!!busyId}
                onClick={() => openBuilder()}
              >
                {tr("workflowlauncher.openBuilder")}
              </Button>
            )}
            <span aria-live="polite">
              {busyId
                ? tr("workflowlauncher.startingWorkflow")
                : !task.trim() && workflows.length > 0 && !workflows.some((workflow) => workflowSampleByName(workflow.name))
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
