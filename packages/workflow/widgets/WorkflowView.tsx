import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type {
  HarnessSelection,
  ModelDescriptor,
  ModelRef,
  WorkflowDto,
  WorkflowPreferencesDto,
  WorkflowNodeDto,
  WorkflowNodeStatus,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunOptionsDto,
  WorkflowRunStatus,
} from "@polyth/contracts";
import { onConnectionRestored } from "@polyth/contracts/transport-retry";
import { api } from "@polyth/session/web-api";
import { modelSupportsTextWorkflow } from "../../../apps/web/src/composer/discovery.ts";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { getState, useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { openSession } from "../../../apps/web/src/init.ts";
import { formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import {
  BackIcon,
  Badge,
  Button,
  Checkbox,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  DeleteIcon,
  IconButton,
  Menu,
  MoreIcon,
  PlusIcon,
  RedoIcon,
  ResponsiveOverlay,
  Select,
  ShieldAlertIcon,
  Spinner,
  StopIcon,
  Tabs,
  Textarea,
  TextInput,
  UndoIcon,
  WorkflowIcon,
  WrenchIcon,
  tabId,
  tabPanelId,
  type BadgeTone,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  orderWorkflows,
  workflowPresets,
} from "../src/presets.ts";
import { DEFAULT_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS } from "../src/review.ts";
import {
  groupWorkflowNodes,
  layerizeWorkflow,
  insertWorkflowNode,
  moveWorkflowNode,
  removeWorkflowNode,
  resizeWorkflowGroup,
  type WorkflowInsertPlacement,
  type WorkflowEditorNode,
} from "./workflowGraph.ts";
import { ReviewDecision, ReviewFindings } from "./ReviewFindings.tsx";
import { publishWorkflowRun, subscribeWorkflowRuns } from "./workflowMonitor.ts";
import { subscribeWorkflowLaunches, takeWorkflowLaunch, type WorkflowLaunchIntent } from "./workflowLaunch.ts";
import { retryWorkflowStart, useWorkflowStart, workflowStartFor, type WorkflowStart } from "./workflowStart.ts";
import {
  workflowPresetDescription,
  workflowPresetName,
  workflowTopology,
  workflowCardLabel,
} from "./workflowLabels.ts";
import {
  shouldAdoptWorkflowSnapshot,
  shouldApplyWorkflowSave,
} from "./workflowSave.ts";
import {
  fresherWorkflowRun,
  workflowDisplayText,
  workflowFinishedCount,
  workflowHumanWait,
  workflowHumanWaitLabel,
  workflowReviewRoundsLabel,
  workflowRoundLabel,
  workflowSentBackRoles,
  workflowStatusLabel,
  workflowUnresolvedReviews,
  workflowUncertainReviews,
  workflowVerdictLabel,
  workflowJudgedLabel,
  workflowNeedsDecision,
  workflowNeedsFix,
  workflowAgentCount,
  workflowStageCount,
} from "./workflowRun.ts";

const RUN_OPTION_DEFAULTS: WorkflowRunOptionsDto = {
  permissions: "manual",
  maxParallel: 2,
  nodeTimeoutMs: 1_800_000,
  reviewRounds: DEFAULT_REVIEW_ROUNDS,
};

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `workflow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const clone = <T,>(value: T): T => structuredClone(value);
const sameModel = (left?: ModelRef, right?: ModelRef): boolean =>
  !!left && !!right && left.providerID === right.providerID && left.modelID === right.modelID;
const sameRun = (left: WorkflowRunDto | null, right: WorkflowRunDto): boolean =>
  !!left && left.id === right.id && JSON.stringify(left) === JSON.stringify(right);
const harnessValue = (value?: HarnessSelection) =>
  value?.mode === "pinned" ? value.harnessId : "";
type PresetLike = WorkflowDto & {
  id: string;
  version?: number;
  category?: string;
  description?: string;
  builtin?: boolean;
  preset?: { id: string; version: number };
};
type LaunchRoute = Pick<WorkflowLaunchIntent, "model" | "harness" | "agent">;

function statusTone(status: WorkflowNodeStatus | WorkflowRunStatus): BadgeTone {
  return status === "done"
    ? "success"
    : status === "error"
    ? "danger"
    : status === "running"
    ? "accent"
    : "neutral";
}
function StatusBadge({
  status,
}: {
  status: WorkflowNodeStatus | WorkflowRunStatus;
}) {
  return (
    <Badge
      tone={statusTone(status)}
      className={`workflow-status status-${status}`}
    >
      <span aria-hidden="true">
        {status === "running" ? (
          <Spinner size="sm" />
        ) : status === "done" ? (
          <Icon.check />
        ) : status === "error" ? (
          <Icon.close />
        ) : status === "stopped" ? (
          <Icon.stop />
        ) : (
          <Icon.clock />
        )}
      </span>
      {workflowStatusLabel(status)}
    </Badge>
  );
}
function newNode(
  role = tr("workflowview.worker"),
  kind: WorkflowNodeDto["kind"] = "worker"
): WorkflowNodeDto {
  return {
    id: uid(),
    role,
    prompt: "Complete the assigned part and return concise evidence.",
    kind,
  };
}
/** A small picture of the graph: one column per stage, one dot per agent. */
function TopologyGlyph({ graph }: { graph: Pick<WorkflowDto, "nodes" | "edges"> }) {
  const topology = layerizeWorkflow(graph);
  const points = new Map((topology.ok ? topology.layers : []).flatMap((layer, index, layers) =>
    layer.slice(0, 4).map((id, row, shown) => [id, {
      x: 8 + index * 40 / Math.max(1, layers.length - 1),
      y: 21 + (row - (shown.length - 1) / 2) * 10,
    }] as const)));
  const radius = topology.ok && topology.layers.length > 4 ? 2.8 : 3.5;
  return (
    <svg className="workflow-card-glyph" viewBox="0 0 56 42" aria-hidden="true">
      {graph.edges.map((edge) => {
        const from = points.get(edge.source), to = points.get(edge.target);
        return from && to ? <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} /> : null;
      })}
      {[...points].map(([id, point]) => <circle key={id} cx={point.x} cy={point.y} r={radius} />)}
    </svg>
  );
}

function graphMeta(graph: Pick<WorkflowDto, "nodes" | "edges">): string {
  const topology = layerizeWorkflow(graph);
  return topology.ok
    ? `${workflowAgentCount(graph.nodes.length)} · ${workflowStageCount(topology.layers.length)}`
    : workflowAgentCount(graph.nodes.length);
}

/** One library entry. Every entry is a template: the whole card opens it and
 * the copy action makes an editable copy. A template has no status of its
 * own; a run belongs to the chat that ran it. */
function WorkflowCard({
  graph,
  name,
  description,
  badge,
  onOpen,
  onCopy,
}: {
  graph: Pick<WorkflowDto, "nodes" | "edges">;
  name: string;
  description: string;
  badge?: string;
  onOpen: () => void;
  onCopy: () => void;
}) {
  return (
    <article className="workflow-card">
      <button
        type="button"
        className="workflow-card-main"
        onClick={onOpen}
        aria-label={tr("workflowview.openValue", { name })}
        title={workflowTopology({ ...graph, name } as WorkflowDto)}
      >
        <span className="workflow-card-art"><TopologyGlyph graph={graph} /></span>
        <span className="workflow-card-copy">
          <span className="workflow-card-title">
            <strong>{name}</strong>
            {badge && <span className="workflow-card-badge">{badge}</span>}
          </span>
          {description && <span className="workflow-card-description">{description}</span>}
          <span className="workflow-card-meta">
            <span>{graphMeta(graph)}</span>
          </span>
        </span>
      </button>
      <IconButton
        icon={CopyIcon}
        size="sm"
        variant="ghost"
        className="workflow-card-copy-action"
        label={tr("workflowview.copyValue", { name })}
        onClick={onCopy}
      />
    </article>
  );
}

export interface WorkflowViewProps {
  /** Composer-owned harness picker (the `modelPicker.header` slot). The host
   * supplies it so the workflow surface never re-implements harness routing. */
  harnessSlot?: (context: Record<string, unknown>) => ReactNode;
}

export default function WorkflowView({ harnessSlot }: WorkflowViewProps) {
  const shellMode = useShellMode();
  const projectId = useStore((state) => state.activeProjectId);
  const projectSpaceId = useStore(
    (state) =>
      state.projectRegistry.projects.find(
        (project) => project.id === state.activeProjectId
      )?.spaceId
  );
  const sessionId = useStore((state) => state.activeSessionId);
  const eventRun = useActiveModel().workflowRun;
  const start = useWorkflowStart(sessionId);
  const globalModels = useStore((state) => state.models);
  const agents = useStore((state) => state.agents);
  // The chat route a fully unassigned node inherits at launch. Shown as the
  // recommendation so the builder never has to invent a model. `resolvedHarnessId`
  // is the route the parent session is already bound to.
  const chatModel = useStore(
    (state) =>
      state.sessions.find((row) => row.id === state.activeSessionId)?.model
  );
  const textModels = useMemo(
    () => globalModels.filter(modelSupportsTextWorkflow),
    [globalModels]
  );
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [preferences, setPreferences] = useState<WorkflowPreferencesDto>({
    pinnedIds: [],
    recentIds: [],
  });
  const [draft, setDraft] = useState<WorkflowDto | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const runAnchor = useRef<HTMLElement>(null);
  const revealRun = useRef(false);
  // The library is its own page; a chosen workflow replaces it (back returns).
  const [page, setPage] = useState<"library" | "workflow">("library");
  const [tab, setTab] = useState<"run" | "edit">("run");
  const [runs, setRuns] = useState<WorkflowRunDto[]>([]);
  const [presetSearch, setPresetSearch] = useState("");
  const [runInput, setRunInput] = useState("");
  const [launchRoute, setLaunchRoute] = useState<LaunchRoute>();
  const [runOptions, setRunOptions] = useState<WorkflowRunOptionsDto>(RUN_OPTION_DEFAULTS);
  const [liveRun, setLiveRun] = useState<WorkflowRunDto | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // The library itself could not be read; the banner offers Retry, not Dismiss.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState<
    "saved" | "saving" | "error" | "conflict"
  >("saved");
  const [loading, setLoading] = useState(true);
  const undoStack = useRef<WorkflowDto[]>([]);
  const redoStack = useRef<WorkflowDto[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const requestVersion = useRef(0);
  const loadedRevision = useRef(0);
  const editVersion = useRef(0);
  const runOperationId = useRef<string | null>(null);
  const runParent = useRef<{ scope: string; id: string } | null>(null);
  const operationIntent = useRef("");
  const retryOperation = useRef<{ intent: string; id: string } | null>(null);
  const savedRevisions = useRef(new Map<string, number>());
  const actionInFlight = useRef(false);
  const projectScope = JSON.stringify([projectSpaceId, projectId]);
  const projectScopeRef = useRef(projectScope);
  projectScopeRef.current = projectScope;
  const draftScope = JSON.stringify([projectSpaceId, projectId, draft?.id]);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  const selected = workflows.find((item) => item.id === selectedId) ?? null;
  const selectedNode =
    draft?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedHarnessId =
    selectedNode?.harness?.mode === "pinned"
      ? selectedNode.harness.harnessId
      : "";
  const shownRun = fresherWorkflowRun(
    liveRun?.workflowId === draft?.id ? liveRun : null,
    eventRun && eventRun.workflowId === draft?.id ? eventRun : null
  );
  // A run still being admitted for this chat leads until its record exists.
  const pendingStart = start && start.workflowId === draft?.id ? start : undefined;
  const graphLayers = draft ? layerizeWorkflow(draft) : null;
  const grouped = useMemo(
    () => (draft ? groupWorkflowNodes(draft) : []),
    [draft]
  );
  // Bundled templates as the server serves them, with the routes this
  // project saved for their units; the local catalog only until it answers.
  const presets = useMemo(() => {
    const served = workflows.filter((item) => item.builtin);
    return (served.length ? served : workflowPresets(projectId ?? "")) as unknown as PresetLike[];
  }, [projectId, workflows]);
  const query = presetSearch.trim().toLocaleLowerCase();
  const matches = (...parts: Array<string | undefined>) =>
    !query || parts.join(" ").toLocaleLowerCase().includes(query);
  const presetLabel = (preset: PresetLike) => {
    const presetId = preset.preset?.id ?? preset.id.split(":").at(-1) ?? preset.id;
    return {
      name: workflowPresetName(presetId, preset.name),
      description: workflowPresetDescription(presetId, preset.description || tr("workflowview.reusableWorkflow")),
    };
  };
  const visiblePresets = presets.filter((item) => {
    const label = presetLabel(item);
    return matches(label.name, label.description, item.name);
  });
  const savedWorkflows = workflows.filter((item) => !item.builtin);
  const visibleSaved = savedWorkflows.filter((item) => {
    const label = workflowCardLabel(item);
    return matches(label.name, label.description);
  });
  // A run belongs to the chat that ran it, not to the template: a workflow's
  // page shows this chat's latest run of it and nothing from other chats.
  const latestRun = (workflowId: string, from = runs, chatId = sessionId) =>
    from.reduce<WorkflowRunDto | undefined>((latest, item) =>
      item.workflowId === workflowId && !!chatId && item.parentSessionId === chatId
        && (!latest || item.startedAt > latest.startedAt) ? item : latest, undefined);
  // One composer-owned catalog per route. The runtime catalog is transparently
  // cached and persisted, so selecting an already-known node harness never
  // starts a native probe the way a forced per-selection snapshot did.
  const routeCatalog = useRuntimeCatalog(null, textModels, agents, {
    ...(projectId ? { projectId } : {}),
    ...(projectSpaceId ? { spaceId: projectSpaceId } : {}),
    ...(selectedHarnessId ? { harnessId: selectedHarnessId } : {}),
  });
  const modelsForHarness = routeCatalog.models;
  const dirty = useMemo(
    () => !!draft && !!selected && JSON.stringify(draft) !== JSON.stringify(selected),
    [draft, selected]
  );
  const readOnlyPreview = !!draft?.builtin;
  useEffect(() => {
    if (inspectorOpen && shellMode === "wide") inspectorRef.current?.scrollIntoView({ block: "nearest" });
  }, [inspectorOpen, selectedNodeId, shellMode]);
  // "View workflow" on a run lands on that run, not above the whole editor.
  useEffect(() => {
    if (!revealRun.current || loading) return;
    revealRun.current = false;
    if (shownRun) runAnchor.current?.scrollIntoView({ block: "start" });
  }, [loading, shownRun?.id]);
  const graphError = graphLayers && !graphLayers.ok ? graphLayers.error : "";
  const canSave = !!draft && !!draft.name.trim() && !graphError
    && draft.nodes.every((node) => node.role.trim() && node.prompt.trim());

  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    editVersion.current += 1;
    setSaveState("saved");
    setInspectorOpen(false);
    setRunOptions(draft?.defaults ?? RUN_OPTION_DEFAULTS);
  }, [draftScope]);
  useEffect(() => () => {
    requestVersion.current += 1;
    projectScopeRef.current = "";
    draftScopeRef.current = "";
  }, []);

  const load = useCallback(async () => {
    if (!projectId) {
      setWorkflows([]);
      setDraft(null);
      setLaunchRoute(undefined);
      setLoading(false);
      return;
    }
    const sequence = ++requestVersion.current;
    setLoading(true);
    setError("");
    setLoadFailed(false);
    try {
      const [items, projectRuns, prefs] = await Promise.all([
        api.listWorkflows(projectId),
        api.listWorkflowRuns(projectId),
        api.getWorkflowPreferences(projectId),
      ]);
      if (sequence !== requestVersion.current) return;
      const launch = takeWorkflowLaunch(projectId);
      setLaunchRoute(launch ? {
        ...(launch.model ? { model: launch.model } : {}),
        ...(launch.harness ? { harness: launch.harness } : {}),
        ...(launch.agent ? { agent: launch.agent } : {}),
      } : undefined);
      const ordered = orderWorkflows(items, prefs);
      setPreferences(prefs);
      setWorkflows(ordered);
      setRuns(projectRuns);
      // Opened from a run or the composer with a workflow to show: that
      // workflow's page leads. Otherwise the surface opens on the library.
      const initial = launch
        ? items.find((item) => item.id === launch.workflowId) ?? null
        : null;
      setPage(initial ? "workflow" : "library");
      setTab("run");
      revealRun.current = !!launch?.run && !!initial;
      setSelectedId(initial?.id ?? null);
      setDraft(initial ? clone(initial) : null);
      setSelectedNodeId(initial?.nodes[0]?.id ?? null);
      setRunInput(launch?.input ?? "");
      setRunOptions(initial?.defaults ?? RUN_OPTION_DEFAULTS);
      setExpandedGroups(new Set());
      loadedRevision.current = initial?.revision ?? 0;
      // A start still in flight must not show the workflow's previous run.
      const starting = initial && workflowStartFor(launch?.sessionId)?.workflowId === initial.id;
      setLiveRun(
        launch?.run ?? (initial && !starting
          ? latestRun(initial.id, projectRuns, launch?.sessionId ?? getState().activeSessionId)
          : undefined) ?? null
      );
    } catch (cause) {
      if (sequence === requestVersion.current) {
        setLoadFailed(true);
        setError(friendlyError(tr("workflowview.couldNotLoadWorkflows"), cause));
      }
    } finally {
      if (sequence === requestVersion.current) setLoading(false);
    }
  }, [projectId, projectSpaceId]);
  useEffect(() => {
    void load();
  }, [load]);
  // A library that could not be read (a phone whose link was still coming
  // back) loads again once the shell's connection is restored. An open
  // workflow is never replaced behind the reader's back.
  const libraryUnread = loadFailed && !draft;
  useEffect(() => libraryUnread ? onConnectionRestored(() => void load()) : undefined, [libraryUnread, load]);
  // A launch handed off while this surface stays open (a pinned window)
  // leads at once. A window that is closing leaves it to the next mount.
  useEffect(() => subscribeWorkflowLaunches(() => {
    if (getState().railPlugin === "workflow") void load();
  }), [load]);
  // A run admitted for this chat replaces its starting state without waiting
  // for the WebSocket event.
  useEffect(() => subscribeWorkflowRuns((next) => {
    if (next.parentSessionId !== sessionId || next.workflowId !== draft?.id) return;
    setLiveRun((current) => fresherWorkflowRun(current, next));
  }), [sessionId, draft?.id]);
  useEffect(() => {
    setWorkflows((current) => orderWorkflows(current, preferences));
  }, [preferences]);
  useEffect(() => {
    if (!shownRun || shownRun.status !== "running") return;
    let active = true;
    let pending = false;
    const refresh = () => {
      if (!active || pending || document.visibilityState === "hidden") return;
      pending = true;
      void api
        .getWorkflowRun(shownRun.id)
        .then((next) => {
          if (active) setLiveRun((current) => sameRun(current, next) ? current : next);
        })
        .catch(() => undefined)
        .finally(() => { pending = false; });
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [shownRun?.id, shownRun?.status]);
  // Runs started or refreshed here stay this chat's latest run when its
  // workflow is opened again.
  useEffect(() => {
    if (!shownRun) return;
    setRuns((current) => current.includes(shownRun)
      ? current
      : [shownRun, ...current.filter((item) => item.id !== shownRun.id)]);
  }, [shownRun]);
  useEffect(() => {
    const openChild = (event: Event) => {
      const target = (event as CustomEvent<string>).detail;
      if (!target) return;
      void openSession(target).catch((cause) =>
        setError(friendlyError(tr("workflowview.couldNotOpenSession"), cause))
      );
    };
    window.addEventListener("polyth:workflow-open-session", openChild);
    return () =>
      window.removeEventListener("polyth:workflow-open-session", openChild);
  }, []);

  const mutateDraft = useCallback(
    (change: (current: WorkflowDto) => WorkflowDto) => {
      setDraft((current) => {
        if (!current || readOnlyPreview) return current;
        undoStack.current.push(clone(current));
        if (undoStack.current.length > 50) undoStack.current.shift();
        redoStack.current = [];
        editVersion.current += 1;
        return change(current);
      });
      setSaveState("saving");
      setError("");
    },
    [readOnlyPreview]
  );
  const save = useCallback(
    (value: WorkflowDto) => {
      if (!canSave) return Promise.resolve();
      const version = editVersion.current;
      const scope = JSON.stringify([projectSpaceId, projectId, value.id]);
      const persist = async () => {
        if (!shouldAdoptWorkflowSnapshot(scope, draftScopeRef.current, version, editVersion.current)) return;
        const expectedRevision = savedRevisions.current.get(scope) ?? value.revision ?? loadedRevision.current;
        setSaveState("saving");
        try {
          const updated = await api.updateWorkflow(value.id, {
            name: value.name.trim(),
            description: value.description,
            category: value.category,
            profile: value.profile,
            nodes: value.nodes,
            edges: value.edges,
            defaults: value.defaults,
            expectedRevision,
          });
          if (!shouldApplyWorkflowSave(scope, draftScopeRef.current)) return;
          setWorkflows((current) =>
            current.map((item) => (item.id === updated.id ? updated : item))
          );
          loadedRevision.current = updated.revision ?? expectedRevision + 1;
          savedRevisions.current.set(scope, loadedRevision.current);
          if (
            shouldAdoptWorkflowSnapshot(
              scope,
              draftScopeRef.current,
              version,
              editVersion.current
            )
          ) {
            setDraft((current) =>
              current?.id === updated.id ? clone(updated) : current
            );
            setSaveState("saved");
          } else {
            setDraft((current) => current?.id === updated.id
              ? { ...current, revision: updated.revision, updatedAt: updated.updatedAt }
              : current);
          }
        } catch (cause) {
          if (!shouldApplyWorkflowSave(scope, draftScopeRef.current)) return;
          const message = cause instanceof Error ? cause.message : String(cause);
          const conflict = /revision|conflict|409/i.test(message);
          setSaveState(conflict ? "conflict" : "error");
          setError(
            `${conflict ? tr("workflowview.workflowChangedElsewhere") : tr("workflowview.autosaveFailed")} ${message}`
          );
        }
      };
      saveChain.current = saveChain.current.then(persist, persist);
      return saveChain.current;
    },
    [canSave, projectId, projectSpaceId]
  );
  useEffect(() => {
    if (!draft || !dirty) return;
    if (!canSave) {
      setSaveState("error");
      setError(tr("workflowview.fixFieldsBeforeSave"));
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void save(clone(draft));
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft, dirty, canSave, save]);

  const pageTop = useRef<HTMLDivElement>(null);
  const showWorkflow = (value: WorkflowDto, nextTab: "run" | "edit", savedId: string | null = value.id) => {
    setSelectedId(savedId);
    setDraft(clone(value));
    setSelectedNodeId(value.nodes[0]?.id ?? null);
    setRunOptions(value.defaults ?? RUN_OPTION_DEFAULTS);
    setExpandedGroups(new Set());
    setLiveRun(latestRun(value.id) ?? null);
    setRunInput("");
    loadedRevision.current = value.revision ?? 0;
    setPage("workflow");
    setTab(nextTab);
    pageTop.current?.scrollIntoView?.({ block: "start" });
  };
  const createWorkflow = async (
    input: Omit<Parameters<typeof api.createWorkflow>[0], "projectId">,
    busyKey: string,
    failure: () => string,
  ) => {
    if (!projectId || actionInFlight.current) return;
    actionInFlight.current = true;
    const scope = projectScope;
    try {
      setBusy(busyKey);
      const created = await api.createWorkflow({ projectId, ...input });
      if (projectScopeRef.current !== scope) return;
      setWorkflows((current) => [created, ...current]);
      // A new workflow exists to be shaped, so it opens on its pipeline.
      showWorkflow(created, "edit");
    } catch (cause) {
      if (projectScopeRef.current === scope) setError(friendlyError(failure(), cause));
    } finally {
      actionInFlight.current = false;
      if (projectScopeRef.current === scope) setBusy("");
    }
  };
  const createBlank = () => createWorkflow({
    name: tr("workflowview.untitledWorkflow"),
    nodes: [newNode(tr("workflowview.lead"), "lead")],
    edges: [],
    category: "general",
    defaults: RUN_OPTION_DEFAULTS,
  }, "create", () => tr("workflowview.couldNotCreateWorkflow"));
  /** Customize a template or duplicate a saved workflow: an editable copy. */
  const duplicateWorkflow = (source: PresetLike | WorkflowDto) => createWorkflow({
    name: tr("workflowview.copyName", { name: workflowCardLabel(source).name }),
    description: source.description,
    category: source.category as WorkflowDto["category"],
    preset: source.preset,
    nodes: clone(source.nodes),
    edges: clone(source.edges),
    defaults: clone(source.defaults),
  }, "preset", () => tr("workflowview.couldNotCustomizePreset"));
  const openTemplate = (preset: PresetLike) => showWorkflow(preset, "run", null);
  const changeNode = (id: string, patch: Partial<WorkflowNodeDto>) =>
    mutateDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === id ? { ...node, ...patch } : node
      ),
    }));
  const addNode = (
    kind: WorkflowNodeDto["kind"],
    placement: WorkflowInsertPlacement = "after"
  ) =>
    mutateDraft((current) => {
      const node = newNode(
        kind === "review" ? tr("workflowview.reviewer") : kind === "lead" ? tr("workflowview.lead") : tr("workflowview.worker"),
        kind
      );
      const anchor = current.nodes.find((candidate) => candidate.id === selectedNodeId);
      if (placement === "parallel") {
        node.group = anchor?.group ?? `parallel-${anchor?.id ?? "root"}`;
      }
      return insertWorkflowNode(current, node, anchor?.id, placement, () => uid()) as WorkflowDto;
    });
  const deleteNode = (id: string) =>
    mutateDraft((current) => ({
      ...current,
      ...removeWorkflowNode(current, id, () => uid()),
    }));
  const adjustGroup = (group: string, count: number) =>
    mutateDraft((current) =>
      resizeWorkflowGroup(current, group, count, uid, uid) as WorkflowDto
    );
  const moveNode = (id: string, direction: -1 | 1) =>
    mutateDraft((current) => {
      return moveWorkflowNode(current, id, direction, () => uid()) as WorkflowDto;
    });
  const undo = () => {
    const previous = undoStack.current.pop();
    if (!previous || !draft) return;
    redoStack.current.push(clone(draft));
    editVersion.current += 1;
    setSaveState("saving");
    setDraft({ ...previous, revision: draft.revision, updatedAt: draft.updatedAt });
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (!next || !draft) return;
    undoStack.current.push(clone(draft));
    editVersion.current += 1;
    setSaveState("saving");
    setDraft({ ...next, revision: draft.revision, updatedAt: draft.updatedAt });
  };
  const run = async (options = runOptions, input = runInput) => {
    const task = input.trim();
    if (
      actionInFlight.current ||
      !draft ||
      !task ||
      dirty ||
      !canSave
    )
      return;
    actionInFlight.current = true;
    const scope = draftScope;
    const intent = JSON.stringify([scope, sessionId, task, options, launchRoute]);
    if (operationIntent.current !== intent) {
      operationIntent.current = intent;
      runOperationId.current = null;
    }
    const clientOperationId =
      runOperationId.current ?? (runOperationId.current = uid());
    try {
      setBusy("run");
      let parentId = sessionId ?? (runParent.current?.scope === projectScope ? runParent.current.id : undefined);
      if (!parentId) {
        const parent = await api.createSession({
          projectId: projectId!,
          // The parent runs no turn of its own: the server names it from the
          // task once the run is admitted (Custom Titles, else the prompt).
          ...(task.trim() ? {} : { title: draft.name }),
          purpose: "workflow",
          ...(launchRoute?.model ? { model: launchRoute.model } : {}),
          ...(launchRoute?.harness ? { harness: launchRoute.harness } : {}),
          ...(launchRoute?.agent ? { agent: launchRoute.agent } : {}),
        });
        parentId = parent.id;
        runParent.current = { scope: projectScope, id: parentId };
        if (draftScopeRef.current !== scope) return;
      }
      const started = await api.runWorkflow(
        draft.id,
        parentId,
        task,
        options,
        {
          clientOperationId,
          context: "request",
          ...(launchRoute?.model ? { model: launchRoute.model } : {}),
          ...(launchRoute?.harness ? { harness: launchRoute.harness } : {}),
          ...(launchRoute?.agent ? { agent: launchRoute.agent } : {}),
        }
      );
      if (draftScopeRef.current !== scope) return;
      publishWorkflowRun(started);
      setLiveRun(started);
      runOperationId.current = null;
    } catch (cause) {
      if (draftScopeRef.current !== scope) return;
      setError(friendlyError(tr("workflowview.couldNotStartWorkflow"), cause));
    } finally {
      actionInFlight.current = false;
      if (draftScopeRef.current === scope) setBusy("");
    }
  };
  const stop = async () => {
    if (actionInFlight.current || !shownRun) return;
    const scope = projectScope;
    actionInFlight.current = true;
    try {
      setBusy("stop");
      const stopped = await api.stopWorkflowRun(shownRun.id);
      if (projectScopeRef.current !== scope) return;
      setLiveRun(stopped);
    } catch (cause) {
      if (projectScopeRef.current === scope)
        setError(friendlyError(tr("workflowview.couldNotStopWorkflow"), cause));
    } finally {
      actionInFlight.current = false;
      if (projectScopeRef.current === scope) setBusy("");
    }
  };
  /** The template as saved by a fix: the library and an untouched page show
   * the new route, and the next autosave builds on the new revision. */
  const adoptTemplate = async (workflowId: string, scope: string) => {
    if (!projectId) return;
    const items = await api.listWorkflows(projectId).catch(() => null);
    if (!items || projectScopeRef.current !== scope) return;
    setWorkflows(orderWorkflows(items, preferences));
    const updated = items.find((item) => item.id === workflowId);
    if (!updated) return;
    if (!updated.builtin) savedRevisions.current.set(JSON.stringify([projectSpaceId, projectId, updated.id]), updated.revision ?? 0);
    setDraft((current) => {
      if (current?.id !== updated.id || (selected && JSON.stringify(current) !== JSON.stringify(selected))) return current;
      loadedRevision.current = updated.revision ?? 0;
      return clone(updated);
    });
  };
  const retryNode = async (
    nodeId: string,
    replacement?: Pick<WorkflowNodeDto, "model" | "harness" | "agent">,
    saveToWorkflow = false
  ) => {
    if (actionInFlight.current || !shownRun) return;
    // A running run accepts only a fix for a unit it holds.
    const held = shownRun.nodes.find((node) => node.id === nodeId);
    if (shownRun.status === "running" && !(held && workflowNeedsFix(held))) return;
    actionInFlight.current = true;
    const scope = draftScope;
    const projectAtStart = projectScope;
    const intent = JSON.stringify([scope, shownRun.id, nodeId, replacement, saveToWorkflow]);
    if (retryOperation.current?.intent !== intent) retryOperation.current = { intent, id: uid() };
    try {
      setBusy(`retry:${nodeId}`);
      const next = await api.retryWorkflowRun(shownRun.id, {
        nodeId,
        clientOperationId: retryOperation.current.id,
        ...(replacement ? { replacement } : {}),
        ...(replacement && saveToWorkflow ? { saveToWorkflow: true } : {}),
      });
      if (draftScopeRef.current !== scope) return;
      publishWorkflowRun(next);
      setLiveRun(next);
      retryOperation.current = null;
      if (replacement && saveToWorkflow) void adoptTemplate(next.workflowId, projectAtStart);
    } catch (cause) {
      if (draftScopeRef.current !== scope) return;
      setError(friendlyError(tr("workflowview.couldNotRetryNode"), cause));
    } finally {
      actionInFlight.current = false;
      if (draftScopeRef.current === scope) setBusy("");
    }
  };
  const selectWorkflow = async (id: string) => {
    const scope = projectScope;
    // Back then forward to the same workflow keeps its in-progress edits.
    if (id === draft?.id) {
      setPage("workflow");
      return;
    }
    if (
      dirty &&
      !(await confirmAlert(tr("workflowview.discardTitle"), {
        title: tr("workflowview.switchWorkflow"),
        confirmLabel: tr("workflowview.discard"),
      }))
    )
      return;
    if (projectScopeRef.current !== scope) return;
    const next = workflows.find((item) => item.id === id);
    if (!next) return;
    showWorkflow(next, "run");
    const recentIds = [
      id,
      ...preferences.recentIds.filter((recentId) => recentId !== id),
    ].slice(0, 8);
    const nextPreferences = { ...preferences, selectedId: id, recentIds };
    setPreferences(nextPreferences);
    void api
      .updateWorkflowPreferences(projectId!, { selectedId: id, recentIds })
      .catch(() => undefined);
  };
  const backToLibrary = async () => {
    if (draft && dirty) {
      if (canSave) {
        // Leaving the page is not a reason to wait out the autosave debounce.
        if (saveTimer.current) clearTimeout(saveTimer.current);
        void save(clone(draft));
      } else {
        if (!(await confirmAlert(tr("workflowview.discardTitle"), {
          title: tr("workflowview.switchWorkflow"),
          confirmLabel: tr("workflowview.discard"),
        }))) return;
        setDraft(selected ? clone(selected) : null);
        setSaveState("saved");
        setError("");
      }
    }
    setInspectorOpen(false);
    setPage("library");
    pageTop.current?.scrollIntoView?.({ block: "start" });
  };
  const deleteWorkflow = async () => {
    if (!selected || selected.builtin || busy) return;
    const scope = projectScope;
    const deletedId = selected.id;
    if (!(await confirmAlert(tr("workflowview.deleteWorkflowConfirm", { name: selected.name }), {
      title: tr("workflowview.deleteWorkflow"),
      confirmLabel: tr("workflowview.deleteConfirm"),
    }))) return;
    if (projectScopeRef.current !== scope) return;
    try {
      setBusy("delete-workflow");
      await api.deleteWorkflow(deletedId);
      if (projectScopeRef.current !== scope) return;
      setWorkflows((current) => current.filter((item) => item.id !== deletedId));
      setSelectedId(null);
      setDraft(null);
      setSelectedNodeId(null);
      setLiveRun(null);
      setPage("library");
    } catch (cause) {
      if (projectScopeRef.current === scope)
        setError(friendlyError(tr("workflowview.deleteWorkflowFailed"), cause));
    } finally {
      if (projectScopeRef.current === scope) setBusy("");
    }
  };
  const customizeDraft = () => {
    if (!draft) return;
    void duplicateWorkflow(draft);
  };

  if (!projectId)
    return (
      <EmptyState
        title={tr("workflowview.noProjectSelected")}
        description={tr("workflowview.openAProjectToBuildAgentWorkflows")}
        mark={<Icon.workflow />}
      />
    );
  if (loading && !draft)
    return (
    <div className="workflow-page workflow-loading" role="status">
        <Spinner size="md" /> {tr("workflowview.loading")}
      </div>
    );
  const inspector =
    selectedNode && draft ? (
      <NodeInspector
        node={selectedNode}
        models={modelsForHarness}
        recommendedModel={chatModel}
        harnessSlot={harnessSlot}
        projectId={projectId ?? ""}
        spaceId={projectSpaceId ?? ""}
        busy={!!busy || readOnlyPreview}
        onChange={(patch) => changeNode(selectedNode.id, patch)}
        onMove={(direction) => moveNode(selectedNode.id, direction)}
        onDelete={() => deleteNode(selectedNode.id)}
      />
    ) : (
      <div className="workflow-inspector-empty">
        {tr("workflowview.selectNodeHelp")}
      </div>
    );
  const errorBanner = error ? (
    <div
      className={`workflow-error ${
        saveState === "conflict" ? "conflict" : ""
      }`}
      role="alert"
    >
      <span>{error}</span>
      <Button size="sm" onClick={() => {
        if (libraryUnread) void load();
        else if ((saveState === "conflict" || saveState === "error") && draft) void save(clone(draft));
        else setError("");
      }}>
        {libraryUnread
          ? tr("common.retry")
          : saveState === "conflict" || saveState === "error" ? tr("workflowview.retrySave") : tr("workflowview.dismiss")}
      </Button>
    </div>
  ) : null;
  if (page === "library" || !draft) {
    // One list: a workflow is how a chat works with its agents, so everything
    // here is a template — the project's own first, then the bundled ones.
    const templateCount = savedWorkflows.length + presets.length;
    const visibleCount = visibleSaved.length + visiblePresets.length;
    return (
      <div ref={pageTop} className="workflow-page" data-page="library" data-shell-mode={shellMode} aria-busy={!!busy}>
        {errorBanner}
        <div className="workflow-library-toolbar">
          <TextInput
            type="search"
            className="workflow-library-search"
            aria-label={tr("workflowview.searchWorkflows")}
            placeholder={tr("workflowview.searchWorkflows")}
            value={presetSearch}
            onChange={(event) => setPresetSearch(event.target.value)}
          />
          <Button
            variant="primary"
            iconStart={PlusIcon}
            onClick={() => void createBlank()}
            disabled={!!busy}
          >
            {tr("workflowview.newWorkflow")}
          </Button>
        </div>
        <section className="workflow-shelf" aria-labelledby="workflow-shelf-templates">
          <h2 className="workflow-shelf-title" id="workflow-shelf-templates">
            {tr("workflowview.templates")}
            {templateCount > 0 && <span>{query ? visibleCount : templateCount}</span>}
          </h2>
          {visibleCount === 0 ? (
            <p className="workflow-library-empty">{tr("workflowview.noWorkflowsMatch")}</p>
          ) : (
            <div className="workflow-card-grid">
              {visibleSaved.map((workflow) => {
                const label = workflowCardLabel(workflow);
                return (
                  <WorkflowCard
                    key={workflow.id}
                    graph={workflow}
                    name={label.name}
                    description={label.description}
                    {...(label.example ? { badge: tr("workflowview.example") } : {})}
                    onOpen={() => void selectWorkflow(workflow.id)}
                    onCopy={() => void duplicateWorkflow(workflow)}
                  />
                );
              })}
              {visiblePresets.map((preset) => {
                const label = presetLabel(preset);
                return (
                  <WorkflowCard
                    key={preset.id}
                    graph={preset}
                    name={label.name}
                    description={label.description}
                    onOpen={() => openTemplate(preset)}
                    onCopy={() => void duplicateWorkflow(preset)}
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
    );
  }
  const draftLabel = readOnlyPreview
    ? { name: presetLabel(draft as PresetLike).name, example: false }
    : workflowCardLabel(draft);
  const moreActions: MenuEntry[] = [
    {
      id: "duplicate",
      label: tr("workflowview.duplicate"),
      icon: CopyIcon,
      disabled: !!busy || !canSave,
      onSelect: () => void duplicateWorkflow(draft),
    },
    "separator",
    {
      id: "delete",
      label: tr("workflowview.deleteWorkflow"),
      icon: DeleteIcon,
      danger: true,
      disabled: !selected || !!busy,
      onSelect: () => void deleteWorkflow(),
    },
  ];
  return (
    <div ref={pageTop} className="workflow-page" data-page="workflow" data-shell-mode={shellMode} aria-busy={!!busy}>
      <header className="workflow-detail-header">
        <IconButton
          icon={BackIcon}
          variant="ghost"
          className="workflow-back"
          label={tr("workflowview.allWorkflows")}
          title={tr("workflowview.allWorkflows")}
          onClick={() => void backToLibrary()}
        />
        <div className="workflow-detail-title">
          {readOnlyPreview ? (
            <h2>{draftLabel.name}</h2>
          ) : (
            <TextInput
              aria-label={tr("workflowview.workflowName")}
              value={draft.name}
              invalid={!draft.name.trim()}
              onChange={(event) =>
                mutateDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          )}
          {!readOnlyPreview && (
            <span className="workflow-save-state" data-state={saveState} role="status">
              {saveState === "saving"
                ? tr("workflowview.saving")
                : saveState === "saved"
                ? tr("workflowview.saved")
                : saveState === "conflict"
                ? tr("workflowview.conflict")
                : tr("workflowview.saveFailed")}
            </span>
          )}
        </div>
        <div className="workflow-detail-actions">
          {readOnlyPreview ? (
            <Button
              size="sm"
              variant="primary"
              iconStart={CopyIcon}
              onClick={customizeDraft}
              disabled={!!busy}
            >
              {tr("workflowview.customize")}
            </Button>
          ) : (
            <>
              <IconButton
                icon={UndoIcon}
                size="sm"
                variant="ghost"
                label={tr("workflowview.undo")}
                disabled={!undoStack.current.length || !!busy}
                onClick={undo}
              />
              <IconButton
                icon={RedoIcon}
                size="sm"
                variant="ghost"
                label={tr("workflowview.redo")}
                disabled={!redoStack.current.length || !!busy}
                onClick={redo}
              />
              <Menu label={tr("workflowview.moreWorkflowActions")} entries={moreActions} align="end">
                {(trigger) => (
                  <IconButton
                    {...trigger}
                    icon={MoreIcon}
                    size="sm"
                    variant="ghost"
                    label={tr("workflowview.moreWorkflowActions")}
                  />
                )}
              </Menu>
            </>
          )}
        </div>
      </header>
      <Tabs
        className="workflow-detail-tabs"
        idBase="workflow-detail"
        label={tr("workflowview.workflowSections")}
        value={tab}
        onChange={(next) => setTab(next as "run" | "edit")}
        tabs={[
          { id: "run", label: tr("workflowview.tabRun") },
          { id: "edit", label: tr("workflowview.tabEdit") },
        ]}
      />
      {errorBanner}
      {tab === "run" ? (
        <div
          className="workflow-tab-panel"
          role="tabpanel"
          id={tabPanelId("workflow-detail", "run")}
          aria-labelledby={tabId("workflow-detail", "run")}
        >
          {draft.description?.trim() && <p className="workflow-detail-description">{draft.description}</p>}
          <RunPanel
            run={shownRun}
            start={pendingStart}
            runInput={runInput}
            setRunInput={setRunInput}
            busy={busy}
            dirty={dirty}
            defaults={draft.defaults}
            onRun={(options, input) => void run(options, input)}
            onStop={() => void stop()}
            onRetry={retryNode}
            models={textModels}
            harnessSlot={harnessSlot}
            projectId={projectId ?? ""}
            spaceId={projectSpaceId ?? ""}
            anchorRef={runAnchor}
          />
        </div>
      ) : (
        <div
          className="workflow-tab-panel"
          role="tabpanel"
          id={tabPanelId("workflow-detail", "edit")}
          aria-labelledby={tabId("workflow-detail", "edit")}
        >
          {readOnlyPreview && (
            <div className="workflow-readonly-note">
              <span>{tr("workflowview.templateReadOnly")}</span>
              <Button size="sm" onClick={customizeDraft} disabled={!!busy}>
                {tr("workflowview.customize")}
              </Button>
            </div>
          )}
          <section className="workflow-builder" aria-labelledby="workflow-pipeline-title">
            <div className="workflow-builder-heading">
              <div>
                <h3 id="workflow-pipeline-title">{tr("workflowview.pipeline")}</h3>
                <p>{graphLayers?.ok ? graphMeta(draft) : graphError}</p>
              </div>
              {!readOnlyPreview && (
                <div className="workflow-builder-add" role="group" aria-label={tr("workflowview.addAgent")}>
                  <span className="workflow-builder-add-label">
                    <PlusIcon aria-hidden="true" />
                    {tr("workflowview.addAgent")}
                  </span>
                  <Button size="sm" variant="quiet" disabled={!!busy} aria-label={tr("workflowview.addAfterSelectedValue")} onClick={() => addNode("worker")}>
                    {tr("workflowview.afterSelected")}
                  </Button>
                  <Button size="sm" variant="quiet" disabled={!!busy} aria-label={tr("workflowview.addParallelSelectedValue")} onClick={() => addNode("worker", "parallel")}>
                    {tr("workflowview.parallelSelected")}
                  </Button>
                  <Button size="sm" variant="quiet" disabled={!!busy} aria-label={tr("workflowview.addBeforeSelectedValue")} onClick={() => addNode("worker", "before")}>
                    {tr("workflowview.beforeSelected")}
                  </Button>
                  <Button size="sm" variant="quiet" disabled={!!busy} aria-label={tr("workflowview.addReviewAfterValue")} onClick={() => addNode("review")}>
                    {tr("workflowview.reviewAfter")}
                  </Button>
                </div>
              )}
            </div>
            <div className="workflow-editing-area">
              <div
                className="workflow-canvas"
                data-layout={shellMode === "phone" ? "phone" : "desktop"}
              >
                <WorkflowGraphCanvas
                  graph={draft}
                  readOnly={readOnlyPreview || !!busy}
                  layers={graphLayers?.ok ? graphLayers.layers : []}
                  grouped={grouped}
                  expandedGroups={expandedGroups}
                  selectedNodeId={selectedNodeId}
                  onToggleGroup={(group) =>
                    setExpandedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group)) next.delete(group);
                      else next.add(group);
                      return next;
                    })
                  }
                  onAdjustGroup={adjustGroup}
                  onSelect={(id) => {
                    setSelectedNodeId(id);
                    setInspectorOpen(true);
                  }}
                />
              </div>
              <aside
                ref={inspectorRef}
                className="workflow-desktop-inspector"
                aria-label={tr("workflowview.nodeInspector")}
              >
                {inspector}
              </aside>
            </div>
          </section>
          <section className="workflow-details" aria-labelledby="workflow-details-title">
            <h3 id="workflow-details-title">{tr("workflowview.details")}</h3>
            <label className="workflow-field workflow-field-wide">
              <span>{tr("workflowview.description")}</span>
              <TextInput
                value={draft.description ?? ""}
                readOnly={readOnlyPreview}
                placeholder={tr("workflowview.whatWorkflowFor")}
                onChange={(event) =>
                  mutateDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </label>
          </section>
          <ResponsiveOverlay
            open={inspectorOpen && shellMode !== "wide"}
            onClose={() => setInspectorOpen(false)}
            title={tr("workflowview.nodeInspector")}
            phone="sheet"
            sheetSize="tall"
            className="workflow-inspector-sheet"
          >
            {inspector}
          </ResponsiveOverlay>
        </div>
      )}
    </div>
  );
}

function WorkflowCanvasCard({
  node,
  grouped,
  selected,
  expanded = false,
  onToggle,
  onSelect,
}: {
  node: WorkflowEditorNode;
  grouped?: { group: string; nodes: WorkflowNodeDto[] };
  selected: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
}) {
  const count = grouped?.nodes.length ?? 1;
  return (
    <button
      type="button"
      className={`workflow-canvas-node${selected ? " selected" : ""}`}
      onClick={() => {
        if (count > 1) onToggle?.();
        else onSelect();
      }}
      aria-pressed={selected}
      aria-expanded={count > 1 ? expanded : undefined}
    >
      <span className="workflow-node-kind">{workflowKindLabel(node.kind)}</span>
      <strong>{node.role || tr("workflowview.untitledRole")}</strong>
      <small>
        {node.harness?.mode === "pinned"
          ? node.harness.harnessId
          : tr("workflowview.projectHarness")}{" "}
        · {node.model?.modelID ?? tr("workflowview.defaultModel")}
      </small>
      {node.kind === "review" && (
        <small className="workflow-node-gate">
          <UndoIcon aria-hidden="true" />
          {tr("workflowview.reviewGateHint")}
        </small>
      )}
      {count > 1 && (
        <em>
          ×{count} · {tr("workflowview.parallelWorkers")}
          {expanded
            ? ` · ${grouped?.nodes.map((member) => member.role).join(", ")}`
            : ` · ${tr("workflowview.expand")}`}
        </em>
      )}
    </button>
  );
}

function WorkflowGraphCanvas({
  graph,
  readOnly,
  layers,
  grouped,
  expandedGroups,
  selectedNodeId,
  onToggleGroup,
  onAdjustGroup,
  onSelect,
}: {
  graph: Pick<WorkflowDto, "nodes" | "edges">;
  readOnly: boolean;
  layers: string[][];
  grouped: Array<{ group: string; nodes: WorkflowNodeDto[] }>;
  expandedGroups: Set<string>;
  selectedNodeId: string | null;
  onToggleGroup: (group: string) => void;
  onAdjustGroup: (group: string, count: number) => void;
  onSelect: (id: string) => void;
}) {
  const { byId, groupByNode, layerIndexOf } = useMemo(() => {
    const groups = new Map<string, (typeof grouped)[number]>();
    for (const entry of grouped)
      for (const member of entry.nodes) groups.set(member.id, entry);
    const layerOf = new Map<string, number>();
    layers.forEach((ids, index) => {
      for (const id of ids) layerOf.set(id, index);
    });
    return {
      byId: new Map(graph.nodes.map((node) => [node.id, node])),
      groupByNode: groups,
      layerIndexOf: layerOf,
    };
  }, [graph, grouped, layers]);
  if (!layers.length) {
    return <div className="workflow-canvas-empty">{tr("workflowview.addWorkerStart")}</div>;
  }
  const groupFor = (node: WorkflowNodeDto) =>
    node.group ? groupByNode.get(node.id) : undefined;
  const visibleLayerNodes = (ids: string[]) => {
    const seenGroups = new Set<string>();
    return ids.flatMap((id) => {
      const node = byId.get(id);
      if (!node) return [];
      const group = groupFor(node);
      if (!group || expandedGroups.has(group.group)) return [node];
      if (seenGroups.has(group.group)) return [];
      seenGroups.add(group.group);
      return [group.nodes[0]!];
    });
  };
  return (
    <div className="workflow-canvas-stages">
      {layers.map((ids, layerIndex) => {
        const nodes = visibleLayerNodes(ids);
        const firstVisibleByGroup = new Map<string, string>();
        for (const candidate of nodes)
          if (candidate.group && !firstVisibleByGroup.has(candidate.group))
            firstVisibleByGroup.set(candidate.group, candidate.id);
        const connectorEdges =
          layerIndex < layers.length - 1
            ? graph.edges.filter((edge) => {
                const sourceLayer = layerIndexOf.get(edge.source);
                const targetLayer = layerIndexOf.get(edge.target) ?? -1;
                return sourceLayer === layerIndex && targetLayer > layerIndex;
              })
            : [];
        return (
          <div className="workflow-canvas-stage-group" key={`stage-${layerIndex}`}>
            <div className="workflow-canvas-stage" data-layer={layerIndex + 1}>
              <span className="workflow-canvas-stage-label">{tr("workflowview.stageValue", { number: layerIndex + 1 })}</span>
              <div className="workflow-canvas-stage-nodes">
                {nodes.map((node) => {
                  const group = groupFor(node);
                  const expanded = !!group && expandedGroups.has(group.group);
                  const member = node;
                  const card = (
                    <WorkflowCanvasCard
                      key={member.id}
                      node={member}
                      grouped={expanded ? undefined : group}
                      expanded={expanded}
                      selected={member.id === selectedNodeId || (!!group && group.nodes.some((item) => item.id === selectedNodeId) && member.id === group.nodes[0]?.id)}
                      onToggle={group ? () => onToggleGroup(group.group) : undefined}
                      onSelect={() => onSelect(member.id)}
                    />
                  );
                  const firstVisibleMember = firstVisibleByGroup.get(group?.group ?? "");
                  if (!group || (expanded && member.id !== firstVisibleMember)) return card;
                  return (
                    <div className="workflow-canvas-group" key={member.id}>
                      {expanded && <Button size="sm" variant="ghost" onClick={() => onToggleGroup(group.group)}>{tr("workflowtimeline.collapseNodes")}</Button>}
                      {card}
                      {!readOnly && <div className="workflow-canvas-group-controls" aria-label={tr("workflowview.workerCountValue", { group: group.group })}>
                        <Button
                          size="sm"
                          variant="quiet"
                          aria-label={tr("workflowview.removeWorkerValue", { group: group.group })}
                          disabled={readOnly || group.nodes.length <= 1}
                          onClick={() => onAdjustGroup(group.group, group.nodes.length - 1)}
                        >−</Button>
                        <span aria-live="polite">{group.nodes.length}</span>
                        <Button
                          size="sm"
                          variant="quiet"
                          aria-label={tr("workflowview.addWorkerValue", { group: group.group })}
                          disabled={readOnly || group.nodes.length >= 50}
                          onClick={() => onAdjustGroup(group.group, group.nodes.length + 1)}
                        >+</Button>
                      </div>}
                    </div>
                  );
                })}
              </div>
            </div>
            {layerIndex < layers.length - 1 && (
              <div className="workflow-canvas-connector-list" aria-hidden="true">
                {connectorEdges.map((edge) => (
                  <span
                    className="workflow-canvas-connector"
                    data-edge-id={edge.id}
                    data-source={edge.source}
                    data-target={edge.target}
                    title={`${byId.get(edge.source)?.role ?? edge.source} → ${byId.get(edge.target)?.role ?? edge.target}`}
                    key={edge.id}
                  >→</span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const stripModel = (model: ModelRef & { harnessId?: string }): ModelRef => ({
  providerID: model.providerID,
  modelID: model.modelID,
  ...(model.variant ? { variant: model.variant } : {}),
});

interface RoutePatch {
  model?: ModelRef;
  harness?: HarnessSelection;
  allowedModels?: ModelRef[];
}

/** The composer's own model picker plus its harness-picker slot. Auto follows
 * the inherited chat route when compatible; an unrestricted node on a
 * different pinned harness lets that harness choose its default. Model pins
 * one. Both modes share one catalog owner (the runtime catalog). */
function WorkflowRoutePicker({
  value,
  models,
  recommended,
  disabled,
  header,
  allowAuto = false,
  onChange,
}: {
  value: RoutePatch;
  models: ModelDescriptor[];
  recommended?: ModelRef;
  disabled?: boolean;
  header?: ReactNode;
  allowAuto?: boolean;
  onChange: (patch: RoutePatch) => void;
}) {
  const auto =
    allowAuto &&
    (value.allowedModels !== undefined || (!value.model && !value.harness));
  const allowed = value.allowedModels ?? [];
  const harnessId =
    value.harness?.mode === "pinned" ? value.harness.harnessId : "";
  return (
    <div className="workflow-route-picker">
      {header ? <div className="workflow-route-harness">{header}</div> : null}
      <div className="workflow-route-controls">
        {allowAuto ? (
          <div className="workflow-route-mode" role="group" aria-label={tr("workflowview.model")}>
            <button
              type="button"
              className={`config-chip${auto ? " on" : ""}`}
              aria-pressed={auto}
              disabled={disabled}
              onClick={() => onChange({ allowedModels: [], model: undefined })}
            >
              {tr("composer.auto")}
            </button>
            <button
              type="button"
              className={`config-chip${auto ? "" : " on"}`}
              aria-pressed={!auto}
              disabled={disabled}
              onClick={() =>
                onChange({
                  allowedModels: undefined,
                  // Leaving the inherited route needs a concrete model to pin;
                  // otherwise the node would read as unassigned again.
                  ...(!value.model && recommended ? { model: recommended } : {}),
                })
              }
            >
              {tr("workflowview.model")}
            </button>
          </div>
        ) : null}
        {auto ? (
          <fieldset className="workflow-model-fieldset" disabled={disabled}>
            <ModelPicker
              models={models}
              {...(harnessId ? { harnessId } : {})}
              selection={allowed}
              maxSelection={24}
              emptyLabel={tr("workflowview.anyAllowedModel")}
              direction="down"
              onPick={() => onChange({ allowedModels: [] })}
              onToggle={(model) => {
                const ref = stripModel(model);
                onChange({
                  allowedModels: allowed.some((entry) => sameModel(entry, ref))
                    ? allowed.filter((entry) => !sameModel(entry, ref))
                    : [...allowed, ref],
                });
              }}
            />
          </fieldset>
        ) : (
          <fieldset className="workflow-model-fieldset" disabled={disabled}>
            <ModelPicker
              models={models}
              {...(harnessId ? { harnessId } : {})}
              {...(value.model ? { value: value.model } : {})}
              {...(recommended ? { recommended } : {})}
              direction="down"
              onPick={(model) => {
                if (!model || disabled) return;
                onChange({
                  model: stripModel(model),
                  ...(model.harnessId && model.harnessId !== harnessId
                    ? { harness: { mode: "pinned" as const, harnessId: model.harnessId } }
                    : {}),
                });
              }}
            />
          </fieldset>
        )}
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  models,
  recommendedModel,
  harnessSlot,
  projectId,
  spaceId,
  busy,
  onChange,
  onMove,
  onDelete,
}: {
  node: WorkflowNodeDto;
  models: ModelDescriptor[];
  recommendedModel?: ModelRef;
  harnessSlot?: (context: Record<string, unknown>) => ReactNode;
  projectId: string;
  spaceId: string;
  busy: boolean;
  onChange: (patch: Partial<WorkflowNodeDto>) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const nodeModels = models.filter(modelSupportsTextWorkflow);
  const selectedHarness = harnessValue(node.harness);
  const harnessHeader = harnessSlot?.({
    projectId: projectId || undefined,
    spaceId: spaceId || undefined,
    harnessSelection: node.harness ?? { mode: "auto" },
    ...(selectedHarness ? { resolvedHarnessId: selectedHarness } : {}),
    onSelectHarness: (selection: HarnessSelection) => {
      if (busy) return;
      const harness = selection.mode === "pinned" ? selection : undefined;
      const changed = harnessValue(node.harness) !== harnessValue(harness);
      // A model from the previous harness is no longer a valid route.
      onChange(changed ? { harness, model: undefined, allowedModels: node.allowedModels === undefined ? undefined : [] } : { harness });
    },
  });
  return (
    <div className="workflow-inspector">
      <div className="workflow-inspector-heading">
        <div>
          <span className="stat-label">{tr("workflowview.nodeInspector")}</span>
          <h3>{node.role || tr("workflowview.untitledRole")}</h3>
        </div>
        <div>
          <IconButton
            icon={ChevronUpIcon}
            size="sm"
            label={tr("workflowview.moveNodeUpValue", { role: node.role })}
            onClick={() => onMove(-1)}
            disabled={busy}
          />
          <IconButton
            icon={ChevronDownIcon}
            size="sm"
            label={tr("workflowview.moveNodeDownValue", { role: node.role })}
            onClick={() => onMove(1)}
            disabled={busy}
          />
          <IconButton
            icon={DeleteIcon}
            variant="danger"
            size="sm"
            label={tr("workflowview.deleteNodeValue", { role: node.role })}
            onClick={onDelete}
            disabled={busy}
          />
        </div>
      </div>
      <label className="workflow-field">
        <span>{tr("workflowview.role")}</span>
        <TextInput
          value={node.role}
          onChange={(event) => onChange({ role: event.target.value })}
          disabled={busy}
        />
      </label>
      <label className="workflow-field">
        <span>{tr("workflowview.instructions")}</span>
        <Textarea
          minRows={7}
          value={node.prompt}
          onChange={(event) => onChange({ prompt: event.target.value })}
          disabled={busy}
        />
      </label>
      <div className="workflow-inspector-grid">
        <div className="workflow-field workflow-model-field" role="group" aria-label={tr("workflowview.model")}>
          <WorkflowRoutePicker
            value={{
              ...(node.model ? { model: node.model } : {}),
              ...(node.harness ? { harness: node.harness } : {}),
              ...(node.allowedModels !== undefined ? { allowedModels: node.allowedModels } : {}),
            }}
            models={nodeModels}
            {...(recommendedModel ? { recommended: recommendedModel } : {})}
            disabled={busy}
            {...(harnessHeader ? { header: harnessHeader } : {})}
            allowAuto
            onChange={onChange}
          />
        </div>
      </div>
      <label className="workflow-field">
        <span>{tr("workflowview.kind")}</span>
        <Select
          label={tr("workflowview.nodeKind")}
          value={node.kind ?? "worker"}
          options={[
            { value: "lead", label: tr("workflowview.lead") },
            { value: "worker", label: tr("workflowview.worker") },
            { value: "review", label: tr("workflowview.reviewer") },
          ]}
          onChange={(value) =>
            onChange({ kind: value as WorkflowNodeDto["kind"] })
          }
          disabled={busy}
        />
        <small className="workflow-field-help">{tr("workflowview.kindHelp")}</small>
      </label>
    </div>
  );
}

function workflowKindLabel(kind: WorkflowNodeDto["kind"]): string {
  return tr(kind === "lead" ? "workflowview.lead" : kind === "review" ? "workflowview.reviewer" : "workflowview.worker");
}

type RetryFn = (
  nodeId: string,
  replacement?: Pick<WorkflowNodeDto, "model" | "harness" | "agent">,
  saveToWorkflow?: boolean
) => void;

/** Another route for a failed unit: while the run holds the unit it
 * continues in place, after the run settled it forks. Either way the new
 * route can be kept on the template for every later run. */
function RetryControls({
  node, runStatus, busy, models, harnessSlot, projectId, spaceId, onRetry,
}: {
  node: WorkflowRunDto["nodes"][number];
  runStatus: WorkflowRunStatus;
  busy: boolean;
  models: ModelDescriptor[];
  harnessSlot?: (context: Record<string, unknown>) => ReactNode;
  projectId: string;
  spaceId: string;
  onRetry: RetryFn;
}) {
  const agents = useStore((state) => state.agents);
  const [replacementModel, setReplacementModel] = useState<ModelRef>();
  const [replacementHarness, setReplacementHarness] = useState<HarnessSelection>();
  const [saveToWorkflow, setSaveToWorkflow] = useState(true);
  const held = workflowNeedsFix(node);
  const targetHarness = replacementHarness ?? node.harness;
  const harnessId = targetHarness?.mode === "pinned" ? targetHarness.harnessId : undefined;
  const catalog = useRuntimeCatalog(null, models, agents, {
    ...(projectId ? { projectId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(harnessId ? { harnessId } : {}),
  });
  const available = catalog.models.filter(modelSupportsTextWorkflow);
  const harnessChanged = !!replacementHarness && harnessValue(replacementHarness) !== harnessValue(node.harness);
  const needsModel = harnessChanged && !!node.model &&
    !available.some((model) => sameModel(model, node.model));
  const modelChanged = !!replacementModel
    && (!sameModel(replacementModel, node.model) || replacementModel.variant !== node.model?.variant);
  const replacement = modelChanged || harnessChanged
    ? {
        ...(replacementModel ? { model: replacementModel } : {}),
        ...(harnessChanged && targetHarness ? { harness: targetHarness } : {}),
      }
    : undefined;
  const changed = !!replacement;
  const disabled = busy || (runStatus === "running" && !held);
  const header = harnessSlot?.({
    projectId: projectId || undefined,
    spaceId: spaceId || undefined,
    harnessSelection: targetHarness ?? { mode: "auto" },
    ...(harnessId ? { resolvedHarnessId: harnessId } : {}),
    onSelectHarness: (selection: HarnessSelection) => {
      if (disabled) return;
      setReplacementHarness(selection);
      setReplacementModel(undefined);
    },
  });
  return (
    <div className="workflow-retry-controls">
      <WorkflowRoutePicker
        value={{
          ...(replacementModel ? { model: replacementModel } : node.model ? { model: node.model } : {}),
          ...(targetHarness ? { harness: targetHarness } : {}),
        }}
        models={available}
        disabled={disabled}
        {...(header ? { header } : {})}
        onChange={(patch) => {
          if (patch.harness) setReplacementHarness(patch.harness);
          setReplacementModel(patch.model);
        }}
      />
      {changed && (
        <Checkbox
          className="workflow-retry-save"
          checked={saveToWorkflow}
          disabled={disabled}
          onChange={setSaveToWorkflow}
          label={tr("workflowview.useForFutureRuns")}
        />
      )}
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          if (disabled || (needsModel && !replacementModel)) return;
          onRetry(node.id, replacement, changed && saveToWorkflow);
        }}
        disabled={disabled || (needsModel && !replacementModel)}
      >
        {tr(held ? "workflowview.continueRun" : "workflowview.retryFailedNode")}
      </Button>
    </div>
  );
}

/** What a unit waits on a person for; never a spinner or a check, so a
 * request cannot pass for work in progress or for finished work. */
function HumanWaitIcon({ wait }: { wait: "permission" | "answer" }) {
  return wait === "permission" ? <ShieldAlertIcon aria-hidden="true" /> : <Icon.question />;
}

const openWorkflowChild = (sessionId: string): void => {
  window.dispatchEvent(new CustomEvent("polyth:workflow-open-session", { detail: sessionId }));
};

function UnitStatusIcon({ node }: { node: WorkflowRunNodeDto }) {
  const wait = workflowHumanWait(node);
  if (wait) return <HumanWaitIcon wait={wait} />;
  if (workflowNeedsFix(node)) return <WrenchIcon />;
  if (node.status === "done") return node.verdict === "changes-requested" ? <UndoIcon /> : node.judgment?.verdict === "uncertain" ? <Icon.question /> : <Icon.check />;
  if (node.status === "error") return <Icon.close />;
  if (node.status === "stopped") return <Icon.stop />;
  if (node.status === "skipped") return <Icon.branch />;
  if (node.status === "running") return <Spinner size="sm" />;
  return <Icon.clock />;
}

/** One execution unit inside a stage. The row reads as a sentence: role,
 * round, verdict, then what it is doing; the report stays folded. */
function RunUnit({
  run,
  node,
  busy,
  models,
  harnessSlot,
  projectId,
  spaceId,
  onRetry,
}: {
  run: WorkflowRunDto;
  node: WorkflowRunNodeDto;
  busy: string;
  models: ModelDescriptor[];
  harnessSlot?: (context: Record<string, unknown>) => ReactNode;
  projectId: string;
  spaceId: string;
  onRetry: RetryFn;
}) {
  const wait = workflowHumanWait(node);
  const held = workflowNeedsFix(node);
  const decide = workflowNeedsDecision(node);
  const output = workflowDisplayText(node.output);
  const sentBack = workflowSentBackRoles(run, node);
  const detail = workflowHumanWaitLabel(node)
    ?? (held ? tr("workflowtimeline.waitingForYourFix") : undefined)
    ?? (node.status === "running" ? node.activity : undefined)
    ?? (node.status === "queued" ? tr("workflowtimeline.waitingForDependencies") : undefined)
    ?? (node.status === "done" && sentBack.length ? tr("workflowview.sentBackTo", { roles: sentBack.join(", ") }) : undefined)
    ?? (node.status === "done" ? undefined : workflowStatusLabel(node.status));
  return (
    <li className={`workflow-run-unit status-${node.status}${wait || held || decide ? " needs-human" : ""}${held ? " needs-fix" : ""}`}>
      <span className="workflow-run-unit-icon" aria-hidden="true"><UnitStatusIcon node={node} /></span>
      <div className="workflow-run-unit-body">
        <div className="workflow-run-unit-heading">
          <strong>{node.role}</strong>
          <span className="sr-only">{workflowStatusLabel(node.status)}</span>
          {node.roundLimit && ((node.round ?? 1) > 1 || node.verdict === "changes-requested") ? (
            <Badge className="workflow-run-unit-round">
              {tr("workflowview.reviewRoundOf", { round: formatNumber(node.round!), limit: formatNumber(node.roundLimit) })}
            </Badge>
          ) : (node.round ?? 1) > 1 && <Badge className="workflow-run-unit-round">{workflowRoundLabel(node.round!)}</Badge>}
          {!node.verdict && node.judgment?.verdict === "uncertain" && node.status === "done" && (
            <Badge tone="warning" className="workflow-run-unit-verdict">
              {workflowVerdictLabel("uncertain")}
            </Badge>
          )}
          {node.verdict && node.status === "done" && (
            <Badge tone={node.verdict === "approved" ? "success" : "warning"} className="workflow-run-unit-verdict">
              {workflowVerdictLabel(node.verdict)}
            </Badge>
          )}
          {node.judgment && node.status === "done" && (
            <Badge tone="neutral" className="workflow-run-unit-judged">
              {workflowJudgedLabel(node.judgment)}
            </Badge>
          )}
        </div>
        {detail && (
          <span className={`workflow-node-activity${wait || held || decide ? " needs-human" : ""}`}>{detail}</span>
        )}
        {node.error && <div className={held ? "form-warning" : "form-error"}>{node.error}</div>}
        {node.status === "done" && node.findings && node.findings.length > 0 && (
          <ReviewFindings findings={decide ? node.findings.filter((finding) => finding.severity !== "blocker") : node.findings} />
        )}
        {node.decision && node.decision !== "another-round" && (
          <span className="workflow-node-activity">
            {tr(node.decision === "accepted" ? "workflowview.reviewAccepted" : "workflowview.reviewTimedOut")}
          </span>
        )}
        {node.needsDecision && <ReviewDecision run={run} node={node} />}
        {output && (
          <details className="workflow-run-unit-report">
            <summary>{tr("workflowview.report")}</summary>
            <pre className="workflow-node-output">{output}</pre>
          </details>
        )}
        {node.retryable && node.status === "error" && (run.status !== "running" || held) && (
          <RetryControls
            node={node}
            runStatus={run.status}
            busy={!!busy}
            models={models}
            harnessSlot={harnessSlot}
            projectId={projectId}
            spaceId={spaceId}
            onRetry={onRetry}
          />
        )}
      </div>
      {node.sessionId && (
        <Button
          size="sm"
          variant={wait ? "primary" : "quiet"}
          className="workflow-open-session"
          onClick={() => openWorkflowChild(node.sessionId!)}
        >
          {tr(wait ? "workflowview.reviewAndRespond" : "workflowview.openChildSession")}
        </Button>
      )}
    </li>
  );
}

/** A launch between Run and admission: the request stays in view with live
 * progress, and a failed start explains itself and resends the same request. */
function StartingRun({
  start,
  anchorRef,
}: {
  start: WorkflowStart;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const failed = start.status === "failed";
  const title = tr(failed ? "workflowlauncher.couldNotStart" : "workflowlauncher.startingWorkflow");
  return (
    <section
      className={`workflow-run-results workflow-run-starting${failed ? " failed" : ""}`}
      ref={anchorRef}
      aria-busy={!failed}
    >
      <div className="workflow-run-heading">
        <h3>{title}</h3>
        {failed ? <StatusBadge status="error" /> : <Spinner size="sm" />}
      </div>
      {start.input.trim() && <p className="workflow-run-request">{start.input}</p>}
      {failed ? (
        <div className="workflow-run-notice error" role="alert">
          <Icon.stop />
          <span>{start.error}</span>
        </div>
      ) : (
        <div className="workflow-run-progress status-starting" role="progressbar" aria-label={title}>
          <span />
        </div>
      )}
      {failed && (
        <div className="workflow-run-actions">
          <Button
            size="sm"
            variant="primary"
            iconStart={WorkflowIcon}
            onClick={() => { void retryWorkflowStart(start.parentSessionId)?.catch(() => undefined); }}
          >
            {tr("common.retry")}
          </Button>
        </div>
      )}
    </section>
  );
}

function RunPanel({
  run,
  start,
  runInput,
  setRunInput,
  busy,
  dirty,
  defaults,
  onRun,
  onStop,
  onRetry,
  models,
  harnessSlot,
  projectId,
  spaceId,
  anchorRef,
}: {
  run: WorkflowRunDto | null;
  start?: WorkflowStart;
  runInput: string;
  setRunInput: (value: string) => void;
  busy: string;
  dirty: boolean;
  defaults?: WorkflowRunOptionsDto;
  onRun: (options?: WorkflowRunOptionsDto, input?: string) => void;
  onStop: () => void;
  onRetry: RetryFn;
  models: ModelDescriptor[];
  harnessSlot?: (context: Record<string, unknown>) => ReactNode;
  projectId: string;
  spaceId: string;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const [options, setOptions] = useState<WorkflowRunOptionsDto>(RUN_OPTION_DEFAULTS);
  useEffect(() => {
    setOptions({ ...RUN_OPTION_DEFAULTS, ...defaults });
  }, [defaults]);
  const maxParallelValid =
    Number.isInteger(options.maxParallel ?? NaN) &&
    (options.maxParallel ?? 0) >= 1 &&
    (options.maxParallel ?? 0) <= 32;
  const timeoutValid =
    Number.isFinite(options.nodeTimeoutMs ?? NaN) &&
    (options.nodeTimeoutMs ?? 0) >= 1000;
  const invalidRunOptions = !maxParallelValid || !timeoutValid;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsId = useId();
  const setOption = <K extends keyof WorkflowRunOptionsDto>(
    key: K,
    value: WorkflowRunOptionsDto[K]
  ) => setOptions((current) => ({ ...current, [key]: value }));
  const reviewRounds = options.reviewRounds ?? DEFAULT_REVIEW_ROUNDS;
  const optionsForm = (
    <div className="workflow-run-options">
      <label className="workflow-field">
        <span>{tr("workflowview.permissions")}</span>
        <Select
          label={tr("workflowview.permissions")}
          value={options.permissions ?? "manual"}
          options={[
            { value: "manual", label: tr("workflowview.manualReview") },
            { value: "auto", label: tr("workflowview.autoApprove") },
          ]}
          onChange={(value) =>
            setOption(
              "permissions",
              value as WorkflowRunOptionsDto["permissions"]
            )
          }
        />
      </label>
      <label className="workflow-field">
        <span>{tr("workflowview.reviewRounds")}</span>
        <Select
          label={tr("workflowview.reviewRounds")}
          value={String(reviewRounds)}
          options={Array.from({ length: MAX_REVIEW_ROUNDS + 1 }, (_, rounds) => ({
            value: String(rounds),
            label: workflowReviewRoundsLabel(rounds),
          }))}
          onChange={(value) => setOption("reviewRounds", Number(value))}
        />
        <small className="workflow-field-help">{tr("workflowview.reviewRoundsHelp")}</small>
      </label>
      <label className="workflow-field">
        <span>{tr("workflowview.parallelWorkers")}</span>
        <TextInput
          type="number"
          min={1}
          max={32}
          step={1}
          value={Number.isFinite(options.maxParallel ?? NaN) ? String(options.maxParallel) : ""}
          onChange={(event) =>
            setOption("maxParallel", Number(event.target.value))
          }
        />
      </label>
      <label className="workflow-field">
        <span>{tr("workflowview.timeoutSeconds")}</span>
        <TextInput
          type="number"
          min={1}
          step={1}
          value={Number.isFinite(options.nodeTimeoutMs ?? NaN)
            ? String((options.nodeTimeoutMs ?? 0) / 1000)
            : ""}
          onChange={(event) =>
            setOption("nodeTimeoutMs", Number(event.target.value) * 1000)
          }
        />
      </label>
    </div>
  );
  const runForm = (
    <section className="workflow-run-form" ref={run ? undefined : anchorRef} aria-labelledby="workflow-run-form-title">
      <h3 id="workflow-run-form-title">{tr("workflowview.newRun")}</h3>
      <Textarea
        minRows={3}
        value={runInput}
        aria-labelledby="workflow-run-form-title"
        onChange={(event) => setRunInput(event.target.value)}
        placeholder={tr("workflowview.describeTask")}
      />
      <button
        type="button"
        className="workflow-run-options-toggle"
        aria-expanded={optionsOpen}
        aria-controls={optionsId}
        onClick={() => setOptionsOpen((open) => !open)}
      >
        <ChevronDownIcon aria-hidden="true" />
        {tr("workflowview.runOptions")}
        <span>
          {options.permissions === "auto" ? tr("workflowview.autoApprove") : tr("workflowview.manualReview")}
          {" · "}
          {workflowReviewRoundsLabel(reviewRounds)}
        </span>
      </button>
      <div id={optionsId} className="workflow-run-options-panel" hidden={!optionsOpen}>
        {optionsForm}
      </div>
      <div className="workflow-run-footer">
        {dirty && <span className="muted">{tr("workflowview.saveChangesBeforeRunning")}</span>}
        <Button
          variant="primary"
          iconStart={WorkflowIcon}
          disabled={dirty || !runInput.trim() || !!busy || invalidRunOptions}
          onClick={() => onRun(options)}
        >
          {tr("workflowview.runWorkflow")}
        </Button>
      </div>
    </section>
  );
  if (start) return <StartingRun start={start} anchorRef={anchorRef} />;
  if (!run) return runForm;
  const finished = workflowFinishedCount(run);
  const result = workflowDisplayText(run.result);
  const unresolved = workflowUnresolvedReviews(run);
  const uncertainReviews = workflowUncertainReviews(run);
  // Stages come from the run's own schedule, so a run and its definition can
  // never disagree about who ran together.
  const placed = new Set(run.layers.flat());
  const stages = [
    ...run.layers.map((ids) => ids.map((id) => run.nodes.find((node) => node.id === id)).filter((node): node is WorkflowRunNodeDto => !!node)),
    run.nodes.filter((node) => !placed.has(node.id)),
  ].filter((stage) => stage.length > 0);
  // A done run keeps its one-click Run again. After a failed or stopped run the
  // next run is a new, explicit request: the form shows the task and options
  // before anything launches, and the failed run itself stays untouched.
  const showsRunForm = run.status === "error" || run.status === "stopped";
  // The request itself lives in the unit's own chat; lead with it so a person
  // who came here for "Approval needed" never has to search the stages.
  const waiting = run.nodes.filter((node) => workflowHumanWait(node) !== null);
  // A held unit is fixed right in its own row below; this only says so.
  const held = run.status === "running" ? run.nodes.filter(workflowNeedsFix) : [];
  return (
    <>
    <section className="workflow-run-results" ref={anchorRef}>
      <div className="workflow-run-heading">
        <h3>{tr("workflowview.latestRun")}</h3>
        <span className="workflow-run-count">
          {tr("workflowview.completeCount", { complete: finished, total: run.nodes.length })}
        </span>
        <StatusBadge status={run.status} />
      </div>
      {waiting.length > 0 && (
        <ul className="workflow-run-requests" role="status" aria-label={tr("workflowtimeline.waitingOne", { count: waiting.length })}>
          {waiting.map((node) => (
            <li key={node.id} className={`workflow-run-notice waiting needs-human wait-${workflowHumanWait(node)}`}>
              <HumanWaitIcon wait={workflowHumanWait(node)!} />
              <span><strong>{node.role}</strong> · {workflowHumanWaitLabel(node)}</span>
              {node.sessionId && (
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={tr("workflowtimeline.reviewAndRespondValue", { role: node.role })}
                  onClick={() => openWorkflowChild(node.sessionId!)}
                >
                  {tr("workflowview.reviewAndRespond")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {held.length > 0 && (
        <div className="workflow-run-notice waiting needs-human wait-fix" role="status">
          <WrenchIcon aria-hidden="true" />
          <span>{tr("workflowview.runHeldValue", { roles: held.map((node) => node.role).join(", ") })}</span>
        </div>
      )}
      {run.input?.trim() && <p className="workflow-run-request">{run.input}</p>}
      <div
        className={`workflow-run-progress status-${run.status}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={run.nodes.length}
        aria-valuenow={finished}
      >
        <span
          style={{
            width: `${
              run.nodes.length ? (finished / run.nodes.length) * 100 : 0
            }%`,
          }}
        />
      </div>
      {run.interrupted && (
        <div className="workflow-run-notice">
          <Icon.stop />
          <span>{tr("workflowview.interruptedRetained")}</span>
        </div>
      )}
      {unresolved.length > 0 && (
        <div className="workflow-run-notice waiting" role="status">
          <UndoIcon aria-hidden="true" />
          <span>{tr("workflowview.reviewUnresolvedValue", { roles: unresolved.map((node) => node.role).join(", ") })}</span>
        </div>
      )}
      {uncertainReviews.length > 0 && (
        <div className="workflow-run-notice waiting" role="status">
          <Icon.question aria-hidden="true" />
          <span>{tr("workflowview.reviewUncertainValue", { roles: uncertainReviews.map((node) => node.role).join(", ") })}</span>
        </div>
      )}
      <ol className="workflow-run-stages">
        {stages.map((stage, index) => (
          <li className="workflow-run-stage" key={stage.map((node) => node.id).join("+")}>
            <span className="workflow-run-stage-label">{tr("workflowview.stageValue", { number: index + 1 })}</span>
            <ul className="workflow-run-units">
              {stage.map((node) => (
                <RunUnit
                  key={node.id}
                  run={run}
                  node={node}
                  busy={busy}
                  models={models}
                  harnessSlot={harnessSlot}
                  projectId={projectId}
                  spaceId={spaceId}
                  onRetry={onRetry}
                />
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {result && (
        <div className="workflow-run-outcome">
          <h4>{tr("workflowtimeline.result")}</h4>
          <pre className="workflow-run-result">{result}</pre>
        </div>
      )}
      <div className="workflow-run-actions">
        {run.status === "running" ? (
          <Button
            size="sm"
            variant="danger"
            iconStart={StopIcon}
            onClick={onStop}
            disabled={!!busy}
          >
            {tr("workflowview.stopRun")}
          </Button>
        ) : run.status === "done" ? (
          <Button
            size="sm"
            variant="primary"
            iconStart={WorkflowIcon}
            onClick={() => onRun(run.options, run.input)}
            disabled={dirty || !!busy || invalidRunOptions}
          >
            {tr("workflowview.runAgain")}
          </Button>
        ) : null}
        {run.parentSessionId && <Button size="sm" variant="quiet" onClick={() =>
          window.dispatchEvent(new CustomEvent("polyth:workflow-open-session", { detail: run.parentSessionId }))
        }>{tr("workflowview.openParentChat")}</Button>}
      </div>
    </section>
    {showsRunForm && runForm}
    </>
  );
}
