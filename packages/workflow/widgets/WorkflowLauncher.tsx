import { useEffect, useRef, useState } from "react";
import type {
  AttachmentRef,
  HarnessSelection,
  ModelRef,
  WorkflowDto,
  WorkflowPreferencesDto,
  WorkflowRunDto,
} from "@polyth/contracts";
import { onConnectionRestored } from "@polyth/contracts/transport-retry";
import { api } from "@polyth/session/web-api";
import { openSession } from "../../../apps/web/src/init.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { getState, openWorkspacePane, setUiError } from "../../../apps/web/src/store.ts";
import { publishWorkflowRun } from "./workflowMonitor.ts";
import { handOffWorkflowLaunch } from "./workflowLaunch.ts";
import { beginWorkflowStart } from "./workflowStart.ts";
import { orderWorkflows } from "../src/presets.ts";
import { workflowDisplayName, workflowDisplayDescription, workflowTopology } from "./workflowLabels.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import ChatActionButton from "../../../apps/web/src/components/ChatActionButton.tsx";
import {
  AddIcon,
  Button,
  IconButton,
  ResponsiveOverlay,
  WorkflowIcon,
} from "../../../apps/web/src/components/ui/index.ts";

export const WORKFLOW_LAUNCH_REQUEST = "polyth:workflow-launch-request";

export interface WorkflowLaunchRequest {
  spaceId?: string;
  projectId?: string;
  sessionId?: string;
  input?: string;
  sourceMessageSeq?: number;
}

export function requestWorkflowLauncher(request: WorkflowLaunchRequest = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<WorkflowLaunchRequest>(WORKFLOW_LAUNCH_REQUEST, { detail: request }));
}

export interface WorkflowLauncherProps {
  projectId?: string;
  spaceId?: string;
  sessionId?: string;
  draftText: string;
  workflowAttachments?: AttachmentRef[];
  attachmentCount?: number;
  consumeDraft?: (expectedText?: string) => boolean | void;
  sourceMessageSeq?: number;
  workflowBusy?: boolean;
  /** Current composer route, used as the default for unassigned workflow nodes. */
  model?: ModelRef;
  harness?: HarnessSelection;
  agent?: string;
  /** Message actions opt out of eager loading and the global command listener. */
  lazy?: boolean;
  subscribeToRequests?: boolean;
  triggerLabel?: string;
  /** `composer`: the composer's header-action glyph. `message`: the shared
   *  quick-action button under a message. `none`: no trigger; the launcher
   *  opens on `openRequest` and anchors to `anchor()` (a message's "More"). */
  trigger?: "composer" | "message" | "none";
  /** Opens the launcher each time it increases (with `trigger: "none"`). */
  openRequest?: number;
  anchor?: () => HTMLElement | null;
}

const EMPTY_PREFERENCES: WorkflowPreferencesDto = { pinnedIds: [], recentIds: [] };
const INITIAL_VISIBLE_WORKFLOWS = 4;
const MORE_WORKFLOWS = 4;

