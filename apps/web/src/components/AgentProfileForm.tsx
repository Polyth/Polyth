// Agent profile create/edit dialog (WP8). Seeded from the model chooser's pin
// action (provider/model immutable there) or opened blank from settings.
// Validation repairs render visibly; applying them is an explicit click.
import { useEffect, useState } from "react";
import type { AgentDescriptor, AgentProfile, HarnessSnapshot, ModelDescriptor } from "@polyth/contracts";
import { THINKING_LEVELS } from "@polyth/models";
import { api } from "@polyth/session/web-api";
import { useStore } from "../store.ts";
import { refreshProfiles } from "../profiles.ts";
import { modelDisplayName, modelSupportsTextWorkflow } from "../composer/discovery.ts";
import { tr } from "../i18n/index.ts";
import { Button, Dialog, Select, Textarea, TextInput } from "./ui/index.ts";

export interface ProfileFormProps {
  /** Existing profile to edit, or a seed for a new one. */
  existing?: AgentProfile;
  seed?: { harnessId?: string; providerID: string; modelID: string; name?: string };
  /** Model identity is immutable when opened from the pin flow. */
  lockModel?: boolean;
  onClose: () => void;
  /** Invoked after save; `use` is true when the user chose "Save and use". */
  onSaved?: (profile: AgentProfile, use: boolean) => void;
}

interface Repair { field: string; from: string; to: string; reason: string }

