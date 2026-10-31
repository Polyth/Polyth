import "./styles.css";
import { useEffect, useState } from "react";
import type { AgentDescriptor, HarnessSnapshot, ModelRef, OpenCodePendingResponseDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { defineWebPackage } from "@polyth/web-sdk";
import { readHarnessSnapshots } from "@polyth/models/runtime-catalog";
import ModelPicker from "@polyth/models/model-picker";
import { setAgents, useStore } from "../../../apps/web/src/store.ts";
import { Button, Dialog, Notice, Select, Textarea } from "../../../apps/web/src/components/ui/index.ts";
import { EmptyState, ReadonlyRow, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import OpenCodeWarmSettings from "./OpenCodeWarmSettings.tsx";

/** Native role ids are lowercase config keys ("build", "plan"); show them as names. */
export const roleDisplayName = (name: string): string => name
  .replace(/[-_]+/g, " ")
  .replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());

function OpenCodeRoleEditor({ role, onClose }: { role: AgentDescriptor; onClose: () => void }) {
  const allModels = useStore((state) => state.models);
  const agents = useStore((state) => state.agents);
  const [prompt, setPrompt] = useState(role.prompt ?? "");
  const [mode, setMode] = useState<AgentDescriptor["mode"]>(
    role.mode === "all" || role.mode === "subagent" ? "primary" : role.mode,
  );
  const [model, setModel] = useState<ModelRef | undefined>(role.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  return <Dialog title={tr("opencode.roles.editTitle", { role: roleDisplayName(role.name) })} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{tr("opencode.roles.cancel")}</Button><Button busy={busy} onClick={() => void save()}>{tr("opencode.roles.save")}</Button></>}>
    <div className="pkg-opencode-role-form">
      <label>{tr("opencode.roles.roleType")}<Select label={tr("opencode.roles.roleType")} value={mode} options={[{ value: "primary", label: tr("opencode.roles.primary") }, { value: "auto", label: tr("opencode.roles.inherited") }]} onChange={(value) => setMode(value as AgentDescriptor["mode"])} /></label>
      {mode !== "auto" && (
        <div className="pkg-opencode-model-field">
          <span>{tr("opencode.roles.model")}</span>
          <ModelPicker
            models={allModels}
            harnessId="opencode"
            {...(model ? { value: model } : {})}
            direction="down"
            emptyLabel={tr("opencode.roles.defaultModel")}
            onPick={(picked) => setModel(picked ? { providerID: picked.providerID, modelID: picked.modelID } : undefined)}
          />
        </div>
      )}
      <label>{tr("opencode.roles.systemPrompt")}<Textarea rows={12} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <details><summary>{tr("opencode.roles.nativeOptions")}</summary><p>{tr("opencode.roles.nativeOptionsHint")}</p></details>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </div>
  </Dialog>;
}

function OpenCodeRoles() {
  const agents = useStore((state) => state.agents)
    .filter((agent) =>
      (!agent.harnessId || agent.harnessId === "opencode")
      && agent.name.toLowerCase() !== "compaction"
      && agent.mode !== "subagent");
  const models = useStore((state) => state.models);
  const [editing, setEditing] = useState<AgentDescriptor>();
  const modelName = (ref?: ModelRef) => ref
    ? models.find((model) => model.providerID === ref.providerID && model.modelID === ref.modelID && (!model.harnessId || model.harnessId === "opencode"))?.name ?? ref.modelID
    : "";
  return <div className="pkg-opencode-sections">
    <Section title={tr("opencode.roles.sectionTitle")} hint={tr("opencode.roles.sectionHint")}>
      {agents.length > 0 ? <div className="pkg-opencode-role-list">
        {agents.map((agent) => <article key={agent.name} className="pkg-opencode-role">
          <div><strong>{roleDisplayName(agent.name)}</strong><small>{modelName(agent.model) ? tr("opencode.roles.modelLine", { model: modelName(agent.model) }) : tr("opencode.roles.conversationModel")}</small></div>
          <p>{agent.description || tr("opencode.roles.executionRole")}</p>
          <Button size="sm" variant="quiet" aria-label={tr("opencode.roles.editAria", { role: roleDisplayName(agent.name) })} onClick={() => setEditing(agent)}>{tr("opencode.roles.edit")}</Button>
        </article>)}
      </div> : <EmptyState compact icon="assist" title={tr("opencode.roles.emptyTitle")} body={tr("opencode.roles.emptyBody")} />}
    </Section>
    {editing && <OpenCodeRoleEditor role={editing} onClose={() => setEditing(undefined)} />}
  </div>;
}

type RuntimeState = "running" | "unchecked" | "unavailable";
const runtimeStateLabel = (state: RuntimeState): string => state === "running" ? tr("opencode.runtime.stateRunning")
  : state === "unchecked" ? tr("opencode.runtime.stateUnchecked") : tr("opencode.runtime.stateUnavailable");
const runtimeState = (snapshot?: HarnessSnapshot): RuntimeState => !snapshot?.availability.healthy ? "unavailable"
  : snapshot.availability.state === "unknown" ? "unchecked" : "running";

function OpenCodeRuntime({ snapshot, refreshCatalog }: { snapshot?: HarnessSnapshot; refreshCatalog: () => Promise<void> }) {
  const spaceId = useStore((state) => state.projectRegistry.projects.find((project) => project.id === state.activeProjectId)?.spaceId ?? "default");
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
  const state = runtimeState(snapshot);
  return <div className="pkg-opencode-sections">
    {pending.count > 0 && <Section title={tr("opencode.runtime.pendingChanges", { count: pending.count })}
      hint={snapshot?.availability.healthy ? tr("opencode.runtime.pendingHintRunning") : tr("opencode.runtime.pendingHintStopped")}
      action={<Button variant="primary" size="sm" busy={busy} onClick={() => void apply()}>{tr("opencode.runtime.applyRestart")}</Button>}>
      {pending.changes.length > 0 && <ul className="pkg-opencode-pending-list">{pending.changes.map((change) => <li key={change.id}>{change.label}</li>)}</ul>}
      {error && <Notice tone="error" role="alert">{tr("opencode.runtime.applyFailed", { error })}</Notice>}
    </Section>}
    <Section title={tr("opencode.runtime.sectionTitle")} hint={tr("opencode.runtime.sectionHint")}>
      <ReadonlyRow label={tr("opencode.runtime.status")} value={<span className="pkg-opencode-status" data-state={state}>{runtimeStateLabel(state)}</span>} />
      {snapshot?.identity.version && <ReadonlyRow label={tr("opencode.runtime.version")} value={snapshot.identity.version} mono />}
      <ReadonlyRow label={tr("opencode.runtime.runsOn")} value={snapshot?.context.remote ? tr("opencode.runtime.remoteHost") : tr("opencode.runtime.thisMachine")} />
    </Section>
    <OpenCodeWarmSettings key={spaceId} />
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
      host.settings.registerPage({
        id: "opencode-runtime",
        label: tr("opencode.settings.runtimeLabel"),
        group: "Engineering",
        nav: false,
        redirect: { pageId: "harnesses", target: { itemId: "opencode", sectionId: "runtime" } },
        component: () => null,
      }),
      host.settings.registerItems([{ id: "opencode.runtime-policy", pageId: "opencode-runtime", label: tr("opencode.settings.warmWorkspacesLabel"), description: tr("opencode.settings.warmWorkspacesDescription"), keywords: ["warm", "spawn", "startup", "idle", "runtime", "OpenCode"], focusTarget: "opencode.runtime-policy" }]),
      // These sections remain package-owned contributions. Harnesses is the
      // sole composer and selects one section at a time.
      host.slots.register({ id: "opencode.roles", slot: "settings.harness.detail", order: 20, meta: { harnessId: "opencode", sectionId: "roles", label: tr("opencode.slots.roles") }, render: (context) => context.harnessId === "opencode" && context.sectionId === "roles" ? <OpenCodeRoles /> : null }),
      host.slots.register({ id: "opencode.runtime", slot: "settings.harness.detail", order: 80, meta: { harnessId: "opencode", sectionId: "runtime", label: tr("opencode.slots.runtime"), handlesPendingChanges: true }, render: (context) => context.harnessId === "opencode" && context.sectionId === "runtime" ? <OpenCodeRuntime snapshot={context.snapshot as HarnessSnapshot | undefined} refreshCatalog={() => refreshOpenCodeSnapshot(context.projectId as string | null | undefined)} /> : null }),
    ];
    return () => off.toReversed().forEach((dispose) => dispose());
  };
});
