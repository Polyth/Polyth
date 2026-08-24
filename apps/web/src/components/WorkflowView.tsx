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
import { api } from "../api.ts";
import { modelDisplayName, modelSupportsTextWorkflow } from "../composer/discovery.ts";
import { openSession } from "../init.ts";
import { Icon } from "../icons.tsx";
import { showSessionChat, useActiveModel, useStore } from "../store.ts";
import { layerizeWorkflow, wouldWorkflowCycle } from "../workflowGraph.ts";
import { takeWorkflowLaunch, type WorkflowLaunchIntent } from "../workflowLaunch.ts";
import {
  WORKFLOW_STATUS_LABEL,
  fresherWorkflowRun,
  workflowFinishedCount,
  workflowHumanWait,
  workflowHumanWaitLabel,
} from "../workflowRun.ts";
import EmptyState from "./EmptyState.tsx";

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
  return (
    <span className={`workflow-status status-${status}`} aria-label={`Status: ${WORKFLOW_STATUS_LABEL[status]}`}>
      <span aria-hidden="true"><StatusIcon status={status} /></span>
      {WORKFLOW_STATUS_LABEL[status]}
    </span>
  );
}

export default function WorkflowView() {
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
  const [error, setError] = useState("");
  const loadSequence = useRef(0);
  const actionInFlight = useRef(false);
  const loadedSelection = useRef<string | null>(null);
  const loadedProject = useRef<string | null>(null);
  const launchIntent = useRef<WorkflowLaunchIntent | null>(null);
  const loadedRun = useRef<WorkflowRunDto | null>(null);

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
      setError(`Could not load workflows: ${cause instanceof Error ? cause.message : String(cause)}`);
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

  const layers = useMemo(
    () => draft ? layerizeWorkflow(draft) : null,
    [draft],
  );
  const eventRunForDraft = draft && eventRun?.workflowId === draft.id ? eventRun : null;
  const shownRun = fresherWorkflowRun(liveRun, eventRunForDraft);
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedId) ?? null;
  const parallelValue = positiveWholeNumber(maxParallel, 32);
  const timeoutValue = positiveWholeNumber(nodeTimeoutSeconds);
  const nameError = draft && !draft.name.trim() ? "Enter a workflow name." : "";
  const nodeErrors = useMemo(() => new Map(
    (draft?.nodes ?? []).map((node) => [node.id, {
      role: node.role.trim() ? "" : "Enter a role name.",
      prompt: node.prompt.trim() ? "" : "Add instructions for this role.",
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
  const isBusy = busy !== "";

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
        title="No project selected"
        description="Open a project to build agent workflows."
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionInFlight.current = false;
      setBusy("");
    }
  };

  const create = () => {
    if (dirty && !window.confirm("Discard your unsaved workflow changes and create a new workflow?")) return;
    void act("create", async () => {
      const nodeId = uid();
      let number = workflows.length + 1;
      while (workflows.some((workflow) => workflow.name === `Workflow ${number}`)) number++;
      const created = await api.createWorkflow({
        projectId,
        name: `Workflow ${number}`,
        nodes: [{
          id: nodeId,
          role: "Worker",
          prompt: "Complete the assigned workflow task.",
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
        throw new Error("Fix the highlighted workflow fields before saving.");
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

  const remove = () => {
    if (!draft || !window.confirm(`Delete workflow “${draft.name}”?`)) return;
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
            role: `Agent ${current.nodes.length + 1}`,
            prompt: "Complete your part of the workflow.",
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
      if (dirty) throw new Error("Save workflow changes before starting a run.");
      if (parallelValue === null || timeoutValue === null) {
        throw new Error("Fix the highlighted run options before starting.");
      }
      const input = (inputOverride ?? runInput).trim();
      if (!input) throw new Error("Describe a task before starting the workflow.");
      const started = await api.runWorkflow(draft.id, sessionId, input, {
        pipe,
        permissions,
        maxParallel: parallelValue,
        nodeTimeoutMs: timeoutValue * 1_000,
      });
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
      if (dirty) throw new Error("Save workflow changes before retrying.");
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
      setRunInput(shownRun.input);
      setLiveRun(started);
      setProjectRuns((current) => [started, ...current.filter((candidate) => candidate.id !== started.id)]);
    });
  };

  const stop = () => {
    if (!shownRun) return;
    void act("stop", async () => {
      const stopped = await api.stopWorkflowRun(shownRun.id);
      setLiveRun(stopped);
      setProjectRuns((current) => current.map((candidate) => candidate.id === stopped.id ? stopped : candidate));
    });
  };

  const returnToChat = () => {
    if (dirty && !window.confirm("Leave the workflow builder with unsaved changes?")) return;
    showSessionChat();
  };

  const openLinkedSession = (targetSessionId: string) => {
    if (dirty && !window.confirm("Discard your unsaved workflow changes and open this session?")) return;
    void openSession(targetSessionId);
  };

  const openParentChat = () => {
    const parent = shownRun?.parentSessionId;
    if (parent && parent !== sessionId) {
      openLinkedSession(parent);
      return;
    }
    returnToChat();
  };

  const finishedNodes = shownRun ? workflowFinishedCount(shownRun) : 0;
  const selectWorkflow = (id: string) => {
    if (id === selectedId) return;
    if (dirty && !window.confirm("Discard your unsaved workflow changes?")) return;
    setError("");
    setSelectedId(id);
  };

  return (
    <div className="view-page workflow-page" aria-busy={loading || isBusy}>
      <header className="workflow-page-header">
        <span className="workflow-page-icon" aria-hidden><Icon.workflow /></span>
        <div>
          <h1 className="view-title">Workflows</h1>
          <p className="view-sub">Coordinate agent roles in dependency-based pipelines.</p>
        </div>
        <button type="button" className="small-btn workflow-back-chat" onClick={returnToChat}>
          <Icon.back />Back to chat
        </button>
      </header>

      {error && (
        <div className="form-error workflow-error" role="alert">
          <span>{error}</span>
          {loadFailed && (
            <button type="button" className="small-btn workflow-error-retry" onClick={() => void reload()}>
              Retry
            </button>
          )}
        </div>
      )}

      <div className="workflow-layout">
        <aside className="sched-form workflow-sidebar" aria-label="Workflow definitions">
          <div className="workflow-section-heading">
            <div>
              <h2>Definitions</h2>
              <span>{workflows.length} saved</span>
            </div>
            <button
              type="button"
              className="small-btn workflow-button"
              disabled={isBusy || loading}
              onClick={create}
            >
              <Icon.plus />{busy === "create" ? "Creating…" : "New"}
            </button>
          </div>

          {loading && (
            <div className="workflow-list-state" role="status">
              <span className="workflow-spinner" aria-hidden />
              Loading workflows…
            </div>
          )}
          {!loading && !loadFailed && workflows.length === 0 && (
            <div className="workflow-list-empty">
              <Icon.workflow />
              <strong>No workflows yet</strong>
              <span>Create one to coordinate a team of agents.</span>
            </div>
          )}
          <div className="workflow-definition-list">
            {workflows.map((workflow) => (
              <button
                type="button"
                key={workflow.id}
                className={`workflow-definition${workflow.id === selectedId ? " active" : ""}`}
                aria-pressed={workflow.id === selectedId}
                disabled={isBusy}
                onClick={() => selectWorkflow(workflow.id)}
              >
                <span className="workflow-definition-icon" aria-hidden><Icon.workflow /></span>
                <span className="workflow-definition-copy">
                  <strong>{workflow.name}</strong>
                  <span>{workflow.nodes.length} {workflow.nodes.length === 1 ? "node" : "nodes"}</span>
                </span>
                <Icon.chevronRight />
              </button>
            ))}
          </div>
        </aside>

        <main className="workflow-main">
          {loading && !draft && (
            <div className="workflow-main-loading" role="status">
              <span className="workflow-spinner" aria-hidden />
              <span>Loading workflow builder…</span>
            </div>
          )}
          {!loading && !draft && (
            <EmptyState
              title={loadFailed ? "Couldn’t load workflows" : workflows.length ? "Choose a workflow" : "Build your first workflow"}
              description={loadFailed
                ? "Check the connection and try loading your workflow definitions again."
                : workflows.length
                  ? "Select a saved definition to continue building."
                  : "Create a dependency-based team of agents, then run it from the current session."}
              actionLabel={loadFailed ? "Retry" : "Create workflow"}
              onAction={loadFailed ? () => void reload() : create}
              mark={<Icon.workflow />}
            />
          )}

          {draft && (
            <>
              <section className="sched-form workflow-editor-header">
                <div className="workflow-editor-toolbar">
                  <label className="workflow-field workflow-name-field">
                    <span>Workflow name</span>
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
                      {dirty ? "Unsaved changes" : "Saved"}
                    </span>
                    <button type="button" className="small-btn workflow-button" disabled={isBusy} onClick={addNode}>
                      <Icon.plus />Add node
                    </button>
                    <button
                      type="button"
                      className="small-btn danger-btn workflow-button"
                      disabled={isBusy || shownRun?.status === "running"}
                      title={shownRun?.status === "running" ? "Stop the active run before deleting this workflow" : "Delete workflow"}
                      onClick={remove}
                    >
                      <Icon.trash />{busy === "delete" ? "Deleting…" : "Delete"}
                    </button>
                    <button
                      type="button"
                      className="primary-btn workflow-button"
                      disabled={isBusy || !canSave || !dirty}
                      title={!canSave ? "Fix highlighted fields before saving" : !dirty ? "No unsaved changes" : "Save workflow"}
                      onClick={save}
                    >
                      <Icon.check />{busy === "save" ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>

                <div className="workflow-layers" aria-label="Execution order">
                  <div className="workflow-layers-label">
                    <Icon.hierarchy />
                    <span>
                      <strong>Execution order</strong>
                      <small>Nodes in a layer run in parallel</small>
                    </span>
                  </div>
                  <div className="workflow-layer-list">
                    {layers?.ok
                      ? layers.layers.map((layer, index) => (
                          <span key={index} className="workflow-layer-chip">
                            <b>Layer {index + 1}</b>
                            {layer.map((id) => draft.nodes.find((node) => node.id === id)?.role ?? id).join(" + ")}
                          </span>
                        ))
                      : <span className="form-error workflow-graph-error" role="alert">{layers?.error}</span>}
                  </div>
                </div>
              </section>

              <section className="workflow-node-grid" aria-label="Workflow nodes">
                {draft.nodes.map((node, nodeIndex) => (
                  <article
                    key={node.id}
                    className="sched-form workflow-node-card"
                    aria-labelledby={`workflow-node-${nodeIndex}-title`}
                  >
                    <div className="workflow-node-heading">
                      <span className="workflow-node-index" aria-hidden>{nodeIndex + 1}</span>
                      <div>
                        <strong id={`workflow-node-${nodeIndex}-title`}>{node.role || "Untitled role"}</strong>
                        <span>Agent node</span>
                      </div>
                      <button
                        type="button"
                        className="small-btn icon-only danger-btn workflow-node-delete"
                        disabled={isBusy || draft.nodes.length === 1}
                        onClick={() => removeNode(node.id)}
                        title={draft.nodes.length === 1 ? "A workflow needs at least one node" : `Delete ${node.role || "node"}`}
                        aria-label={`Delete ${node.role || "node"}`}
                      >
                        <Icon.trash />
                      </button>
                    </div>

                    <label className="workflow-field">
                      <span>Role</span>
                      <input
                        value={node.role}
                        disabled={isBusy}
                        placeholder="e.g. Researcher"
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
                      <span>Instructions</span>
                      <textarea
                        rows={5}
                        value={node.prompt}
                        disabled={isBusy}
                        placeholder="What should this agent accomplish?"
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
                        <span>Model</span>
                        <select
                          value={modelValue(node.model)}
                          disabled={isBusy}
                          onChange={(event) => updateNode(node.id, { model: parseModel(event.target.value) })}
                        >
                          <option value="">Default model</option>
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
                        <span>Agent</span>
                        <select
                          value={node.agent ?? ""}
                          disabled={isBusy}
                          onChange={(event) => updateNode(node.id, { agent: event.target.value || undefined })}
                        >
                          <option value="">Default agent</option>
                          {agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
                        </select>
                      </label>
                    </div>

                    {draft.nodes.length > 1 && (
                      <fieldset className="workflow-dependencies">
                        <legend>Depends on</legend>
                        <p>Select the nodes that must finish before this one starts.</p>
                        <div className="workflow-dependency-list">
                          {draft.nodes.filter((source) => source.id !== node.id).map((source) => {
                            const checked = draft.edges.some((edge) => edge.source === source.id && edge.target === node.id);
                            const cycle = !checked && wouldWorkflowCycle(draft, source.id, node.id);
                            return (
                              <label
                                key={source.id}
                                className={`workflow-dependency${checked ? " checked" : ""}${cycle ? " disabled" : ""}`}
                                title={cycle ? "This dependency would create a cycle" : ""}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={isBusy || cycle}
                                  aria-label={`Depends on ${source.role || "untitled role"}${cycle ? "; unavailable because it would create a cycle" : ""}`}
                                  onChange={(event) => toggleDependency(node.id, source.id, event.target.checked)}
                                />
                                <span aria-hidden><Icon.check /></span>
                                {source.role || "Untitled role"}
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}
                  </article>
                ))}
              </section>

              <section className="sched-form workflow-run-form">
                <div className="workflow-section-heading">
                  <div>
                    <h2>Run workflow</h2>
                    <span>Give every role one shared objective.</span>
                  </div>
                  {shownRun && <StatusBadge status={shownRun.status} />}
                </div>
                <label className="workflow-field">
                  <span>Task</span>
                  <textarea
                    rows={3}
                    value={runInput}
                    disabled={isBusy}
                    placeholder="Describe the task for this workflow…"
                    onChange={(event) => { setError(""); setRunInput(event.target.value); }}
                  />
                </label>
                <div className="workflow-run-options">
                  <label className="workflow-field">
                    <span>Context</span>
                    <select disabled={isBusy} value={pipe} onChange={(event) => { setError(""); setPipe(event.target.value as WorkflowPipeMode); }}>
                      <option value="ancestors">All ancestors</option>
                      <option value="direct">Direct dependencies</option>
                    </select>
                  </label>
                  <label className="workflow-field">
                    <span>Permissions</span>
                    <select disabled={isBusy} value={permissions} onChange={(event) => { setError(""); setPermissions(event.target.value as WorkflowPermissionPolicy); }}>
                      <option value="auto">Auto approve</option>
                      <option value="manual">Manual review</option>
                    </select>
                    <small className="workflow-option-help">
                      {permissions === "manual"
                        ? "Tool calls pause the node. Open its child session to approve or deny."
                        : "Allowed tool calls continue automatically; deny rules still apply."}
                    </small>
                  </label>
                  <label className="workflow-field">
                    <span>Parallel agents</span>
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
                      <small id="workflow-parallel-error" className="workflow-field-error">Enter a whole number from 1 to 32.</small>
                    )}
                  </label>
                  <label className="workflow-field">
                    <span>Timeout (seconds)</span>
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
                      <small id="workflow-timeout-error" className="workflow-field-error">Enter a positive whole number.</small>
                    )}
                    {timeoutValue !== null && (
                      <small className="workflow-option-help">Per node; timed-out nodes fail and skip dependants.</small>
                    )}
                  </label>
                </div>
                <div className="workflow-run-footer">
                  <span className="muted">
                    {dirty
                      ? "Save workflow changes before starting a run."
                      : !sessionId
                        ? "Open a session to use as the parent run log."
                        : !runInput.trim()
                          ? "Describe a task to enable the workflow run."
                          : "Progress is saved to the current session."}
                  </span>
                  <div className="workflow-run-actions">
                    {shownRun?.status === "running" && (
                      <button
                        type="button"
                        className="small-btn danger-btn workflow-button"
                        disabled={isBusy}
                        onClick={stop}
                      >
                        <Icon.stop />{busy === "stop" ? "Stopping…" : "Stop run"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="primary-btn workflow-button"
                      disabled={!sessionId || !runInput.trim() || dirty || parallelValue === null
                        || timeoutValue === null || shownRun?.status === "running" || isBusy}
                      title={!sessionId
                        ? "Open a parent session before running a workflow"
                        : dirty
                          ? "Save workflow changes before running"
                          : !runInput.trim()
                            ? "Describe a task before running"
                            : parallelValue === null || timeoutValue === null
                              ? "Fix the highlighted run options"
                              : shownRun?.status === "running"
                                ? "A workflow run is already active"
                                : "Run this workflow"}
                      onClick={() => run()}
                    >
                      <Icon.workflow />{busy === "run" ? "Starting…" : "Run workflow"}
                    </button>
                  </div>
                </div>
              </section>

              {shownRun && (
                <section className="workflow-run-results">
                  <div className="workflow-run-heading" aria-live="polite">
                    <div>
                      <span className="stat-label">Latest run</span>
                      <h2>{shownRun.name}</h2>
                    </div>
                    <StatusBadge status={shownRun.status} />
                    <span className="workflow-run-count">{finishedNodes}/{shownRun.nodes.length} finished</span>
                  </div>
                  {shownRun.nodes.some((node) => workflowHumanWait(node) !== null) && (
                    <div className="workflow-run-notice waiting" role="alert">
                      <Icon.shield />
                      <span>
                        <strong>This workflow needs you.</strong>
                        A child session is paused for approval or an answer. Use its highlighted action below.
                      </span>
                    </div>
                  )}
                  {shownRun.status === "error" && (
                    <div className="workflow-run-notice error" role="alert">
                      <Icon.close />
                      <span>
                        <strong>The workflow failed.</strong>
                        Review the node error below. Retry runs the full workflow again so dependencies stay consistent.
                      </span>
                    </div>
                  )}
                  {shownRun.status === "stopped" && (
                    <div className="workflow-run-notice">
                      <Icon.stop />
                      <span><strong>The run was stopped.</strong> Running child turns were aborted and queued nodes did not start.</span>
                    </div>
                  )}
                  <div
                    className={`workflow-run-progress status-${shownRun.status}`}
                    role="progressbar"
                    aria-label={`${finishedNodes} of ${shownRun.nodes.length} nodes finished`}
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
                            aria-label={`${node.role} output`}
                          >
                            {node.output}
                          </pre>
                        )}
                        {!node.activity && !node.error && !node.output && (
                          <span className="muted workflow-node-waiting">
                            {node.status === "queued" ? "Waiting for dependencies…" : "No output yet."}
                          </span>
                        )}
                        {node.sessionId && (
                          <button
                            type="button"
                            className={`small-btn workflow-button workflow-open-session${needsHuman ? " primary-btn" : ""}`}
                            aria-label={`${needsHuman ? "Review and respond in" : "Open"} ${node.role} child session`}
                            onClick={() => openLinkedSession(node.sessionId!)}
                          >
                            {needsHuman ? "Review & respond" : "Open child session"}<Icon.chevronRight />
                          </button>
                        )}
                      </article>
                    );})}
                  </div>
                  <div className="workflow-results-actions">
                    {shownRun.parentSessionId && (
                      <button type="button" className="small-btn workflow-button" onClick={openParentChat}>
                        <Icon.session />Open parent chat
                      </button>
                    )}
                    {shownRun.status !== "running" && (
                      <button
                        type="button"
                        className="primary-btn workflow-button"
                        disabled={isBusy || dirty || !shownRun.parentSessionId}
                        title={!shownRun.parentSessionId
                          ? "This older run does not include its parent session"
                          : dirty
                            ? "Save workflow changes before retrying"
                            : shownRun.status === "error"
                              ? "Retry the full workflow"
                              : "Run the workflow again"}
                        onClick={retry}
                      >
                        <Icon.workflow />{busy === "retry" ? "Starting…" : shownRun.status === "error" ? "Retry full workflow" : "Run again"}
                      </button>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
