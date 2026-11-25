import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  HarnessSelection,
  ModelDescriptor,
  ModelRef,
  WorkflowDto,
  WorkflowPreferencesDto,
  WorkflowNodeDto,
  WorkflowRunOptionsDto,
} from "@polyth/contracts";
import { onConnectionRestored } from "@polyth/contracts/transport-retry";
import { api } from "@polyth/session/web-api";
import { modelSupportsTextWorkflow } from "../../../apps/web/src/composer/discovery.ts";
import ModelPicker from "@polyth/models/model-picker";
import { useRuntimeCatalog } from "@polyth/models/runtime-catalog";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { getState, useStore } from "../../../apps/web/src/store.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import {
  BackIcon,
  Button,
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
  Spinner,
  Textarea,
  TextInput,
  UndoIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  orderWorkflows,
  workflowPresets,
} from "../src/presets.ts";
import { WORKFLOW_ROUTING_ROLES, workflowRoleLabel } from "./workflowLabels.ts";
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
import { subscribeWorkflowLaunches, takeWorkflowLaunch } from "./workflowLaunch.ts";
import {
  workflowPresetDescription,
  workflowPresetName,
  workflowTopology,
  workflowCardLabel,
  workflowNodeRouteText,
} from "./workflowLabels.ts";
import {
  shouldAdoptWorkflowSnapshot,
  shouldApplyWorkflowSave,
} from "./workflowSave.ts";
import {
  workflowReviewRoundsLabel,
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
type PresetLike = WorkflowDto & {
  id: string;
  version?: number;
  category?: string;
  description?: string;
  builtin?: boolean;
  preset?: { id: string; version: number };
};
/** Choosing "Off" leaves `routingRole` undefined; the key itself must go so the
 * saved unit really has no role. */
function withoutUnsetRole(node: WorkflowNodeDto): WorkflowNodeDto {
  if (node.routingRole !== undefined) return node;
  const { routingRole: _unset, ...rest } = node;
  return rest;
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
  // The library is its own page; a chosen workflow replaces it (back returns).
  const [page, setPage] = useState<"library" | "workflow">("library");
  const [presetSearch, setPresetSearch] = useState("");
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
  const graphError = graphLayers && !graphLayers.ok ? graphLayers.error : "";
  const canSave = !!draft && !!draft.name.trim() && !graphError
    && runDefaultsValid({ ...RUN_OPTION_DEFAULTS, ...draft.defaults })
    && draft.nodes.every((node) => node.role.trim() && node.prompt.trim());

  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    editVersion.current += 1;
    setSaveState("saved");
    setInspectorOpen(false);
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
      setLoading(false);
      return;
    }
    const sequence = ++requestVersion.current;
    setLoading(true);
    setError("");
    setLoadFailed(false);
    try {
      const [items, prefs] = await Promise.all([
        api.listWorkflows(projectId),
        api.getWorkflowPreferences(projectId),
      ]);
      if (sequence !== requestVersion.current) return;
      const launch = takeWorkflowLaunch(projectId);
      const ordered = orderWorkflows(items, prefs);
      setPreferences(prefs);
      setWorkflows(ordered);
      // Opened from a run card or the composer with a template to show: that
      // template's settings lead. Otherwise the surface opens on the library.
      const initial = launch
        ? items.find((item) => item.id === launch.workflowId) ?? null
        : null;
      setPage(initial ? "workflow" : "library");
      setSelectedId(initial?.id ?? null);
      setDraft(initial ? clone(initial) : null);
      setSelectedNodeId(initial?.nodes[0]?.id ?? null);
      setExpandedGroups(new Set());
      loadedRevision.current = initial?.revision ?? 0;
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
  useEffect(() => {
    setWorkflows((current) => orderWorkflows(current, preferences));
  }, [preferences]);
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
  const showWorkflow = (value: WorkflowDto, savedId: string | null = value.id) => {
    setSelectedId(savedId);
    setDraft(clone(value));
    setSelectedNodeId(value.nodes[0]?.id ?? null);
    setExpandedGroups(new Set());
    loadedRevision.current = value.revision ?? 0;
    setPage("workflow");
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
      showWorkflow(created);
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
  const openTemplate = (preset: PresetLike) => showWorkflow(preset, null);
  const changeNode = (id: string, patch: Partial<WorkflowNodeDto>) =>
    mutateDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === id ? withoutUnsetRole({ ...node, ...patch }) : node
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
    showWorkflow(next);
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
      {errorBanner}
      <div className="workflow-tab-panel">
        <p className="workflow-started-from muted">{tr("workflowview.startedFromChat")}</p>
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
          <section className="workflow-details" aria-labelledby="workflow-defaults-title">
            <h3 id="workflow-defaults-title">{tr("workflowview.runDefaults")}</h3>
            <p className="workflow-field-help">{tr("workflowview.runDefaultsHelp")}</p>
            <RunDefaults
              value={draft.defaults}
              readOnly={readOnlyPreview}
              onChange={(defaults) => mutateDraft((current) => ({ ...current, defaults }))}
            />
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
        {workflowNodeRouteText(node)}
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

export const sameModel = (left?: ModelRef, right?: ModelRef): boolean =>
  !!left && !!right && left.providerID === right.providerID && left.modelID === right.modelID;
export const harnessValue = (value?: HarnessSelection) =>
  value?.mode === "pinned" ? value.harnessId : "";

export const stripModel = (model: ModelRef & { harnessId?: string }): ModelRef => ({
  providerID: model.providerID,
  modelID: model.modelID,
  ...(model.variant ? { variant: model.variant } : {}),
});

export interface RoutePatch {
  model?: ModelRef;
  harness?: HarnessSelection;
  allowedModels?: ModelRef[];
}

/** The composer's own model picker plus its harness-picker slot. Auto follows
 * the inherited chat route when compatible; an unrestricted node on a
 * different pinned harness lets that harness choose its default. Model pins
 * one. Both modes share one catalog owner (the runtime catalog). */
export function WorkflowRoutePicker({
  value,
  models,
  recommended,
  disabled,
  header,
  allowAuto = false,
  routingRole,
  onRoleChange,
  onChange,
}: {
  routingRole?: string;
  onRoleChange?: (role: string | undefined) => void;
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
      {onRoleChange ? (
        <div className="workflow-route-role">
          <label className="workflow-field">
            <span>{tr("workflowview.routingRole")}</span>
            <Select
              label={tr("workflowview.routingRole")}
              value={routingRole ?? "off"}
              options={[
                { value: "off", label: tr("workflowview.routingRoleOff") },
                ...[...WORKFLOW_ROUTING_ROLES, ...(routingRole && !(WORKFLOW_ROUTING_ROLES as readonly string[]).includes(routingRole) ? [routingRole] : [])]
                  .map((id) => ({ value: id, label: workflowRoleLabel(id) })),
              ]}
              onChange={(next) => onRoleChange(next === "off" ? undefined : next)}
              disabled={disabled}
            />
            <small className="workflow-field-help">{tr("workflowview.routingRoleHelp")}</small>
          </label>
          {routingRole ? (
            <small className="workflow-route-fallback">{tr("workflowview.routingFallback")}</small>
          ) : null}
        </div>
      ) : null}
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
            {...(node.routingRole ? { routingRole: node.routingRole } : {})}
            onRoleChange={(role) => onChange({ routingRole: role })}
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

/** True when the options a run would start with are acceptable. */
const runDefaultsValid = (options: WorkflowRunOptionsDto): boolean =>
  Number.isInteger(options.maxParallel ?? NaN) && (options.maxParallel ?? 0) >= 1 && (options.maxParallel ?? 0) <= 32
  && Number.isFinite(options.nodeTimeoutMs ?? NaN) && (options.nodeTimeoutMs ?? 0) >= 1000;

/** The template's own run options: review rounds, parallel units, the time a
 * unit may take and how permissions are asked. Saved with the template; every
 * run started from a chat begins with them. */
function RunDefaults({ value, readOnly, onChange }: {
  value?: WorkflowRunOptionsDto;
  readOnly: boolean;
  onChange: (next: WorkflowRunOptionsDto) => void;
}) {
  const options = { ...RUN_OPTION_DEFAULTS, ...value };
  const set = <K extends keyof WorkflowRunOptionsDto>(key: K, next: WorkflowRunOptionsDto[K]) =>
    onChange({ ...options, [key]: next });
  const reviewRounds = options.reviewRounds ?? DEFAULT_REVIEW_ROUNDS;
  const maxParallelValid = Number.isInteger(options.maxParallel ?? NaN) && (options.maxParallel ?? 0) >= 1 && (options.maxParallel ?? 0) <= 32;
  const timeoutValid = Number.isFinite(options.nodeTimeoutMs ?? NaN) && (options.nodeTimeoutMs ?? 0) >= 1000;
  return (
    <div className="workflow-run-options">
      <label className="workflow-field">
        <span>{tr("workflowview.permissions")}</span>
        <Select
          label={tr("workflowview.permissions")}
          value={options.permissions ?? "manual"}
          disabled={readOnly}
          options={[
            { value: "manual", label: tr("workflowview.manualReview") },
            { value: "auto", label: tr("workflowview.autoApprove") },
          ]}
          onChange={(next) => set("permissions", next as WorkflowRunOptionsDto["permissions"])}
        />
      </label>
      <label className="workflow-field">
        <span>{tr("workflowview.reviewRounds")}</span>
        <Select
          label={tr("workflowview.reviewRounds")}
          value={String(reviewRounds)}
          disabled={readOnly}
          options={Array.from({ length: MAX_REVIEW_ROUNDS + 1 }, (_, rounds) => ({
            value: String(rounds),
            label: workflowReviewRoundsLabel(rounds),
          }))}
          onChange={(next) => set("reviewRounds", Number(next))}
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
          readOnly={readOnly}
          aria-invalid={!maxParallelValid || undefined}
          value={Number.isFinite(options.maxParallel ?? NaN) ? String(options.maxParallel) : ""}
          onChange={(event) => set("maxParallel", Number(event.target.value))}
        />
      </label>
      <label className="workflow-field">
        <span>{tr("workflowview.timeoutSeconds")}</span>
        <TextInput
          type="number"
          min={1}
          step={1}
          readOnly={readOnly}
          aria-invalid={!timeoutValid || undefined}
          value={Number.isFinite(options.nodeTimeoutMs ?? NaN) ? String((options.nodeTimeoutMs ?? 0) / 1000) : ""}
          onChange={(event) => set("nodeTimeoutMs", Number(event.target.value) * 1000)}
        />
      </label>
    </div>
  );
}