export default function AgentProfileForm({ existing, seed, lockModel, onClose, onSaved }: ProfileFormProps) {
  const globalAgents = useStore((s) => s.agents);
  const globalModels = useStore((s) => s.models);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeHarnessId = useStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)?.resolvedHarnessId);
  const inferredHarnessId = existing?.harnessId
    ?? seed?.harnessId
    ?? globalModels.find((model) => model.providerID === seed?.providerID && model.modelID === seed?.modelID)?.harnessId
    ?? activeHarnessId
    ?? "opencode";
  const [harnessId, setHarnessId] = useState(inferredHarnessId);
  const [harnesses, setHarnesses] = useState<HarnessSnapshot[]>([]);
  const [nativeCatalog, setNativeCatalog] = useState<{
    harnessId: string;
    models: ModelDescriptor[];
    agents: AgentDescriptor[];
  }>();
  useEffect(() => {
    let cancelled = false;
    void api.harnessSnapshots(activeProjectId ?? undefined).then((rows) => {
      if (!cancelled) setHarnesses(rows);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeProjectId]);
  useEffect(() => {
    let cancelled = false;
    setNativeCatalog(undefined);
    void api.harnessSnapshots(activeProjectId ?? undefined, true, harnessId).then((rows) => {
      if (cancelled) return;
      const catalog = rows[0]?.catalog;
      setNativeCatalog({
        harnessId,
        models: catalog?.models ?? [],
        agents: catalog?.agents ?? catalog?.roles ?? [],
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeProjectId, harnessId]);
  const models = nativeCatalog?.harnessId === harnessId
    ? nativeCatalog.models
    : globalModels.filter((model) => model.harnessId === harnessId);
  const agents = nativeCatalog?.harnessId === harnessId
    ? nativeCatalog.agents
    : globalAgents.filter((item) => item.harnessId === harnessId);
  const textModels = models.filter(modelSupportsTextWorkflow);
  const [name, setName] = useState(existing?.name ?? seed?.name ?? "");
  const [providerID, setProviderID] = useState(existing?.providerID ?? seed?.providerID ?? "");
  const [modelID, setModelID] = useState(existing?.modelID ?? seed?.modelID ?? "");
  const [agent, setAgent] = useState(existing?.agent ?? "");
  const [thinking, setThinking] = useState(existing?.thinking ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [color, setColor] = useState(existing?.color ?? "#7aa2f7");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [repairs, setRepairs] = useState<Repair[]>([]);

  // Editing an existing profile: check it against current capabilities so
  // invalid provider choices surface immediately, not at send time.
  useEffect(() => {
    if (!existing) return;
    void api.validateProfile(existing.id).then((r) => setRepairs(r.repairs)).catch(() => {});
  }, [existing]);

  const applyRepair = (r: Repair) => {
    if (r.field === "model") {
      const [p, ...rest] = r.to.split("/");
      setProviderID(p ?? "");
      setModelID(rest.join("/"));
    } else if (r.field === "agent") {
      setAgent(r.to);
    } else if (r.field === "thinking") {
      setThinking(r.to === "default" ? "" : r.to);
    }
    setRepairs((list) => list.filter((x) => x !== r));
  };

  const save = async (use: boolean) => {
    setBusy(true);
    setError("");
    try {
      const base = { name: name.trim(), harnessId, providerID, modelID, color, features: existing?.features ?? {} };
      const saved = existing
        ? await api.updateProfile(existing.id, {
            ...base,
            // null clears the column on PATCH (route maps null → cleared)
            agent: (agent || null) as unknown as string,
            thinking: (thinking || null) as unknown as string,
            notes: (notes || null) as unknown as string,
          }, existing.revision)
        : await api.createProfile({
            ...base,
            ...(agent ? { agent } : {}),
            ...(thinking ? { thinking } : {}),
            ...(notes ? { notes } : {}),
          });
      await refreshProfiles();
      onSaved?.(saved, use);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const modelOptions = [
    { value: "/", label: tr("agentprofileform.pickAModel") },
    ...textModels.map((model) => ({
      value: `${model.providerID}/${model.modelID}`,
      label: modelDisplayName(model, textModels),
    })),
  ];
  const modelValue = `${providerID}/${modelID}`;
  const agentOptions = [
    { value: "", label: tr("agentprofileform.default") },
    ...agents.filter((item) => !item.harnessId || item.harnessId === harnessId)
      .map((item) => ({ value: item.name, label: item.name })),
  ];
  const harnessOptions = [...new Map([
    [harnessId, harnesses.find((row) => row.identity.id === harnessId)?.identity.name ?? harnessId],
    ...harnesses.map((row) => [row.identity.id, row.identity.name] as const),
  ]).entries()].map(([value, label]) => ({ value, label }));
  const thinkingOptions = THINKING_LEVELS.map((level) => ({
    value: level,
    label: level || tr("agentprofileform.default"),
  }));

  return (
    <Dialog
      title={existing ? tr("agentprofileform.editProfile") : tr("agentprofileform.newAgentProfile")}
      onClose={onClose}
      className="profile-form"
      initialFocus="input"
      footer={(
        <>
          <Button size="sm" onClick={onClose}>{tr("common.cancel")}</Button>
          <span className="header-spacer" />
          <Button
            size="sm"
            disabled={busy || !name.trim() || !providerID || !modelID}
            onClick={() => void save(false)}
          >
            {tr("common.save")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            busy={busy}
            disabled={!name.trim() || !providerID || !modelID}
            onClick={() => void save(true)}
          >
            {tr("agentprofileform.saveAndUse")}
          </Button>
        </>
      )}
    >
      <div className="profile-form-body">
        <label>
          Harness<Select label="Harness" value={harnessId} options={harnessOptions} disabled={lockModel} onChange={(value) => {
            setHarnessId(value);
            setProviderID("");
            setModelID("");
            setAgent("");
          }} />
        </label>
        <label>
          {tr("agentprofileform.name")}<TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("agentprofileform.eGFastReviewer")} />
        </label>
        <label>
          {tr("agentprofileform.model")}{lockModel ? (
            <span className="mono profile-model-locked">{providerID}/{modelID}</span>
          ) : (
            <Select
              label={modelOptions.find((option) => option.value === modelValue)?.label ?? tr("agentprofileform.pickAModel")}
              value={modelValue}
              options={modelOptions}
              onChange={(value) => {
                const [p, ...rest] = value.split("/");
                setProviderID(p ?? "");
                setModelID(rest.join("/"));
              }}
              ariaLabel={tr("agentprofileform.model")}
            />
          )}
        </label>
        <label>
          {tr("agentprofileform.agent")}<Select
            label={agentOptions.find((option) => option.value === agent)?.label ?? tr("agentprofileform.default")}
            value={agent}
            options={agentOptions}
            onChange={setAgent}
            ariaLabel={tr("agentprofileform.agent")}
          />
        </label>
        <label>
          {tr("agentprofileform.thinking")}<Select
            label={thinkingOptions.find((option) => option.value === thinking)?.label ?? tr("agentprofileform.default")}
            value={thinking}
            options={thinkingOptions}
            onChange={setThinking}
            ariaLabel={tr("agentprofileform.thinking")}
          />
        </label>
        <label>
          {tr("agentprofileform.color")}<input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label>
          {tr("agentprofileform.notes")}<Textarea minRows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {repairs.length > 0 && (
          <div className="profile-repair" role="alert">
            <div className="stat-label">{tr("agentprofileform.needsRepair")}</div>
            {repairs.map((r, i) => (
              <div key={i} className="profile-repair-row">
                <span>{r.reason} (<span className="mono">{r.from}</span> → <span className="mono">{r.to || tr("agentprofileform.default")}</span>)</span>
                <Button size="sm" onClick={() => applyRepair(r)}>{tr("common.apply")}</Button>
              </div>
            ))}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
    </Dialog>
  );
}
