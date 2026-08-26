import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelRef,
  WorkflowDto,
  WorkflowNodeDto,
  WorkflowNodeStatus,
  WorkflowPermissionPolicy,
  WorkflowPipeMode,
  WorkflowRunDto,
  WorkflowRunStatus,
} from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { modelDisplayName, modelSupportsTextWorkflow } from "../../../apps/web/src/composer/discovery.ts";
import { openSession } from "../../../apps/web/src/init.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { showSessionChat, useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { layerizeWorkflow, wouldWorkflowCycle } from "./workflowGraph.ts";
import { takeWorkflowLaunch, type WorkflowLaunchIntent } from "./workflowLaunch.ts";
import { publishWorkflowRun } from "./workflowMonitor.ts";
import {
  fresherWorkflowRun,
  workflowFinishedCount,
  workflowHumanWait,
  workflowHumanWaitLabel,
  workflowNodeCount,
  workflowStatusLabel,
} from "./workflowRun.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { useDismissibleMenu } from "../../../apps/web/src/components/a11y/Menu.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import WorkflowButtonContent from "./WorkflowButtonContent.tsx";

const uid = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `workflow-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const modelValue = (model?: ModelRef): string =>
  model ? JSON.stringify(model) : "";

const parseModel = (value: string): ModelRef | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ModelRef;
    return typeof parsed.providerID === "string" && typeof parsed.modelID === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

const cloneWorkflow = (workflow: WorkflowDto): WorkflowDto =>
  structuredClone(workflow);

const positiveWholeNumber = (value: string, maximum?: number): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return null;
  if (maximum !== undefined && parsed > maximum) return null;
  return parsed;
};

function StatusIcon({ status }: { status: WorkflowNodeStatus | WorkflowRunStatus }) {
  if (status === "done") return <Icon.check />;
  if (status === "error") return <Icon.close />;
  if (status === "stopped") return <Icon.stop />;
  if (status === "skipped") return <Icon.branch />;
  if (status === "running") return <span className="workflow-status-spinner" />;
  return <Icon.clock />;
}

function StatusBadge({ status }: { status: WorkflowNodeStatus | WorkflowRunStatus }) {
  const label = workflowStatusLabel(status);
  return (
    <span className={`workflow-status status-${status}`} aria-label={label}>
      <span aria-hidden="true"><StatusIcon status={status} /></span>
      {label}
    </span>
  );
}

export default function WorkflowView() {
  const shellMode = useShellMode();
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const models = useStore((state) => state.models).filter(modelSupportsTextWorkflow);
  const agents = useStore((state) => state.agents);
  const eventRun = useActiveModel().workflowRun;
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [projectRuns, setProjectRuns] = useState<WorkflowRunDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDto | null>(null);
  const [runInput, setRunInput] = useState("");
  const [pipe, setPipe] = useState<WorkflowPipeMode>("ancestors");
  const [permissions, setPermissions] = useState<WorkflowPermissionPolicy>("auto");
  const [maxParallel, setMaxParallel] = useState("4");
  const [nodeTimeoutSeconds, setNodeTimeoutSeconds] = useState("1800");
  const [liveRun, setLiveRun] = useState<WorkflowRunDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState("");
  const [openingSessionId, setOpeningSessionId] = useState("");
  const [error, setError] = useState("");
  const [layersExpanded, setLayersExpanded] = useState(false);
  const [dependencyEditorId, setDependencyEditorId] = useState("");
  const [dependencyQuery, setDependencyQuery] = useState("");
  const [dangerOpen, setDangerOpen] = useState(false);
  const loadSequence = useRef(0);
  const actionInFlight = useRef(false);
  const definitionListRef = useRef<HTMLDivElement>(null);
  const dangerMenuRef = useRef<HTMLDivElement>(null);
  const dangerTriggerRef = useRef<HTMLButtonElement>(null);
  const loadedSelection = useRef<string | null>(null);
  const loadedProject = useRef<string | null>(null);
  const launchIntent = useRef<WorkflowLaunchIntent | null>(null);
  const loadedRun = useRef<WorkflowRunDto | null>(null);
  const onDangerMenuKey = useDismissibleMenu({
    open: dangerOpen,
    menuRef: dangerMenuRef,
    triggerRef: dangerTriggerRef,
    onClose: () => setDangerOpen(false),
  });

  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!projectId) {
      setWorkflows([]);
      setProjectRuns([]);
      setSelectedId(null);
      setDraft(null);
      loadedSelection.current = null;
      loadedProject.current = null;
      launchIntent.current = null;
      loadedRun.current = null;
      setLoading(false);
      setLoadFailed(false);
      return;
    }
    if (loadedProject.current !== projectId) {
      loadedProject.current = projectId;
      setWorkflows([]);
      setProjectRuns([]);
      setSelectedId(null);
      setDraft(null);
      loadedSelection.current = null;
      launchIntent.current = null;
      loadedRun.current = null;
    }
    setLoading(true);
    setLoadFailed(false);
    setError("");
    try {
      const [next, projectRuns] = await Promise.all([
        api.listWorkflows(projectId),
        api.listWorkflowRuns(projectId),
      ]);
      if (sequence !== loadSequence.current) return;
      const launch = takeWorkflowLaunch(projectId);
      const run = launch?.run
        ?? projectRuns.find((candidate) => candidate.status === "running")
        ?? projectRuns[0]
        ?? null;
      launchIntent.current = launch;
      loadedRun.current = run;
      setWorkflows(next);
      setProjectRuns(projectRuns);
      setSelectedId((current) =>
        launch?.workflowId && next.some((workflow) => workflow.id === launch.workflowId)
          ? launch.workflowId
          : run && next.some((workflow) => workflow.id === run.workflowId)
            ? run.workflowId
            : current && next.some((workflow) => workflow.id === current)
          ? current
          : next[0]?.id ?? null);
      setError("");
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setLoadFailed(true);
      setError(tr("workflowview.couldNotLoadWorkflowsValue", {
        value: cause instanceof Error ? cause.message : String(cause),
      }));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const selected = workflows.find((workflow) => workflow.id === selectedId);
    if ((selected?.id ?? null) === loadedSelection.current) return;
    loadedSelection.current = selected?.id ?? null;
    setDraft(selected ? cloneWorkflow(selected) : null);
    setLayersExpanded(false);
    setDependencyEditorId("");
    setDependencyQuery("");
    setDangerOpen(false);
    setPipe(selected?.defaults?.pipe ?? "ancestors");
    setPermissions(selected?.defaults?.permissions ?? "auto");
    setMaxParallel(String(selected?.defaults?.maxParallel ?? 4));
    setNodeTimeoutSeconds(String(Math.max(1, Math.round((selected?.defaults?.nodeTimeoutMs ?? 1_800_000) / 1_000))));
    const launch = launchIntent.current?.workflowId === selected?.id || (!launchIntent.current?.workflowId && selected)
      ? launchIntent.current
      : null;
    const run = loadedRun.current?.workflowId === selected?.id
      ? loadedRun.current
      : projectRuns.find((candidate) => candidate.workflowId === selected?.id) ?? null;
    setRunInput(launch?.input ?? "");
    setLiveRun(launch?.run ?? run);
    launchIntent.current = null;
    loadedRun.current = null;
  }, [selectedId, workflows, projectRuns]);

  useEffect(() => {
    const selected = definitionListRef.current?.querySelector<HTMLElement>(".workflow-definition.active");
    if (selected && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [selectedId, workflows.length]);

  const layers = useMemo(
    () => draft ? layerizeWorkflow(draft) : null,
    [draft],
  );
  const eventRunForDraft = draft && eventRun?.workflowId === draft.id ? eventRun : null;
  const shownRun = fresherWorkflowRun(liveRun, eventRunForDraft);
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedId) ?? null;
  const parallelValue = positiveWholeNumber(maxParallel, 32);
  const timeoutValue = positiveWholeNumber(nodeTimeoutSeconds);
  const nameError = draft && !draft.name.trim() ? tr("workflowview.enterWorkflowName") : "";
  const nodeErrors = useMemo(() => new Map(
    (draft?.nodes ?? []).map((node) => [node.id, {
      role: node.role.trim() ? "" : tr("workflowview.enterRole"),
      prompt: node.prompt.trim() ? "" : tr("workflowview.addInstructions"),
    }]),
  ), [draft?.nodes]);
  const definitionDirty = !!draft && !!selectedWorkflow && (
    draft.name !== selectedWorkflow.name
    || JSON.stringify(draft.nodes) !== JSON.stringify(selectedWorkflow.nodes)
    || JSON.stringify(draft.edges) !== JSON.stringify(selectedWorkflow.edges)
  );
  const optionsDirty = !!selectedWorkflow && (
    pipe !== (selectedWorkflow.defaults?.pipe ?? "ancestors")
    || permissions !== (selectedWorkflow.defaults?.permissions ?? "auto")
    || maxParallel !== String(selectedWorkflow.defaults?.maxParallel ?? 4)
    || nodeTimeoutSeconds !== String(Math.max(1, Math.round((selectedWorkflow.defaults?.nodeTimeoutMs ?? 1_800_000) / 1_000)))
  );
  const dirty = definitionDirty || optionsDirty;
  const nodesValid = [...nodeErrors.values()].every((entry) => !entry.role && !entry.prompt);
  const canSave = !!draft && !nameError && nodesValid && !!layers?.ok
    && parallelValue !== null && timeoutValue !== null;
  const isBusy = busy !== "" || openingSessionId !== "";
  const selectedIndex = workflows.findIndex((workflow) => workflow.id === selectedId);
  const layerPreviewLimit = shellMode === "phone" ? 2 : 6;
  const visibleLayers = layers?.ok && !layersExpanded && layers.layers.length > layerPreviewLimit
    ? layers.layers.slice(0, layerPreviewLimit)
    : layers?.ok ? layers.layers : [];

  useEffect(() => {
    if (!shownRun || shownRun.status !== "running") return;
    let active = true;
    const refresh = async () => {
      try {
        const next = await api.getWorkflowRun(shownRun.id);
        if (active) {
          setLiveRun(next);
          setProjectRuns((current) => current.some((candidate) => candidate.id === next.id)
            ? current.map((candidate) => candidate.id === next.id ? next : candidate)
            : [next, ...current]);
        }
      } catch {
        // The parent session event log remains the durable fallback.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 800);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [shownRun?.id, shownRun?.status]);

  if (!projectId) {
    return (
      <EmptyState
        title={tr("workflowview.noProjectSelected")}
        description={tr("workflowview.openAProjectToBuildAgentWorkflows")}
        mark={<Icon.workflow />}
      />
    );
  }

  const act = async (label: string, fn: () => Promise<void>) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(friendlyError(tr("workflowview.couldNotCompleteAction"), cause));
    } finally {
      actionInFlight.current = false;
      setBusy("");
    }
  };

  const confirmDiscard = async (message: string): Promise<boolean> =>
    !dirty || confirmAlert(message, {
      title: tr("workflowview.discardTitle"),
      confirmLabel: tr("common.discardChanges"),
    });

  const create = async () => {
    if (!await confirmDiscard(tr("workflowview.discardBeforeCreate"))) return;
    void act("create", async () => {
      const nodeId = uid();
      let number = workflows.length + 1;
      while (workflows.some((workflow) =>
        workflow.name === tr("workflowview.workflowValue", { number }))) number++;
      const created = await api.createWorkflow({
        projectId,
        name: tr("workflowview.workflowValue", { number }),
        nodes: [{
          id: nodeId,
          role: tr("workflowview.worker"),
          prompt: tr("workflowview.completeTheAssignedWorkflowTask"),
        }],
        edges: [],
        defaults: { pipe: "ancestors", permissions: "auto", maxParallel: 4, nodeTimeoutMs: 1_800_000 },
      });
      setWorkflows((current) => [created, ...current]);
      setSelectedId(created.id);
    });
  };

  const save = () => {
    if (!draft) return;
    void act("save", async () => {
      if (!canSave || parallelValue === null || timeoutValue === null) {
        throw new Error(tr("workflowview.fixFieldsBeforeSave"));
      }
      const updated = await api.updateWorkflow(draft.id, {
        name: draft.name.trim(),
        nodes: draft.nodes,
        edges: draft.edges,
        defaults: {
          ...draft.defaults,
          pipe,
          permissions,
          maxParallel: parallelValue,
          nodeTimeoutMs: timeoutValue * 1_000,
        },
      });
      setWorkflows((current) => current.map((workflow) => workflow.id === updated.id ? updated : workflow));
      setDraft(cloneWorkflow(updated));
    });
  };

  const remove = async () => {
    if (!draft || !await confirmAlert(
      tr("workflowview.deleteWorkflowValue", { name: draft.name }),
      {
        title: tr("workflowview.deleteWorkflow"),
        confirmLabel: tr("common.delete"),
      },
    )) return;
    void act("delete", async () => {
      await api.deleteWorkflow(draft.id);
      const index = workflows.findIndex((workflow) => workflow.id === draft.id);
      const remaining = workflows.filter((workflow) => workflow.id !== draft.id);
      setWorkflows((current) => current.filter((workflow) => workflow.id !== draft.id));
      setSelectedId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    });
  };

  const updateNode = (id: string, patch: Partial<WorkflowNodeDto>) => {
    setError("");
    setDraft((current) => current
      ? { ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }
      : current);
  };

  const addNode = () => {
    setError("");
    const id = uid();
    setDraft((current) => current
      ? {
          ...current,
          nodes: [...current.nodes, {
            id,
            role: tr("workflowview.agentValue", { number: current.nodes.length + 1 }),
            prompt: tr("workflowview.completeYourPart"),
          }],
        }
      : current);
  };

  const removeNode = (id: string) => {
    setError("");
    setDraft((current) => current
      ? {
          ...current,
          nodes: current.nodes.filter((node) => node.id !== id),
          edges: current.edges.filter((edge) => edge.source !== id && edge.target !== id),
        }
      : current);
  };

  const toggleDependency = (target: string, source: string, checked: boolean) => {
    setError("");
    setDraft((current) => {
      if (!current) return current;
      if (!checked) {
        return {
          ...current,
          edges: current.edges.filter((edge) => !(edge.source === source && edge.target === target)),
        };
      }
      if (wouldWorkflowCycle(current, source, target)) return current;
      return {
        ...current,
        edges: [...current.edges, { id: uid(), source, target }],
      };
    });
  };

  const run = (inputOverride?: string) => {
    if (!draft || !sessionId) return;
    void act("run", async () => {
      if (dirty) throw new Error(tr("workflowview.saveBeforeRun"));
      if (parallelValue === null || timeoutValue === null) {
        throw new Error(tr("workflowview.fixFieldsBeforeRun"));
      }
      const input = (inputOverride ?? runInput).trim();
      if (!input) throw new Error(tr("workflowview.taskRequired"));
      const started = await api.runWorkflow(draft.id, sessionId, input, {
        pipe,
        permissions,
        maxParallel: parallelValue,
        nodeTimeoutMs: timeoutValue * 1_000,
      });
      publishWorkflowRun(started);
      setRunInput(input);
      setLiveRun(started);
      setProjectRuns((current) => [started, ...current.filter((candidate) => candidate.id !== started.id)]);
    });
  };

  const retry = () => {
    if (!draft || !shownRun) return;
    const parentSessionId = shownRun.parentSessionId ?? sessionId;
    if (!parentSessionId) return;
    void act("retry", async () => {
      if (dirty) throw new Error(tr("workflowview.saveBeforeRetry"));
      const started = await api.runWorkflow(
        draft.id,
        parentSessionId,
        shownRun.input,
        shownRun.options ?? {
          pipe,
          permissions,
          maxParallel: parallelValue ?? 4,
          nodeTimeoutMs: (timeoutValue ?? 1_800) * 1_000,
        },
      );
      publishWorkflowRun(started);
      setRunInput(shownRun.input);
      setLiveRun(started);
      setProjectRuns((current) => [started, ...current.filter((candidate) => candidate.id !== started.id)]);
    });
  };

  const stop = () => {
    if (!shownRun) return;
    void act("stop", async () => {
      const stopped = await api.stopWorkflowRun(shownRun.id);
      publishWorkflowRun(stopped);
      setLiveRun(stopped);
      setProjectRuns((current) => current.map((candidate) => candidate.id === stopped.id ? stopped : candidate));
    });
  };

  const returnToChat = async () => {
    if (!await confirmDiscard(tr("workflowview.discardBeforeChat"))) return;
    showSessionChat();
  };

  const openLinkedSession = async (targetSessionId: string) => {
    if (isBusy) return;
    if (!await confirmDiscard(tr("workflowview.discardBeforeLinked"))) return;
    setOpeningSessionId(targetSessionId);
    setError("");
    try {
      await openSession(targetSessionId);
    } catch (cause) {
      setError(friendlyError(tr("workflowview.openSession"), cause));
      setOpeningSessionId("");
    }
  };

  const openParentChat = async () => {
    const parent = shownRun?.parentSessionId;
    if (parent && parent !== sessionId) {
      await openLinkedSession(parent);
      return;
    }
    await returnToChat();
  };

  const finishedNodes = shownRun ? workflowFinishedCount(shownRun) : 0;
  const selectWorkflow = async (id: string) => {
    if (id === selectedId) return;
    if (!await confirmDiscard(tr("workflowview.discardBeforeSwitch"))) return;
    setError("");
    setSelectedId(id);
  };

  return (
    <div className="view-page workflow-page" aria-busy={loading || isBusy}>
      <header className="workflow-page-header">
        <span className="workflow-page-icon" aria-hidden><Icon.workflow /></span>
        <div className="workflow-page-title">
          <h1 className="view-title">{tr("workflowview.workflows")}</h1>
          <p className="view-sub">{tr("capabilities.coordinateAgentRolesInDependencyBasedPipelines")}</p>
        </div>
        <button
          type="button"
          className="small-btn workflow-button workflow-back-chat"
          disabled={isBusy}
          onClick={() => void returnToChat()}
          aria-label={tr("workflowview.backToChat")}
        >
          <Icon.back /><span>{tr("workflowview.backToChat")}</span>
        </button>
      </header>

      {error && (
        <div className="form-error workflow-error" role="alert">
          <span>{error}</span>
          {loadFailed && (
            <button type="button" className="small-btn workflow-error-retry" onClick={() => void reload()}>
              {tr("common.retry")}
            </button>
          )}
        </div>
      )}

      <div className="workflow-layout">
        <aside className="sched-form workflow-sidebar" aria-label={tr("workflowview.definitions")}>
          <div className="workflow-section-heading">
            <div>
              <h2>{tr("workflowview.definitions")}</h2>
              <span>{tr("workflowview.savedCount", { count: workflows.length })}</span>
            </div>
            <button
              type="button"
              className="small-btn workflow-button"
              disabled={isBusy || loading}
              aria-busy={busy === "create"}
              onClick={() => void create()}
            >
              <WorkflowButtonContent
                busy={busy === "create"}
                idleLabel={tr("workflowview.new").replace(/^\+\s*/, "")}
                busyLabel={tr("workflowview.creating")}
                idleIcon={<Icon.plus />}
              />
            </button>
          </div>

          {loading && (
            <div className="workflow-list-skeleton" role="status" aria-label={tr("workflowview.loading")}>
              {[0, 1, 2].map((item) => (
                <span className="workflow-skeleton-row" key={item} aria-hidden>
                  <i /><b /><small />
                </span>
              ))}
            </div>
          )}
          {!loading && !loadFailed && workflows.length === 0 && (
            <div className="workflow-list-empty">
              <Icon.workflow />
              <strong>{tr("workflowview.noWorkflowsYet")}</strong>
              <span>{tr("workflowview.createOneHelp")}</span>
            </div>
          )}
          <div className="workflow-definition-carousel">
            <div ref={definitionListRef} className="workflow-definition-list">
              {workflows.map((workflow) => (
                <button
                  type="button"
                  key={workflow.id}
                  className={`workflow-definition${workflow.id === selectedId ? " active" : ""}`}
                  aria-pressed={workflow.id === selectedId}
                  disabled={isBusy}
                  onClick={() => void selectWorkflow(workflow.id)}
                >
                  <span className="workflow-definition-icon" aria-hidden><Icon.workflow /></span>
                  <span className="workflow-definition-copy">
                    <strong>{workflow.name}</strong>
                    <span>{workflowNodeCount(workflow.nodes.length)}</span>
                  </span>
                  <Icon.chevronRight />
                </button>
              ))}
            </div>
            {workflows.length > 1 && selectedIndex >= 0 && (
              <span className="workflow-definition-position" dir="ltr" aria-live="polite">
                {selectedIndex + 1} / {workflows.length}
              </span>
            )}
          </div>
        </aside>

        <main className="workflow-main">
          {loading && !draft && (
            <div className="workflow-builder-skeleton" role="status" aria-label={tr("workflowview.builderLoading")}>
              <span className="workflow-skeleton-toolbar" aria-hidden><i /><b /><b /></span>
              <span className="workflow-skeleton-plan" aria-hidden><i /><i /><i /><i /></span>
              <span className="workflow-skeleton-card" aria-hidden><b /><i /><i /><i /></span>
            </div>
          )}
          {!loading && !draft && (
            <EmptyState
              title={loadFailed ? tr("workflowview.couldNotLoad") : workflows.length ? tr("workflowview.chooseWorkflow") : tr("workflowview.buildFirst")}
              description={loadFailed
                ? tr("workflowview.loadHelp")
                : workflows.length
                  ? tr("workflowview.selectSavedHelp")
                  : tr("workflowview.createFirstHelp")}
              actionLabel={loadFailed ? tr("common.retry") : tr("workflowlauncher.createWorkflow")}
              onAction={loadFailed ? () => void reload() : () => void create()}
              mark={<Icon.workflow />}
            />
          )}

          {draft && (
            <>
              <section className="sched-form workflow-editor-header">
                <div className="workflow-editor-toolbar">
                  <label className="workflow-field workflow-name-field">
                    <span>{tr("workflowview.workflowName")}</span>
                    <input
                      value={draft.name}
                      disabled={isBusy}
                      aria-invalid={nameError ? true : undefined}
                      aria-describedby={nameError ? "workflow-name-error" : undefined}
                      onChange={(event) => {
                        setError("");
                        setDraft({ ...draft, name: event.target.value });
                      }}
                    />
                    {nameError && <small id="workflow-name-error" className="workflow-field-error">{nameError}</small>}
                  </label>
                  <div className="workflow-editor-actions">
                    <span className={`workflow-save-state${dirty ? " dirty" : ""}`} role="status">
                      {dirty ? tr("workflowview.unsaved") : tr("workflowview.saved")}
                    </span>
                    <button type="button" className="small-btn workflow-button" disabled={isBusy} onClick={addNode}>
                      <Icon.plus />{tr("workflowview.addNode")}
                    </button>
                    <div className="workflow-editor-overflow">
                      <button
                        ref={dangerTriggerRef}
                        type="button"
                        className="small-btn workflow-button workflow-overflow-trigger"
                        disabled={isBusy}
                        aria-label={tr("workflowview.dangerZone")}
                        aria-haspopup="menu"
                        aria-expanded={dangerOpen}
                        onClick={() => setDangerOpen((open) => !open)}
                      >
                        <Icon.more />
                      </button>
                      {dangerOpen && (
                        <div
                          ref={dangerMenuRef}
                          className="menu-popup workflow-editor-menu"
                          role="menu"
                          aria-label={tr("workflowview.dangerZone")}
                          onKeyDown={onDangerMenuKey}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            className="danger"
                            disabled={isBusy || shownRun?.status === "running"}
                            title={shownRun?.status === "running" ? tr("workflowview.deleteUnavailable") : tr("workflowview.deleteWorkflow")}
                            onClick={() => {
                              setDangerOpen(false);
                              void remove();
                            }}
                          >
                            {busy === "delete"
                              ? <span className="workflow-button-spinner" aria-hidden />
                              : <Icon.trash />}
                            <span>{busy === "delete" ? tr("workflowview.deleteBusy") : tr("workflowview.deleteWorkflow")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="primary-btn workflow-button"
                      disabled={isBusy || !canSave || !dirty}
                      title={!canSave ? tr("workflowview.fixFields") : !dirty ? tr("workflowview.noUnsavedChanges") : tr("workflowview.saveWorkflow")}
                      aria-busy={busy === "save"}
                      onClick={save}
                    >
                      <WorkflowButtonContent
                        busy={busy === "save"}
                        idleLabel={tr("common.save")}
                        busyLabel={tr("common.saving")}
                        idleIcon={<Icon.check />}
                      />
                    </button>
                  </div>
                </div>

                <div className="workflow-layers" aria-label={tr("workflowview.executionOrder")}>
                  <div className="workflow-layers-label">
                    <Icon.hierarchy />
                    <span>
                      <strong>{tr("workflowview.executionOrder")}</strong>
                      <small>{tr("workflowview.nodesInLayer")}</small>
                    </span>
                  </div>
                  <div className="workflow-layer-list">
                    {layers?.ok
                      ? visibleLayers.map((layer, index) => (
                          <span key={index} className="workflow-layer-chip">
                            <b>{tr("workflowview.layerValue", { number: index + 1 })}</b>
                            {layer.map((id) => draft.nodes.find((node) => node.id === id)?.role ?? id).join(" + ")}
                          </span>
                        ))
                      : <span className="form-error workflow-graph-error" role="alert">{layers?.error}</span>}
                    {layers?.ok && layers.layers.length > layerPreviewLimit && (
                      <button
                        type="button"
                        className="small-btn workflow-button workflow-layers-toggle"
                        aria-expanded={layersExpanded}
                        onClick={() => setLayersExpanded((expanded) => !expanded)}
                      >
                        {layersExpanded ? <Icon.chevronUp /> : <Icon.chevronDown />}
                        {layersExpanded
                          ? tr("workflowview.showFewerLayers")
                          : tr("workflowview.showAllLayersValue", { count: layers.layers.length })}
                      </button>
                    )}
                  </div>
                </div>
              </section>

              <section className="workflow-node-grid" aria-label={tr("workflowview.nodes")}>
                {draft.nodes.map((node, nodeIndex) => (
                  <article
                    key={node.id}
                    className="sched-form workflow-node-card"
                    aria-labelledby={`workflow-node-${nodeIndex}-title`}
                  >
                    <div className="workflow-node-heading">
                      <span className="workflow-node-index" aria-hidden>{nodeIndex + 1}</span>
                      <div>
                        <strong id={`workflow-node-${nodeIndex}-title`}>{node.role || tr("workflowview.untitledRole")}</strong>
                        <span>{tr("workflowview.agentNode")}</span>
                      </div>
                      <button
                        type="button"
                        className="small-btn icon-only danger-btn workflow-button workflow-node-delete"
                        disabled={isBusy || draft.nodes.length === 1}
                        onClick={() => removeNode(node.id)}
                        title={draft.nodes.length === 1
                          ? tr("workflowview.needsAtLeastOneNode")
                          : tr("workflowview.deleteNodeValue", { role: node.role || tr("workflowview.node").replace(/^\+\s*/, "") })}
                        aria-label={tr("workflowview.deleteNodeValue", { role: node.role || tr("workflowview.node").replace(/^\+\s*/, "") })}
                      >
                        <Icon.trash />
                      </button>
                    </div>

                    <label className="workflow-field">
                      <span>{tr("workflowview.role")}</span>
                      <input
                        value={node.role}
                        disabled={isBusy}
                        placeholder={tr("workflowview.worker")}
                        aria-invalid={nodeErrors.get(node.id)?.role ? true : undefined}
                        aria-describedby={nodeErrors.get(node.id)?.role ? `workflow-node-${nodeIndex}-role-error` : undefined}
                        onChange={(event) => updateNode(node.id, { role: event.target.value })}
                      />
                      {nodeErrors.get(node.id)?.role && (
                        <small id={`workflow-node-${nodeIndex}-role-error`} className="workflow-field-error">
                          {nodeErrors.get(node.id)?.role}
                        </small>
                      )}
                    </label>
                    <label className="workflow-field">
                      <span>{tr("workflowview.instructions")}</span>
                      <textarea
                        rows={5}
                        value={node.prompt}
                        disabled={isBusy}
                        placeholder={tr("workflowview.instructionsForThisRole")}
                        aria-invalid={nodeErrors.get(node.id)?.prompt ? true : undefined}
                        aria-describedby={nodeErrors.get(node.id)?.prompt ? `workflow-node-${nodeIndex}-prompt-error` : undefined}
                        onChange={(event) => updateNode(node.id, { prompt: event.target.value })}
                      />
                      {nodeErrors.get(node.id)?.prompt && (
                        <small id={`workflow-node-${nodeIndex}-prompt-error`} className="workflow-field-error">
                          {nodeErrors.get(node.id)?.prompt}
                        </small>
                      )}
                    </label>
                    <div className="workflow-node-selects">
                      <label className="workflow-field">
                        <span>{tr("workflowview.model")}</span>
                        <select
                          value={modelValue(node.model)}
                          disabled={isBusy}
                          onChange={(event) => updateNode(node.id, { model: parseModel(event.target.value) })}
                        >
                          <option value="">{tr("workflowview.defaultModel")}</option>
                          {models.map((model) => (
                            <option
                              key={`${model.providerID}/${model.modelID}`}
                              value={JSON.stringify({ providerID: model.providerID, modelID: model.modelID })}
                            >
                              {modelDisplayName(model, models)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="workflow-field">
                        <span>{tr("workflowview.agent")}</span>
                        <select
                          value={node.agent ?? ""}
                          disabled={isBusy}
                          onChange={(event) => updateNode(node.id, { agent: event.target.value || undefined })}
                        >
                          <option value="">{tr("workflowview.defaultAgent")}</option>
                          {agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
                        </select>
                      </label>
                    </div>

                    {draft.nodes.length > 1 && (() => {
                      const selectedSources = draft.nodes.filter((source) =>
                        draft.edges.some((edge) => edge.source === source.id && edge.target === node.id));
                      const dependencyEditorOpen = dependencyEditorId === node.id;
                      const query = dependencyQuery.trim().toLocaleLowerCase();
                      const candidates = dependencyEditorOpen
                        ? draft.nodes.filter((source) =>
                            source.id !== node.id
                            && (!query || (source.role || tr("workflowview.untitledRole")).toLocaleLowerCase().includes(query)))
                        : [];
                      return (
                        <fieldset className="workflow-dependencies">
                          <legend>{tr("workflowview.dependsOn")}</legend>
                          <div className="workflow-dependency-summary">
                            <span>
                              {selectedSources.length === 0
                                ? tr("workflowview.noDependencies")
                                : tr(selectedSources.length === 1
                                    ? "workflowview.dependencyCountOne"
                                    : "workflowview.dependencyCountOther", { count: selectedSources.length })}
                            </span>
                            <button
                              type="button"
                              className="small-btn workflow-button workflow-dependency-edit"
                              disabled={isBusy}
                              aria-expanded={dependencyEditorOpen}
                              aria-controls={`workflow-dependencies-${node.id}`}
                              aria-label={tr("workflowview.editDependenciesValue", {
                                role: node.role || tr("workflowview.untitledRole"),
                              })}
                              onClick={() => {
                                setDependencyEditorId(dependencyEditorOpen ? "" : node.id);
                                setDependencyQuery("");
                              }}
                            >
                              <Icon.branch />
                              {dependencyEditorOpen
                                ? tr("workflowview.closeDependencies")
                                : tr("workflowview.editDependencies")}
                            </button>
                          </div>
                          {selectedSources.length > 0 && (
                            <div className="workflow-dependency-selected" aria-label={tr("workflowview.selectedDependencies")}>
                              {selectedSources.map((source) => (
                                <span key={source.id}>{source.role || tr("workflowview.untitledRole")}</span>
                              ))}
                            </div>
                          )}
                          {dependencyEditorOpen && (
                            <div id={`workflow-dependencies-${node.id}`} className="workflow-dependency-editor">
                              <label className="workflow-dependency-search">
                                <span>{tr("workflowview.searchNodes")}</span>
                                <input
                                  type="search"
                                  value={dependencyQuery}
                                  disabled={isBusy}
                                  placeholder={tr("workflowview.searchNodesPlaceholder")}
                                  onChange={(event) => setDependencyQuery(event.target.value)}
                                />
                              </label>
                              <p>{tr("workflowview.selectDependencies")}</p>
                              <div className="workflow-dependency-list">
                                {candidates.map((source) => {
                                  const checked = draft.edges.some((edge) => edge.source === source.id && edge.target === node.id);
                                  const cycle = !checked && wouldWorkflowCycle(draft, source.id, node.id);
                                  return (
                                    <label
                                      key={source.id}
                                      className={`workflow-dependency${checked ? " checked" : ""}${cycle ? " disabled" : ""}`}
                                      title={cycle ? tr("workflowview.thisDependencyWouldCreateACycle") : ""}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={isBusy || cycle}
                                        aria-label={`${tr("workflowview.dependsOn")} ${source.role || tr("workflowview.untitledRole")}${cycle ? `; ${tr("workflowview.thisDependencyWouldCreateACycle")}` : ""}`}
                                        onChange={(event) => toggleDependency(node.id, source.id, event.target.checked)}
                                      />
                                      <span aria-hidden><Icon.check /></span>
                                      {source.role || tr("workflowview.untitledRole")}
                                    </label>
                                  );
                                })}
                                {candidates.length === 0 && (
                                  <span className="workflow-dependency-empty">{tr("workflowview.noMatchingNodes")}</span>
                                )}
                              </div>
                            </div>
                          )}
                        </fieldset>
                      );
                    })()}
                  </article>
                ))}
              </section>

              <section className="sched-form workflow-run-form">
                <div className="workflow-section-heading">
                  <div>
                    <h2>{tr("workflowview.runWorkflow")}</h2>
                    <span>{tr("workflowview.giveSharedObjective")}</span>
                  </div>
                  {shownRun && <StatusBadge status={shownRun.status} />}
                </div>
                <label className="workflow-field">
                  <span>{tr("workflowview.task")}</span>
                  <textarea
                    rows={3}
                    value={runInput}
                    disabled={isBusy}
                    placeholder={tr("workflowview.describeTheTaskForThisWorkflow")}
                    onChange={(event) => { setError(""); setRunInput(event.target.value); }}
                  />
                </label>
                <div className="workflow-run-options">
                  <label className="workflow-field">
                    <span>{tr("workflowview.context")}</span>
                    <select disabled={isBusy} value={pipe} onChange={(event) => { setError(""); setPipe(event.target.value as WorkflowPipeMode); }}>
                      <option value="ancestors">{tr("workflowview.allAncestors")}</option>
                      <option value="direct">{tr("workflowview.directDependencies")}</option>
                    </select>
                  </label>
                  <label className="workflow-field">
                    <span>{tr("workflowview.permissions")}</span>
                    <select disabled={isBusy} value={permissions} onChange={(event) => { setError(""); setPermissions(event.target.value as WorkflowPermissionPolicy); }}>
                      <option value="auto">{tr("workflowview.autoApprove")}</option>
                      <option value="manual">{tr("workflowview.manualReview")}</option>
                    </select>
                    <small className="workflow-option-help">
                      {permissions === "manual"
                        ? tr("workflowview.manualPermissionHelp")
                        : tr("workflowview.autoPermissionHelp")}
                    </small>
                  </label>
                  <label className="workflow-field">
                    <span>{tr("workflowview.parallel")}</span>
                    <input
                      type="number"
                      min={1}
                      max={32}
                      step={1}
                      value={maxParallel}
                      disabled={isBusy}
                      inputMode="numeric"
                      aria-invalid={parallelValue === null}
                      aria-describedby={parallelValue === null ? "workflow-parallel-error" : undefined}
                      onChange={(event) => { setError(""); setMaxParallel(event.target.value); }}
                    />
                    {parallelValue === null && (
                      <small id="workflow-parallel-error" className="workflow-field-error">{tr("workflowview.enterParallel")}</small>
                    )}
                  </label>
                  <label className="workflow-field">
                    <span>{tr("workflowview.timeoutSec")}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={nodeTimeoutSeconds}
                      disabled={isBusy}
                      inputMode="numeric"
                      aria-invalid={timeoutValue === null}
                      aria-describedby={timeoutValue === null ? "workflow-timeout-error" : undefined}
                      onChange={(event) => { setError(""); setNodeTimeoutSeconds(event.target.value); }}
                    />
                    {timeoutValue === null && (
                      <small id="workflow-timeout-error" className="workflow-field-error">{tr("workflowview.enterPositive")}</small>
                    )}
                    {timeoutValue !== null && (
                      <small className="workflow-option-help">{tr("workflowview.timeoutHelp")}</small>
                    )}
                  </label>
                </div>
                <div className="workflow-run-footer">
                  <span className="muted">
                    {dirty
                      ? tr("workflowview.saveBeforeRun")
                      : !sessionId
                        ? tr("workflowview.openASessionToUseAsThe")
                        : !runInput.trim()
                          ? tr("workflowview.taskToEnable")
                          : tr("workflowview.progressSaved")}
                  </span>
                  <div className="workflow-run-actions">
                    {shownRun?.status === "running" && (
                      <button
                        type="button"
                        className="small-btn danger-btn workflow-button"
                        disabled={isBusy}
                        aria-busy={busy === "stop"}
                        aria-label={tr("workflowview.stopRunValue", { name: shownRun.name })}
                        onClick={stop}
                      >
                        <WorkflowButtonContent
                          busy={busy === "stop"}
                          idleLabel={tr("workflowview.stopRun")}
                          busyLabel={tr("workflowview.stopping")}
                          idleIcon={<Icon.stop />}
                        />
                      </button>
                    )}
                    <button
                      type="button"
                      className="primary-btn workflow-button"
                      disabled={!sessionId || !runInput.trim() || dirty || parallelValue === null
                        || timeoutValue === null || shownRun?.status === "running" || isBusy}
                      aria-busy={busy === "run"}
                      title={!sessionId
                        ? tr("workflowview.openAParentSessionBeforeRunningA")
                        : dirty
                          ? tr("workflowview.saveBeforeRunning")
                          : !runInput.trim()
                            ? tr("workflowview.taskRequired")
                            : parallelValue === null || timeoutValue === null
                              ? tr("workflowview.fixFieldsBeforeRun")
                              : shownRun?.status === "running"
                                ? tr("workflowview.runAlreadyActive")
                                : tr("workflowview.runHelp")}
                      onClick={() => run()}
                    >
                      <WorkflowButtonContent
                        busy={busy === "run"}
                        idleLabel={tr("workflowview.runWorkflow")}
                        busyLabel={tr("workflowview.starting")}
                        idleIcon={<Icon.workflow />}
                      />
                    </button>
                  </div>
                </div>
              </section>

              {shownRun && (
                <section className="workflow-run-results">
                  <div className="workflow-run-heading" aria-live="polite">
                    <div>
                      <span className="stat-label">{tr("workflowview.latestRun")}</span>
                      <h2>{shownRun.name}</h2>
                    </div>
                    <StatusBadge status={shownRun.status} />
                    <span className="workflow-run-count">
                      {tr("workflowtimeline.nodesFinished", { complete: finishedNodes, total: shownRun.nodes.length })}
                    </span>
                  </div>
                  {shownRun.nodes.some((node) => workflowHumanWait(node) !== null) && (
                    <div className="workflow-run-notice waiting" role="alert">
                      <Icon.shield />
                      <span>
                        <strong>{tr("workflowview.workflowNeedsYou")}</strong>
                        {tr("workflowview.workflowNeedsYouHelp")}
                      </span>
                    </div>
                  )}
                  {shownRun.status === "error" && (
                    <div className="workflow-run-notice error" role="alert">
                      <Icon.close />
                      <span>
                        <strong>{tr("workflowview.workflowFailed")}</strong>
                        {tr("workflowview.workflowFailedHelp")}
                      </span>
                    </div>
                  )}
                  {shownRun.status === "stopped" && (
                    <div className="workflow-run-notice">
                      <Icon.stop />
                      <span><strong>{tr("workflowview.workflowRunStopped")}</strong> {tr("workflowview.workflowRunStoppedHelp")}</span>
                    </div>
                  )}
                  <div
                    className={`workflow-run-progress status-${shownRun.status}`}
                    role="progressbar"
                    aria-label={tr("workflowtimeline.nodesFinished", { complete: finishedNodes, total: shownRun.nodes.length })}
                    aria-valuemin={0}
                    aria-valuemax={shownRun.nodes.length}
                    aria-valuenow={finishedNodes}
                  >
                    <span style={{ width: `${shownRun.nodes.length ? (finishedNodes / shownRun.nodes.length) * 100 : 0}%` }} />
                  </div>
                  <div className="workflow-run-grid">
                    {shownRun.nodes.map((node) => {
                      const needsHuman = workflowHumanWait(node) !== null;
                      return (
                      <article key={node.id} className={`sched-card workflow-run-card status-${node.status}${needsHuman ? " needs-human" : ""}`}>
                        <div className="workflow-run-card-heading">
                          <strong>{node.role}</strong>
                          <StatusBadge status={node.status} />
                        </div>
                        {needsHuman
                          ? <span className="workflow-node-activity needs-human"><Icon.shield />{workflowHumanWaitLabel(node)}</span>
                          : node.activity && <span className="workflow-node-activity">{node.activity}</span>}
                        {node.error && <div className="form-error" role="alert">{node.error}</div>}
                        {node.output && (
                          <pre
                            className="workflow-node-output"
                            tabIndex={0}
                            aria-label={tr("workflowview.outputValue", { role: node.role })}
                          >
                            {node.output}
                          </pre>
                        )}
                        {!node.activity && !node.error && !node.output && (
                          <span className="muted workflow-node-waiting">
                            {node.status === "queued" ? tr("workflowview.waitingDependencies") : tr("workflowview.noOutput")}
                          </span>
                        )}
                        {node.sessionId && (
                          <button
                            type="button"
                            className={`small-btn workflow-button workflow-open-session${needsHuman ? " primary-btn" : ""}`}
                            disabled={isBusy}
                            aria-busy={openingSessionId === node.sessionId}
                            aria-label={needsHuman
                              ? tr("workflowtimeline.reviewAndRespondValue", { role: node.role })
                              : tr("workflowview.openChildValue", { role: node.role })}
                            onClick={() => void openLinkedSession(node.sessionId!)}
                          >
                            <WorkflowButtonContent
                              busy={openingSessionId === node.sessionId}
                              idleLabel={needsHuman
                                ? tr("workflowview.reviewAndRespond")
                                : tr("workflowtimeline.openSession")}
                              busyLabel={tr("workflowview.opening")}
                              idleTrailingIcon={<Icon.chevronRight />}
                            />
                          </button>
                        )}
                      </article>
                    );})}
                  </div>
                  <div className="workflow-results-actions">
                    {shownRun.parentSessionId && (
                      <button
                        type="button"
                        className="small-btn workflow-button"
                        disabled={isBusy}
                        aria-busy={openingSessionId === shownRun.parentSessionId}
                        onClick={() => void openParentChat()}
                      >
                        <WorkflowButtonContent
                          busy={openingSessionId === shownRun.parentSessionId}
                          idleLabel={tr("workflowview.openParentChat")}
                          busyLabel={tr("workflowview.opening")}
                          idleIcon={<Icon.session />}
                        />
                      </button>
                    )}
                    {shownRun.status !== "running" && (
                      <button
                        type="button"
                        className="primary-btn workflow-button"
                        disabled={isBusy || dirty || !shownRun.parentSessionId}
                        aria-busy={busy === "retry"}
                        title={!shownRun.parentSessionId
                          ? tr("workflowview.thisOlderRunNoParent")
                          : dirty
                            ? tr("workflowview.saveBeforeRetry")
                            : shownRun.status === "error"
                              ? tr("workflowview.retryFullHelp")
                              : tr("workflowview.runAgain")}
                        onClick={retry}
                      >
                        <WorkflowButtonContent
                          busy={busy === "retry"}
                          idleLabel={shownRun.status === "error" ? tr("workflowview.retryFull") : tr("workflowview.runAgain")}
                          busyLabel={tr("workflowview.starting")}
                          idleIcon={<Icon.workflow />}
                        />
                      </button>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
      {draft && (
        <div className="workflow-mobile-savebar" aria-label={tr("workflowview.saveWorkflow")}>
          <span className={`workflow-save-state${dirty ? " dirty" : ""}`} role="status">
            {dirty ? tr("workflowview.unsaved") : tr("workflowview.saved")}
          </span>
          <button
            type="button"
            className="primary-btn workflow-button"
            disabled={isBusy || !canSave || !dirty}
            aria-busy={busy === "save"}
            onClick={save}
          >
            <WorkflowButtonContent
              busy={busy === "save"}
              idleLabel={tr("common.save")}
              busyLabel={tr("common.saving")}
              idleIcon={<Icon.check />}
            />
          </button>
        </div>
      )}
    </div>
  );
}
