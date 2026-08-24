import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useActiveModel, useStore } from "../store.ts";
import { layerizeWorkflow, wouldWorkflowCycle } from "../workflowGraph.ts";
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

const statusLabel: Record<WorkflowNodeStatus | WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Complete",
  error: "Failed",
  skipped: "Skipped",
  stopped: "Stopped",
};

function StatusIcon({ status }: { status: WorkflowNodeStatus | WorkflowRunStatus }) {
  if (status === "done") return <Icon.check />;
  if (status === "error") return <Icon.close />;
  if (status === "stopped") return <Icon.stop />;
  if (status === "skipped") return <Icon.branch />;
  return <Icon.clock />;
}

function StatusBadge({ status }: { status: WorkflowNodeStatus | WorkflowRunStatus }) {
  return (
    <span className={`workflow-status status-${status}`} aria-label={`Status: ${statusLabel[status]}`}>
      <StatusIcon status={status} />
      {statusLabel[status]}
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDto | null>(null);
  const [runInput, setRunInput] = useState("");
  const [pipe, setPipe] = useState<WorkflowPipeMode>("ancestors");
  const [permissions, setPermissions] = useState<WorkflowPermissionPolicy>("auto");
  const [maxParallel, setMaxParallel] = useState(4);
  const [nodeTimeoutSeconds, setNodeTimeoutSeconds] = useState(1800);
  const [liveRun, setLiveRun] = useState<WorkflowRunDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) {
      setWorkflows([]);
      setSelectedId(null);
      setDraft(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.listWorkflows(projectId);
      setWorkflows(next);
      setSelectedId((current) =>
        current && next.some((workflow) => workflow.id === current)
          ? current
          : next[0]?.id ?? null);
      setError("");
    } catch (cause) {
      setError(`Could not load workflows: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const selected = workflows.find((workflow) => workflow.id === selectedId);
    setDraft(selected ? cloneWorkflow(selected) : null);
    setPipe(selected?.defaults?.pipe ?? "ancestors");
    setPermissions(selected?.defaults?.permissions ?? "auto");
    setMaxParallel(selected?.defaults?.maxParallel ?? 4);
    setNodeTimeoutSeconds(Math.max(1, Math.round((selected?.defaults?.nodeTimeoutMs ?? 1_800_000) / 1_000)));
    setLiveRun(null);
  }, [selectedId, workflows]);

  const layers = useMemo(
    () => draft ? layerizeWorkflow(draft) : null,
    [draft],
  );
  const shownRun = liveRun ?? (draft && eventRun?.workflowId === draft.id ? eventRun : null);

  useEffect(() => {
    if (!shownRun || shownRun.status !== "running") return;
    let active = true;
    const refresh = async () => {
      try {
        const next = await api.getWorkflowRun(shownRun.id);
        if (active) setLiveRun(next);
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
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const create = () => void act("create", async () => {
    const nodeId = uid();
    const created = await api.createWorkflow({
      projectId,
      name: `Workflow ${workflows.length + 1}`,
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

  const save = () => {
    if (!draft) return;
    void act("save", async () => {
      if (!draft.name.trim()) throw new Error("Give this workflow a name");
      if (!layers?.ok) throw new Error(layers?.error ?? "Invalid workflow graph");
      const updated = await api.updateWorkflow(draft.id, {
        name: draft.name.trim(),
        nodes: draft.nodes,
        edges: draft.edges,
        defaults: {
          ...draft.defaults,
          pipe,
          permissions,
          maxParallel,
          nodeTimeoutMs: Math.max(1, nodeTimeoutSeconds) * 1_000,
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
      setWorkflows((current) => current.filter((workflow) => workflow.id !== draft.id));
      setSelectedId(null);
    });
  };

  const updateNode = (id: string, patch: Partial<WorkflowNodeDto>) => {
    setDraft((current) => current
      ? { ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }
      : current);
  };

  const addNode = () => {
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
    setDraft((current) => current
      ? {
          ...current,
          nodes: current.nodes.filter((node) => node.id !== id),
          edges: current.edges.filter((edge) => edge.source !== id && edge.target !== id),
        }
      : current);
  };

  const toggleDependency = (target: string, source: string, checked: boolean) => {
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

  const run = () => {
    if (!draft || !sessionId) return;
    void act("run", async () => {
      const started = await api.runWorkflow(draft.id, sessionId, runInput.trim(), {
        pipe,
        permissions,
        maxParallel,
        nodeTimeoutMs: Math.max(1, nodeTimeoutSeconds) * 1_000,
      });
      setLiveRun(started);
    });
  };

  const stop = () => {
    if (!shownRun) return;
    void act("stop", async () => {
      setLiveRun(await api.stopWorkflowRun(shownRun.id));
    });
  };

  const completedNodes = shownRun?.nodes.filter((node) => node.status === "done").length ?? 0;

  return (
    <div className="view-page workflow-page" aria-busy={loading}>
      <header className="workflow-page-header">
        <span className="workflow-page-icon" aria-hidden><Icon.workflow /></span>
        <div>
          <h1 className="view-title">Workflows</h1>
          <p className="view-sub">Coordinate agent roles in dependency-based pipelines.</p>
        </div>
      </header>

      {error && <div className="form-error workflow-error" role="alert">{error}</div>}

      <div className="workflow-layout">
        <aside className="sched-form workflow-sidebar" aria-label="Workflow definitions">
          <div className="workflow-section-heading">
            <div>
              <strong>Definitions</strong>
              <span>{workflows.length} saved</span>
            </div>
            <button
              type="button"
              className="small-btn workflow-button"
              disabled={busy === "create"}
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
          {!loading && workflows.length === 0 && (
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
                onClick={() => setSelectedId(workflow.id)}
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
          {!loading && !draft && (
            <EmptyState
              title="Choose a workflow"
              description="Select a saved definition, or create a new workflow to start building."
              actionLabel="Create workflow"
              onAction={create}
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
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  </label>
                  <div className="workflow-editor-actions">
                    <button type="button" className="small-btn workflow-button" onClick={addNode}>
                      <Icon.plus />Add node
                    </button>
                    <button
                      type="button"
                      className="small-btn danger-btn workflow-button"
                      disabled={busy === "delete"}
                      onClick={remove}
                    >
                      <Icon.trash />{busy === "delete" ? "Deleting…" : "Delete"}
                    </button>
                    <button
                      type="button"
                      className="primary-btn workflow-button"
                      disabled={busy === "save" || !layers?.ok || !draft.name.trim()}
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
                      : <span className="form-error">{layers?.error}</span>}
                  </div>
                </div>
              </section>

              <section className="workflow-node-grid" aria-label="Workflow nodes">
                {draft.nodes.map((node, nodeIndex) => (
                  <article key={node.id} className="sched-form workflow-node-card">
                    <div className="workflow-node-heading">
                      <span className="workflow-node-index" aria-hidden>{nodeIndex + 1}</span>
                      <div>
                        <strong>{node.role || "Untitled role"}</strong>
                        <span>Agent node</span>
                      </div>
                      <button
                        type="button"
                        className="small-btn icon-only danger-btn workflow-node-delete"
                        disabled={draft.nodes.length === 1}
                        onClick={() => removeNode(node.id)}
                        title={`Delete ${node.role || "node"}`}
                        aria-label={`Delete ${node.role || "node"}`}
                      >
                        <Icon.trash />
                      </button>
                    </div>

                    <label className="workflow-field">
                      <span>Role</span>
                      <input
                        value={node.role}
                        placeholder="e.g. Researcher"
                        onChange={(event) => updateNode(node.id, { role: event.target.value })}
                      />
                    </label>
                    <label className="workflow-field">
                      <span>Instructions</span>
                      <textarea
                        rows={5}
                        value={node.prompt}
                        placeholder="What should this agent accomplish?"
                        onChange={(event) => updateNode(node.id, { prompt: event.target.value })}
                      />
                    </label>
                    <div className="workflow-node-selects">
                      <label className="workflow-field">
                        <span>Model</span>
                        <select
                          value={modelValue(node.model)}
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
                                  disabled={cycle}
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
                    <strong>Run workflow</strong>
                    <span>Give every role one shared objective.</span>
                  </div>
                  {shownRun && <StatusBadge status={shownRun.status} />}
                </div>
                <label className="workflow-field">
                  <span>Task</span>
                  <textarea
                    rows={3}
                    value={runInput}
                    placeholder="Describe the task for this workflow…"
                    onChange={(event) => setRunInput(event.target.value)}
                  />
                </label>
                <div className="workflow-run-options">
                  <label className="workflow-field">
                    <span>Context</span>
                    <select value={pipe} onChange={(event) => setPipe(event.target.value as WorkflowPipeMode)}>
                      <option value="ancestors">All ancestors</option>
                      <option value="direct">Direct dependencies</option>
                    </select>
                  </label>
                  <label className="workflow-field">
                    <span>Permissions</span>
                    <select value={permissions} onChange={(event) => setPermissions(event.target.value as WorkflowPermissionPolicy)}>
                      <option value="auto">Auto approve</option>
                      <option value="manual">Manual review</option>
                    </select>
                  </label>
                  <label className="workflow-field">
                    <span>Parallel agents</span>
                    <input
                      type="number"
                      min={1}
                      max={32}
                      value={maxParallel}
                      onChange={(event) => setMaxParallel(Math.max(1, Number(event.target.value)))}
                    />
                  </label>
                  <label className="workflow-field">
                    <span>Timeout (seconds)</span>
                    <input
                      type="number"
                      min={1}
                      value={nodeTimeoutSeconds}
                      onChange={(event) => setNodeTimeoutSeconds(Math.max(1, Number(event.target.value)))}
                    />
                  </label>
                </div>
                <div className="workflow-run-footer">
                  <span className="muted">
                    {sessionId ? "Progress is saved to the current session." : "Open a session to use as the parent run log."}
                  </span>
                  <div className="workflow-run-actions">
                    {shownRun?.status === "running" && (
                      <button
                        type="button"
                        className="small-btn danger-btn workflow-button"
                        disabled={busy === "stop"}
                        onClick={stop}
                      >
                        <Icon.stop />{busy === "stop" ? "Stopping…" : "Stop run"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="primary-btn workflow-button"
                      disabled={!sessionId || !runInput.trim() || shownRun?.status === "running" || busy === "run"}
                      title={sessionId ? "Run this workflow" : "Open a parent session before running a workflow"}
                      onClick={run}
                    >
                      <Icon.workflow />{busy === "run" ? "Starting…" : "Run workflow"}
                    </button>
                  </div>
                </div>
              </section>

              {shownRun && (
                <section className="workflow-run-results" aria-live="polite">
                  <div className="workflow-run-heading">
                    <div>
                      <span className="stat-label">Latest run</span>
                      <h2>{shownRun.name}</h2>
                    </div>
                    <StatusBadge status={shownRun.status} />
                    <span className="workflow-run-count">{completedNodes}/{shownRun.nodes.length} complete</span>
                  </div>
                  <div className="workflow-run-progress" aria-label={`${completedNodes} of ${shownRun.nodes.length} nodes complete`}>
                    <span style={{ width: `${shownRun.nodes.length ? (completedNodes / shownRun.nodes.length) * 100 : 0}%` }} />
                  </div>
                  <div className="workflow-run-grid">
                    {shownRun.nodes.map((node) => (
                      <article key={node.id} className={`sched-card workflow-run-card status-${node.status}`}>
                        <div className="workflow-run-card-heading">
                          <strong>{node.role}</strong>
                          <StatusBadge status={node.status} />
                        </div>
                        {node.activity && <span className="workflow-node-activity">{node.activity}</span>}
                        {node.error && <div className="form-error" role="alert">{node.error}</div>}
                        {node.output && <pre className="workflow-node-output">{node.output}</pre>}
                        {!node.activity && !node.error && !node.output && (
                          <span className="muted workflow-node-waiting">
                            {node.status === "queued" ? "Waiting for dependencies…" : "No output yet."}
                          </span>
                        )}
                        {node.sessionId && (
                          <button
                            type="button"
                            className="small-btn workflow-button workflow-open-session"
                            onClick={() => void openSession(node.sessionId!)}
                          >
                            Open session<Icon.chevronRight />
                          </button>
                        )}
                      </article>
                    ))}
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
