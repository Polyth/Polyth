// Agent profile create/edit dialog (WP8). Seeded from the model chooser's pin
// action (provider/model immutable there) or opened blank from settings.
// Validation repairs render visibly; applying them is an explicit click.
import { useEffect, useState } from "react";
import type { AgentProfile } from "@polyth/contracts";
import { THINKING_LEVELS } from "@polyth/models";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { refreshProfiles } from "../profiles.ts";
import Dialog from "./a11y/Dialog.tsx";
import { modelDisplayName, modelSupportsTextWorkflow } from "../composer/discovery.ts";

export interface ProfileFormProps {
  /** Existing profile to edit, or a seed for a new one. */
  existing?: AgentProfile;
  seed?: { providerID: string; modelID: string; name?: string };
  /** Model identity is immutable when opened from the pin flow. */
  lockModel?: boolean;
  onClose: () => void;
  /** Invoked after save; `use` is true when the user chose "Save and use". */
  onSaved?: (profile: AgentProfile, use: boolean) => void;
}

interface Repair { field: string; from: string; to: string; reason: string }

export default function AgentProfileForm({ existing, seed, lockModel, onClose, onSaved }: ProfileFormProps) {
  const agents = useStore((s) => s.agents);
  const models = useStore((s) => s.models);
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
      const base = { name: name.trim(), providerID, modelID, color, features: existing?.features ?? {} };
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

  return (
    <Dialog title={existing ? "Edit profile" : "New agent profile"} onClose={onClose} className="profile-form" initialFocus="input">
      <div className="dialog-head">
        <span>{existing ? "Edit profile" : "New agent profile"}</span>
        <span className="header-spacer" />
        <button className="small-btn" onClick={onClose}>✕</button>
      </div>
      <div className="profile-form-body">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fast reviewer" />
        </label>
        <label>
          Model
          {lockModel || existing ? (
            <span className="mono profile-model-locked">{providerID}/{modelID}</span>
          ) : (
            <select
              value={`${providerID}/${modelID}`}
              onChange={(e) => {
                const [p, ...rest] = e.target.value.split("/");
                setProviderID(p ?? "");
                setModelID(rest.join("/"));
              }}
            >
              <option value="/">Pick a model…</option>
              {textModels.map((m) => (
                <option key={`${m.providerID}/${m.modelID}`} value={`${m.providerID}/${m.modelID}`}>
                  {modelDisplayName(m, textModels)}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          Agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Default</option>
            {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
        </label>
        <label>
          Thinking
          <select value={thinking} onChange={(e) => setThinking(e.target.value)}>
            {THINKING_LEVELS.map((l) => <option key={l || "default"} value={l}>{l || "default"}</option>)}
          </select>
        </label>
        <label>
          Color
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {repairs.length > 0 && (
          <div className="profile-repair" role="alert">
            <div className="stat-label">Needs repair</div>
            {repairs.map((r, i) => (
              <div key={i} className="profile-repair-row">
                <span>{r.reason} (<span className="mono">{r.from}</span> → <span className="mono">{r.to || "default"}</span>)</span>
                <button className="small-btn" onClick={() => applyRepair(r)}>Apply</button>
              </div>
            ))}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="dialog-foot">
        <button className="small-btn" onClick={onClose}>Cancel</button>
        <span className="header-spacer" />
        <button className="small-btn" disabled={busy || !name.trim() || !providerID || !modelID} onClick={() => void save(false)}>
          Save
        </button>
        <button className="primary-btn" style={{ padding: "5px 14px", fontSize: 12 }}
          disabled={busy || !name.trim() || !providerID || !modelID} onClick={() => void save(true)}>
          Save and use
        </button>
      </div>
    </Dialog>
  );
}
