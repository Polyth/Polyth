import "./styles.css";
import { useEffect, useState } from "react";
import type { AgentDescriptor, HarnessSnapshot, ModelRef, OpenCodePendingResponseDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { defineWebPackage } from "@polyth/web-sdk";
import { readHarnessSnapshots } from "@polyth/models/runtime-catalog";
import { setAgents, useStore } from "../../../apps/web/src/store.ts";
import { Button, Dialog, Notice, Select, Textarea } from "../../../apps/web/src/components/ui/index.ts";

function OpenCodeRoleEditor({ role, onClose }: { role: AgentDescriptor; onClose: () => void }) {
  const allModels = useStore((state) => state.models);
  const models = allModels.filter((model) => !model.harnessId || model.harnessId === "opencode");
  const agents = useStore((state) => state.agents);
  const [prompt, setPrompt] = useState(role.prompt ?? "");
  const [mode, setMode] = useState<AgentDescriptor["mode"]>(role.mode === "all" ? "primary" : role.mode);
  const [model, setModel] = useState<ModelRef | undefined>(role.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const modelValue = model ? JSON.stringify([model.providerID, model.modelID]) : "";
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveRole(role.name, { prompt, mode, ...(mode !== "auto" && model ? { model } : {}) });
      const qualified = { ...saved, harnessId: "opencode" };
      const matchesOpenCodeRole = (candidate: AgentDescriptor) =>
        candidate.name === saved.name && (!candidate.harnessId || candidate.harnessId === "opencode");
      setAgents(agents.some(matchesOpenCodeRole)
        ? agents.map((candidate) => matchesOpenCodeRole(candidate) ? qualified : candidate)
        : [...agents, qualified]);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <Dialog title={`Edit ${role.name}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={() => void save()}>Save role</Button></>}>
    <div className="pkg-opencode-role-form">
      <label>Role type<Select label="Role type" value={mode} options={[{ value: "primary", label: "Primary" }, { value: "subagent", label: "Subagent" }, { value: "auto", label: "Inherited" }]} onChange={(value) => setMode(value as AgentDescriptor["mode"])} /></label>
      {mode !== "auto" && <label>Model<Select label="Model" value={modelValue} options={[{ value: "", label: "OpenCode default" }, ...models.map((candidate) => ({ value: JSON.stringify([candidate.providerID, candidate.modelID]), label: candidate.name }))]} onChange={(value) => {
        if (!value) { setModel(undefined); return; }
        const [providerID, modelID] = JSON.parse(value) as [string, string];
        setModel({ providerID, modelID });
      }} /></label>}
      <label>System prompt<Textarea rows={12} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <details><summary>Native OpenCode options</summary><p>Fields Polyth does not own remain unchanged in OpenCode configuration.</p></details>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </div>
  </Dialog>;
}

function OpenCodeRoles() {
  const agents = useStore((state) => state.agents)
    .filter((agent) => (!agent.harnessId || agent.harnessId === "opencode") && agent.name.toLowerCase() !== "compaction");
  const models = useStore((state) => state.models);
  const [editing, setEditing] = useState<AgentDescriptor>();
  const modelName = (ref?: ModelRef) => ref
    ? models.find((model) => model.providerID === ref.providerID && model.modelID === ref.modelID && (!model.harnessId || model.harnessId === "opencode"))?.name ?? ref.modelID
    : "Inherited model";
  return <div className="pkg-opencode-sections">
    <header><h3>OpenCode roles</h3><p>Native roles are scoped to OpenCode and are not carried to another harness by name.</p></header>
    <div className="pkg-opencode-role-list">
      {agents.map((agent) => <article key={agent.name} className="pkg-opencode-role">
        <div><strong>{agent.name}</strong><small>{agent.mode === "subagent" ? "Subagent" : agent.mode === "auto" ? "Inherited" : "Primary"} · {modelName(agent.model)}</small></div>
        <p>{agent.description || "OpenCode execution role"}</p>
        <Button size="sm" onClick={() => setEditing(agent)}>Edit</Button>
      </article>)}
    </div>
    {agents.length === 0 && <Notice>No OpenCode roles are available in the current catalog.</Notice>}
    {editing && <OpenCodeRoleEditor role={editing} onClose={() => setEditing(undefined)} />}
  </div>;
}

function OpenCodeRuntime({ snapshot, refreshCatalog }: { snapshot?: HarnessSnapshot; refreshCatalog: () => Promise<void> }) {
  const [pending, setPending] = useState<OpenCodePendingResponseDto>({ changes: [], count: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = () => api.opencodePending().then(setPending).catch(() => {});
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 5_000);
    const onPending = () => { void refresh(); };
    window.addEventListener("polyth:opencode-pending", onPending);
    return () => { window.clearInterval(timer); window.removeEventListener("polyth:opencode-pending", onPending); };
  }, []);
  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      await api.opencodeApplyRestart();
      await refreshCatalog();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <div className="pkg-opencode-sections">
    <header><h3>Runtime</h3><p>Managed OpenCode process and configuration lifecycle.</p></header>
    <dl className="pkg-opencode-runtime-facts">
      <dt>Status</dt><dd>{snapshot?.availability.healthy ? "Running or available" : "Unavailable"}</dd>
      {snapshot?.identity.version && <><dt>Version</dt><dd>{snapshot.identity.version}</dd></>}
      <dt>Protocol</dt><dd>{snapshot?.identity.integration ?? "HTTP / SSE"}</dd>
      <dt>Endpoint</dt><dd>{snapshot?.context.remote ? "Project execution target" : "Managed locally"}</dd>
    </dl>
    <section className="pkg-opencode-pending">
      <div><strong>Pending changes</strong><span>{pending.count}</span></div>
      {pending.changes.length > 0 ? <ul>{pending.changes.map((change) => <li key={change.id}>{change.label}</li>)}</ul> : <p>No OpenCode configuration changes are waiting.</p>}
      {pending.count > 0 && <Button busy={busy} onClick={() => void apply()}>Apply &amp; restart</Button>}
      {pending.count > 0 && !snapshot?.availability.healthy && <small>Changes will apply the next time OpenCode starts.</small>}
    </section>
    {error && <Notice tone="error" role="alert">Couldn’t apply OpenCode changes: {error}</Notice>}
  </div>;
}

export default defineWebPackage((host) => {
  const refreshOpenCodeSnapshot = async (projectId?: string | null): Promise<void> => {
    try {
      await readHarnessSnapshots({ projectId, harnessId: "opencode", force: true });
    } catch {
      // The pending queue is still refreshed locally; a transient catalog
      // failure must not make a successful restart look like a failed apply.
    }
  };
  return () => {
    const off = [
      (() => {
        const onPending = () => {
          void refreshOpenCodeSnapshot(host.store.getSnapshot().activeProjectId);
        };
        window.addEventListener("polyth:opencode-pending", onPending);
        return () => window.removeEventListener("polyth:opencode-pending", onPending);
      })(),
      host.settings.registerPage({
        id: "opencode",
        label: "OpenCode",
        group: "Engineering",
        order: 35,
        nav: false,
        redirect: {
          pageId: "harnesses",
          target: { itemId: "opencode", sectionId: "providers-models" },
        },
        component: () => null,
      }),
      // These sections remain package-owned contributions. Harnesses is the
      // sole composer and selects one section at a time.
      host.slots.register({ id: "opencode.roles", slot: "settings.harness.detail", order: 20, meta: { harnessId: "opencode", sectionId: "roles", label: "Roles" }, render: (context) => context.harnessId === "opencode" && context.sectionId === "roles" ? <OpenCodeRoles /> : null }),
      host.slots.register({ id: "opencode.runtime", slot: "settings.harness.detail", order: 80, meta: { harnessId: "opencode", sectionId: "runtime", label: "Runtime", handlesPendingChanges: true }, render: (context) => context.harnessId === "opencode" && context.sectionId === "runtime" ? <OpenCodeRuntime snapshot={context.snapshot as HarnessSnapshot | undefined} refreshCatalog={() => refreshOpenCodeSnapshot(context.projectId as string | null | undefined)} /> : null }),
    ];
    return () => off.toReversed().forEach((dispose) => dispose());
  };
});
