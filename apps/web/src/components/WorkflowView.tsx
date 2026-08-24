import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ModelRef,
  WorkflowDto,
  WorkflowNodeDto,
  WorkflowPermissionPolicy,
  WorkflowPipeMode,
  WorkflowRunDto,
} from "@polyth/contracts";
import { api } from "../api.ts";
import { modelDisplayName, modelSupportsTextWorkflow } from "../composer/discovery.ts";
import { openSession } from "../init.ts";
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
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) {
      setWorkflows([]);
      setSelectedId(null);
      setDraft(null);
      return;
    }
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
    }
  }, [projectId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const selected = workflows.find((workflow) => workflow.id === selectedId);
    setDraft(selected ? cloneWorkflow(selected) : null);
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
    return <EmptyState title="No project selected" description="Open a project to build agent workflows." />;
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
      if (!layers?.ok) throw new Error(layers?.error ?? "Invalid workflow graph");
      const updated = await api.updateWorkflow(draft.id, {
        name: draft.name,
        nodes: draft.nodes,
        edges: draft.edges,
        defaults: draft.defaults,
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

  return (
    <div className="view-page">
      <div>
        <h1 className="view-title">Workflows</h1>
        <p className="view-sub">Build a dependency graph of agent roles, then run each topological layer in parallel.</p>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(190px, 0.28fr) minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
        <aside className="sched-form">
          <div className="view-toolbar-row">
            <strong>Definitions</strong>
            <span className="header-spacer" />
            <button className="small-btn" disabled={busy === "create"} onClick={create}>+ New</button>
          </div>
          {workflows.length === 0 && <span className="muted">No workflows yet.</span>}
          {workflows.map((workflow) => (
            <button
              key={workflow.id}
              className={workflow.id === selectedId ? "small-btn on" : "small-btn"}
              style={{ width: "100%", textAlign: "left", padding: "9px 10px" }}
              onClick={() => setSelectedId(workflow.id)}
            >
              <strong>{workflow.name}</strong>
              <span className="muted" style={{ display: "block", fontSize: "calc(11px * var(--ui-font-scale, 1))" }}>{workflow.nodes.length} nodes</span>
            </button>
          ))}
        </aside>

        <main style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {!draft && <EmptyState title="No workflow selected" description="Create a workflow to start building a DAG." />}
          {draft && (
            <>
              <section className="sched-form">
                <div className="view-toolbar-row">
                  <input
                    value={draft.name}
                    aria-label="Workflow name"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    style={{ flex: "1 1 260px", fontWeight: 650 }}
                  />
                  <button className="small-btn" onClick={addNode}>+ Node</button>
                  <button className="small-btn danger-btn" disabled={busy === "delete"} onClick={remove}>Delete</button>
                  <button className="primary-btn" disabled={busy === "save" || !layers?.ok} onClick={save}>
                    {busy === "save" ? "Saving…" : "Save"}
                  </button>
                </div>
                <div className="view-toolbar-row" aria-label="Layer preview">
                  <span className="stat-label" style={{ margin: 0 }}>Layers</span>
                  {layers?.ok
                    ? layers.layers.map((layer, index) => (
                        <span key={index} className="kbd">
                          {index + 1}: {layer.map((id) => draft.nodes.find((node) => node.id === id)?.role ?? id).join(" + ")}
                        </span>
                      ))
                    : <span className="form-error">{layers?.error}</span>}
                </div>
              </section>

              <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
                {draft.nodes.map((node) => (
                  <article key={node.id} className="sched-form">
                    <div className="view-toolbar-row">
                      <input
                        value={node.role}
                        aria-label={`Role for ${node.id}`}
                        placeholder="Role"
                        onChange={(event) => updateNode(node.id, { role: event.target.value })}
                        style={{ flex: 1, fontWeight: 650 }}
                      />
                      <button
                        className="small-btn danger-btn"
                        disabled={draft.nodes.length === 1}
                        onClick={() => removeNode(node.id)}
                        aria-label={`Delete ${node.role}`}
                      >
                        ×
                      </button>
                    </div>
                    <textarea
                      rows={5}
                      value={node.prompt}
                      aria-label={`Prompt for ${node.role}`}
                      placeholder="Instructions for this role…"
                      onChange={(event) => updateNode(node.id, { prompt: event.target.value })}
                    />
                    <div className="view-toolbar-row">
                      <select
                        value={modelValue(node.model)}
                        aria-label={`Model for ${node.role}`}
                        onChange={(event) => updateNode(node.id, { model: parseModel(event.target.value) })}
                        style={{ flex: "1 1 160px" }}
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
                      <select
                        value={node.agent ?? ""}
                        aria-label={`Agent for ${node.role}`}
                        onChange={(event) => updateNode(node.id, { agent: event.target.value || undefined })}
                        style={{ flex: "1 1 120px" }}
                      >
                        <option value="">Default agent</option>
                        {agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
                      </select>
                    </div>
                    {draft.nodes.length > 1 && (
                      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend className="muted" style={{ fontSize: "calc(12px * var(--ui-font-scale, 1))", marginBottom: 4 }}>Depends on</legend>
                        <div className="view-toolbar-row">
                          {draft.nodes.filter((source) => source.id !== node.id).map((source) => {
                            const checked = draft.edges.some((edge) => edge.source === source.id && edge.target === node.id);
                            const cycle = !checked && wouldWorkflowCycle(draft, source.id, node.id);
                            return (
                              <label key={source.id} className="sched-every" title={cycle ? "This dependency would create a cycle" : ""}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={cycle}
                                  onChange={(event) => toggleDependency(node.id, source.id, event.target.checked)}
                                />
                                {source.role}
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}
                  </article>
                ))}
              </section>

              <section className="sched-form">
                <strong>Run workflow</strong>
                <textarea
                  rows={3}
                  value={runInput}
                  placeholder="Describe the task for this workflow…"
                  onChange={(event) => setRunInput(event.target.value)}
                />
                <div className="view-toolbar-row">
                  <label className="sched-every">Context
                    <select value={pipe} onChange={(event) => setPipe(event.target.value as WorkflowPipeMode)}>
                      <option value="ancestors">All ancestors</option>
                      <option value="direct">Direct dependencies</option>
                    </select>
                  </label>
                  <label className="sched-every">Permissions
                    <select value={permissions} onChange={(event) => setPermissions(event.target.value as WorkflowPermissionPolicy)}>
                      <option value="auto">Auto approve</option>
                      <option value="manual">Manual review</option>
                    </select>
                  </label>
                  <label className="sched-every">Parallel
                    <input type="number" min={1} max={32} value={maxParallel} onChange={(event) => setMaxParallel(Math.max(1, Number(event.target.value)))} style={{ width: 62 }} />
                  </label>
                  <label className="sched-every">Timeout (sec)
                    <input type="number" min={1} value={nodeTimeoutSeconds} onChange={(event) => setNodeTimeoutSeconds(Math.max(1, Number(event.target.value)))} style={{ width: 82 }} />
                  </label>
                  <span className="header-spacer" />
                  {shownRun?.status === "running" && <button className="small-btn danger-btn" disabled={busy === "stop"} onClick={stop}>Stop</button>}
                  <button
                    className="primary-btn"
                    disabled={!sessionId || !runInput.trim() || shownRun?.status === "running" || busy === "run"}
                    title={sessionId ? "" : "Open a parent session before running a workflow"}
                    onClick={run}
                  >
                    {busy === "run" ? "Starting…" : "Run"}
                  </button>
                </div>
                {!sessionId && <span className="muted">Open a session to use as the parent run log.</span>}
              </section>

              {shownRun && (
                <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="view-toolbar-row">
                    <strong>{shownRun.name}</strong>
                    <span className={`kbd status-${shownRun.status}`}>{shownRun.status}</span>
                    <span className="muted">{shownRun.nodes.filter((node) => node.status === "done").length}/{shownRun.nodes.length} done</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
                    {shownRun.nodes.map((node) => (
                      <article key={node.id} className="sched-card" style={{ flexDirection: "column" }}>
                        <div className="view-toolbar-row" style={{ width: "100%" }}>
                          <strong>{node.role}</strong>
                          <span className="header-spacer" />
                          <span className="kbd">{node.status}</span>
                        </div>
                        {node.activity && <span className="muted">{node.activity}</span>}
                        {node.error && <div className="form-error">{node.error}</div>}
                        {node.output && (
                          <pre style={{ margin: 0, width: "100%", whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>
                            {node.output}
                          </pre>
                        )}
                        {node.sessionId && (
                          <button className="small-btn" onClick={() => void openSession(node.sessionId!)}>
                            Open session
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