function operationId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function WorkflowLauncher({
  projectId,
  spaceId,
  sessionId,
  draftText,
  workflowAttachments = [],
  attachmentCount = 0,
  consumeDraft,
  sourceMessageSeq,
  workflowBusy = false,
  model,
  harness,
  agent,
  lazy = false,
  subscribeToRequests = true,
  triggerLabel,
  trigger = "composer",
  openRequest = 0,
  anchor,
}: WorkflowLauncherProps) {
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [preferences, setPreferences] = useState<WorkflowPreferencesDto>(EMPTY_PREFERENCES);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_WORKFLOWS);
  const [task, setTask] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const handledOpenRequest = useRef(openRequest);
  const preferencesRef = useRef<WorkflowPreferencesDto>(EMPTY_PREFERENCES);
  const preferenceWriteVersion = useRef(0);
  const preferenceQueue = useRef(Promise.resolve());
  const requestedInput = useRef<string | undefined>(undefined);
  const [activeSourceMessageSeq, setActiveSourceMessageSeq] = useState(sourceMessageSeq);
  const scopeVersion = useRef(0);
  const loadedScope = useRef("");
  const launchRef = useRef<{
    id: string;
    input: string;
    attachments: AttachmentRef[];
    workflowId: string;
    parentSessionId: string;
    sourceSessionId?: string;
    projectId: string;
    spaceId?: string;
    model?: ModelRef;
    harness?: HarnessSelection;
    agent?: string;
    context: "recent" | "request";
    sourceMessageSeq?: number;
  } | null>(null);
  const retryRef = useRef<typeof launchRef.current>(null);
  const attachments = workflowAttachments;
  const loadEnabled = !lazy || open;

  useEffect(() => {
    scopeVersion.current += 1;
    loadedScope.current = "";
    preferenceWriteVersion.current += 1;
    setWorkflows([]);
    setPreferences(EMPTY_PREFERENCES);
    preferencesRef.current = EMPTY_PREFERENCES;
    setSelectedId(undefined);
    setVisibleCount(INITIAL_VISIBLE_WORKFLOWS);
    setLoadFailed(false);
    setError("");
    setLoadAttempt(0);
    setOpen(false);
    setTask("");
    setBusyId("");
    launchRef.current = null;
    retryRef.current = null;
  }, [projectId, spaceId]);

  useEffect(() => {
    retryRef.current = null;
    setOpen(false);
    setVisibleCount(INITIAL_VISIBLE_WORKFLOWS);
    setActiveSourceMessageSeq(sourceMessageSeq);
    setBusyId("");
    launchRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (!subscribeToRequests) return;
    const handleRequest = (event: Event) => {
      const request = (event as CustomEvent<WorkflowLaunchRequest>).detail;
      if (request?.spaceId && request.spaceId !== spaceId) return;
      if (request?.projectId && request.projectId !== projectId) return;
      if (request?.sessionId && request.sessionId !== sessionId) return;
      if (!projectId) return;
      if (request?.input !== undefined) {
        requestedInput.current = request.input;
        if (open) setTask(request.input);
      }
      setActiveSourceMessageSeq(request?.sourceMessageSeq ?? sourceMessageSeq);
      setVisibleCount(INITIAL_VISIBLE_WORKFLOWS);
      if (loadFailed) setLoadAttempt((attempt) => attempt + 1);
      setOpen(true);
    };
    window.addEventListener(WORKFLOW_LAUNCH_REQUEST, handleRequest);
    return () => window.removeEventListener(WORKFLOW_LAUNCH_REQUEST, handleRequest);
  }, [loadFailed, open, projectId, sessionId, spaceId, sourceMessageSeq, subscribeToRequests]);

  useEffect(() => {
    if (!open) return;
    setTask(requestedInput.current ?? draftText);
    requestedInput.current = undefined;
  }, [open]);

  useEffect(() => {
    // Workflows and preferences are project-scoped, so a chat switch must not
    // refetch them; only the project/Space boundary or an explicit retry does.
    const scope = JSON.stringify([spaceId, projectId, loadAttempt]);
    if (!projectId || !loadEnabled || loadedScope.current === scope) return;
    const version = scopeVersion.current;
    loadedScope.current = scope;
    let active = true;
    let settled = false;
    setLoading(true);
    setLoadFailed(false);
    setError("");
    void Promise.all([
      api.listWorkflows(projectId),
      api.getWorkflowPreferences(projectId).catch(() => EMPTY_PREFERENCES),
    ]).then(([items, pref]) => {
      settled = true;
      if (!active || version !== scopeVersion.current) return;
      const nextPreferences: WorkflowPreferencesDto = {
        pinnedIds: pref.pinnedIds ?? [],
        recentIds: pref.recentIds ?? [],
        ...(pref.selectedId ? { selectedId: pref.selectedId } : {}),
        ...(pref.category ? { category: pref.category } : {}),
      };
      setWorkflows(items);
      preferencesRef.current = nextPreferences;
      setPreferences(nextPreferences);
      setSelectedId(items.some((item) => item.id === nextPreferences.selectedId)
        ? nextPreferences.selectedId
        : items[0]?.id);
      loadedScope.current = scope;
    }).catch((cause) => {
      settled = true;
      if (!active || version !== scopeVersion.current) return;
      // A failure is not a loaded scope: opening the launcher again, Retry or
      // a restored connection asks once more instead of keeping it forever.
      loadedScope.current = "";
      setWorkflows([]);
      setLoadFailed(true);
      setError(friendlyError(tr("common.error"), cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      // An interrupted request (a lazy launcher closed while loading) never
      // delivered this scope; the next run must ask again, not keep "Loading".
      if (!settled && loadedScope.current === scope) loadedScope.current = "";
    };
  }, [loadEnabled, projectId, spaceId, loadAttempt]);

  // A list that failed for lack of a connection loads again by itself once the
  // shell's connection is back (a phone returning from the background).
  useEffect(() => loadFailed
    ? onConnectionRestored(() => setLoadAttempt((attempt) => attempt + 1))
    : undefined, [loadFailed]);

  const persistPreferences = (patch: Partial<WorkflowPreferencesDto>) => {
    if (!projectId) return;
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    setPreferences(next);
    setSelectedId(next.selectedId);
    const version = scopeVersion.current;
    const scopedProjectId = projectId;
    const scopedSpaceId = spaceId;
    const writeVersion = ++preferenceWriteVersion.current;
    preferenceQueue.current = preferenceQueue.current.then(async () => {
      if (version !== scopeVersion.current) return;
      const saved = await api.updateWorkflowPreferences(scopedProjectId, patch);
      if (saved && writeVersion === preferenceWriteVersion.current
        && version === scopeVersion.current
        && scopedProjectId === projectId
        && scopedSpaceId === spaceId) {
        preferencesRef.current = saved;
        setPreferences(saved);
      }
    }).catch(() => { /* local ordering remains usable until the next refresh */ });
  };

  const openLauncher = () => {
    if (!projectId) return;
    setTask(draftText);
    setActiveSourceMessageSeq(sourceMessageSeq);
    setVisibleCount(INITIAL_VISIBLE_WORKFLOWS);
    setError("");
    // An earlier failed load (often at app start or right after a resume) is
    // retried when someone opens the launcher, not shown to them as is.
    if (loadFailed) setLoadAttempt((attempt) => attempt + 1);
    setOpen(true);
  };

  useEffect(() => {
    if (openRequest <= handledOpenRequest.current) return;
    handledOpenRequest.current = openRequest;
    anchorRef.current = anchor?.() ?? null;
    openLauncher();
  // openLauncher reads the current props; only a new request opens it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  const openBuilder = (workflowId?: string) => {
    if (!projectId || busyId) return;
    handOffWorkflowLaunch({
      projectId,
      ...(sessionId ? { sessionId } : {}),
       input: task,
       ...(workflowId ? { workflowId } : {}),
       ...(model ? { model } : {}),
       ...(harness ? { harness } : {}),
       ...(agent ? { agent } : {}),
    });
    setOpen(false);
    openWorkspacePane("workflow");
  };

  const rememberWorkflow = (workflowId: string) => persistPreferences({
    selectedId: workflowId,
    recentIds: [workflowId, ...preferencesRef.current.recentIds.filter((id) => id !== workflowId)].slice(0, 12),
  });

  /** A launch from the unsent new chat does not wait for admission on the new
   * chat screen: its parent session and the workflow window open at once and
   * show the start in progress, while the request completes in the background. */
  const startInNewParent = async (
    workflow: WorkflowDto,
    launch: NonNullable<typeof launchRef.current>,
    enteredTask: string,
    request: () => Promise<WorkflowRunDto>,
    version: number,
  ) => {
    const parentSessionId = launch.parentSessionId;
    const started = beginWorkflowStart(
      { parentSessionId, projectId: launch.projectId, workflowId: workflow.id, input: enteredTask },
      request,
      (cause) => friendlyError(tr("workflowlauncher.couldNotStart"), cause),
    );
    // From here a retry belongs to the workflow window, which resends this
    // exact request and operation id.
    retryRef.current = null;
    void started.then(
      () => { if (version === scopeVersion.current) rememberWorkflow(workflow.id); },
      (cause) => {
        // The workflow window shows the failure with Retry. Anywhere else it
        // must still be reported rather than lost.
        const state = getState();
        if (state.activeSessionId !== parentSessionId || state.railPlugin !== "workflow") {
          setUiError(friendlyError(tr("workflowlauncher.couldNotStart"), cause));
        }
      },
    );
    // The task moves with the launch into the workflow window, which keeps it
    // for a retry; the new chat is left clean. This runs while the new chat's
    // composer still owns the draft.
    consumeDraft?.(enteredTask);
    setOpen(false);
    await openSession(parentSessionId).catch((cause) => {
      setUiError(friendlyError(tr("workflowlauncher.couldNotStart"), cause));
    });
    if (getState().activeSessionId !== parentSessionId) return;
    handOffWorkflowLaunch({
      projectId: launch.projectId,
      sessionId: parentSessionId,
      input: enteredTask,
      workflowId: workflow.id,
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.harness ? { harness: launch.harness } : {}),
      ...(launch.agent ? { agent: launch.agent } : {}),
    });
    openWorkspacePane("workflow");
  };

  const run = async (workflow: WorkflowDto) => {
    const enteredTask = !open && activeSourceMessageSeq === undefined ? draftText : task;
    const context: "recent" | "request" = activeSourceMessageSeq === undefined ? "recent" : "request";
    if (!projectId || workflowBusy || busyId || launchRef.current || !enteredTask.trim()) return;
    const previous = retryRef.current;
    const sameRetry = previous
      && previous.input === enteredTask
      && previous.workflowId === workflow.id
      && previous.projectId === projectId
      && previous.spaceId === spaceId
      && previous.sourceSessionId === sessionId
      && previous.context === context
      && previous.sourceMessageSeq === activeSourceMessageSeq
      && JSON.stringify(previous.attachments) === JSON.stringify(attachments)
      && JSON.stringify(previous.model) === JSON.stringify(model)
      && JSON.stringify(previous.harness) === JSON.stringify(harness)
      && previous.agent === agent;
    const launch = sameRetry
      ? previous
      : {
          id: operationId(),
          input: enteredTask,
          attachments: [...attachments],
          workflowId: workflow.id,
          parentSessionId: sessionId ?? "",
          sourceSessionId: sessionId,
          projectId,
          ...(spaceId ? { spaceId } : {}),
          ...(model ? { model } : {}),
          ...(harness ? { harness } : {}),
          ...(agent ? { agent } : {}),
          context,
          ...(activeSourceMessageSeq === undefined ? {} : { sourceMessageSeq: activeSourceMessageSeq }),
        };
    launchRef.current = launch;
    setBusyId(workflow.id);
    setError("");
    const version = scopeVersion.current;
    try {
      if (!launch.parentSessionId) {
        const parent = await api.createSession({
          projectId,
          // The parent runs no turn of its own: the server names it from the
          // task once the run is admitted (Custom Titles, else the prompt).
          // Only a task-less launch falls back to the workflow's name.
          ...(enteredTask.trim() ? {} : { title: workflowDisplayName(workflow) }),
          purpose: "workflow",
          ...(model ? { model } : {}),
          ...(harness ? { harness } : {}),
          ...(agent ? { agent } : {}),
        });
        launch.parentSessionId = parent.id;
      }
      if (!launch.parentSessionId) throw new Error(tr("workflowlauncher.parentCouldNotBeCreated"));
      const parentSessionId = launch.parentSessionId;
      const request = () => api.runWorkflow(workflow.id, parentSessionId, enteredTask, undefined, {
        clientOperationId: launch.id,
        ...(launch.attachments.length ? { attachments: launch.attachments } : {}),
        context: launch.context,
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.harness ? { harness: launch.harness } : {}),
        ...(launch.agent ? { agent: launch.agent } : {}),
        ...(launch.sourceMessageSeq === undefined ? {} : { sourceMessageSeq: launch.sourceMessageSeq }),
      });
      const here = getState();
      // Someone who left the new chat while its parent was being created keeps
      // their place: the start is awaited here and a lost response stays
      // retryable from this launcher with the same operation id.
      if (!sessionId && version === scopeVersion.current
        && here.activeProjectId === projectId && here.activeSessionId === null) {
        await startInNewParent(workflow, launch, enteredTask, request, version);
        return;
      }
      const started = await request();
      // Clear only after the server has admitted this exact operation. The
      // composer callback also checks its project/session and current text,
      // so a newer draft typed while this request was pending is preserved.
      const current = getState();
      const currentSpace = current.projectRegistry.projects.find((item) => item.id === projectId)?.spaceId ?? "default";
      const sameScope = version === scopeVersion.current
        && current.activeProjectId === projectId
        && currentSpace === (spaceId ?? "default")
        && current.activeSessionId === (sessionId ?? null);
      if (sameScope) {
        consumeDraft?.(enteredTask);
        publishWorkflowRun(started);
        rememberWorkflow(workflow.id);
      }
      retryRef.current = null;
      if (version === scopeVersion.current) setOpen(false);
    } catch (cause) {
      // The draft was never consumed before admission. Keep it available for
      // retry, including when the response was lost after server acceptance.
      retryRef.current = version === scopeVersion.current ? launch : null;
      if (version === scopeVersion.current) setError(friendlyError(tr("workflowlauncher.couldNotStart"), cause));
    } finally {
      if (launchRef.current === launch) launchRef.current = null;
      if (version === scopeVersion.current) setBusyId("");
    }
  };

  const sorted = orderWorkflows(workflows, { ...preferences, selectedId });
  const visibleWorkflows = sorted.slice(0, visibleCount);
  const canRun = (open ? task : draftText).trim().length > 0;

  return (
    <>
      {trigger === "message" ? (
        <ChatActionButton
          ref={triggerRef}
          icon={WorkflowIcon}
          disabled={!projectId || workflowBusy}
          pressed={open}
          onClick={openLauncher}
          label={triggerLabel ?? tr("workflowview.runWorkflow")}
          aria-haspopup="dialog"
          aria-expanded={open}
        />
      ) : trigger === "composer" ? (
        <span className="workflow-launch-actions">
          <IconButton
            ref={triggerRef}
            className={`header-action composer-workflow${open ? " on" : ""}`}
            icon={WorkflowIcon}
            size="md"
            variant="ghost"
            disabled={!projectId || workflowBusy}
            pressed={open}
            onClick={openLauncher}
            title={!projectId ? tr("workflowlauncher.openProject") : tr("workflowlauncher.chooseWorkflowRun")}
            label={triggerLabel ?? tr("workflowview.runWorkflow")}
            aria-haspopup="dialog"
            aria-expanded={open}
          />
        </span>
      ) : null}
      <ResponsiveOverlay
        open={open}
        onClose={() => { if (!busyId) setOpen(false); }}
        title={tr("workflowlauncher.title")}
        anchorRef={trigger === "none" ? anchorRef : triggerRef}
        desktop="popover"
        phone="popover"
        align="end"
        side="up"
        className="workflow-launch-overlay"
        {...(trigger === "none" ? {} : { restoreFocusRef: triggerRef })}
        popoverOverflow="auto"
      >
        <div className="workflow-launch-panel">
          {error && !loadFailed && <div className="form-error workflow-error" role="alert">{error}</div>}
          {loading ? <div className="workflow-launch-empty" role="status">{tr("workflowlauncher.loading")}</div> : loadFailed ? (
            <div className="workflow-launch-empty workflow-launch-failed"><strong role="alert">{tr("workflowlauncher.couldNotLoad")}</strong><span>{error}</span><Button size="sm" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{tr("common.retry")}</Button></div>
          ) : sorted.length > 0 ? (
            <>
            <div className="workflow-launch-list" aria-label={tr("workflowlauncher.savedWorkflows")}>
              {visibleWorkflows.map((workflow) => {
                const isSelected = workflow.id === selectedId;
                const pinned = preferences.pinnedIds.includes(workflow.id);
                const name = workflowDisplayName(workflow);
                const description = workflowDisplayDescription(workflow);
                return <div key={workflow.id} className={`workflow-launch-row${isSelected ? " selected" : ""}`}>
                  <button
                    type="button"
                    className="workflow-launch-select"
                    aria-pressed={isSelected}
                    onClick={() => { setSelectedId(workflow.id); persistPreferences({ selectedId: workflow.id }); }}
                  >
                    <span className="workflow-definition-icon" aria-hidden="true"><WorkflowIcon /></span>
                    <span className="workflow-launch-copy"><strong>{name}</strong>{description && <small>{description}</small>}<small className="workflow-launch-meta">{workflowTopology(workflow)} · {tr(workflow.defaults?.permissions === "auto" ? "workflowlauncher.autoApprove" : "workflowlauncher.manualApproval")}</small></span>
                  </button>
                  <Button size="sm" variant="ghost" aria-pressed={pinned} aria-label={tr(pinned ? "workflowlauncher.unpinValue" : "workflowlauncher.pinValue", { name: workflowDisplayName(workflow) })} onClick={() => { persistPreferences({ pinnedIds: pinned ? preferences.pinnedIds.filter((id) => id !== workflow.id) : [workflow.id, ...preferences.pinnedIds] }); }}>{pinned ? "★" : "☆"}</Button>
                  <Button size="sm" variant="primary" disabled={!canRun || !!busyId} busy={busyId === workflow.id} aria-label={tr("workflowlauncher.runValue", { name: workflowDisplayName(workflow) })} onClick={() => { void run(workflow); }}>{tr("workflowlauncher.run")}</Button>
                </div>;
              })}
            </div>
            {sorted.length > visibleCount && <Button className="workflow-launch-more" size="sm" variant="ghost" aria-label={tr("common.more")} onClick={() => setVisibleCount((count) => count + MORE_WORKFLOWS)}>{tr("common.more")} <span aria-hidden="true">+{Math.min(MORE_WORKFLOWS, sorted.length - visibleCount)}</span></Button>}
            </>
          ) : <div className="workflow-launch-empty"><strong>{tr("workflowlauncher.noWorkflows")}</strong><span>{tr("workflowlauncher.buildReusablePipeline")}</span><Button size="sm" iconStart={AddIcon} disabled={!!busyId} onClick={() => openBuilder()}>{tr("workflowlauncher.createWorkflow")}</Button></div>}
          <footer className="workflow-launch-footer">{(loading || loadFailed || sorted.length > 0) && <Button size="sm" iconStart={AddIcon} disabled={!!busyId} onClick={() => openBuilder(selectedId)}>{tr("workflowlauncher.openBuilder")}</Button>}<span aria-live="polite">{busyId ? tr("workflowlauncher.startingWorkflow") : ""}</span></footer>
        </div>
      </ResponsiveOverlay>
    </>
  );
}
