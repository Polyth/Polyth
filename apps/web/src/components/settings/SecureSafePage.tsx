import { useEffect, useState, type FormEvent } from "react";
import type { SecureSafeEntryDto } from "@polyth/contracts";
import { api } from "../../api.ts";
import { EmptyState, PageHead } from "./parts.tsx";

export default function SecureSafePage() {
  const [entries, setEntries] = useState<SecureSafeEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [handle, setHandle] = useState("");
  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      setEntries(await api.listSecureSafe());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!handle.trim() || !label.trim() || !value || busy) return;
    const writeOnlyValue = value;
    setValue("");
    setBusy(true);
    setError("");
    try {
      await api.saveSecureSafe({
        handle: handle.trim(),
        label: label.trim(),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        value: writeOnlyValue,
      });
      setHandle("");
      setLabel("");
      setPurpose("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: SecureSafeEntryDto) => {
    if (!window.confirm(`Delete the Secure Safe handle "${entry.handle}"?`)) return;
    setError("");
    try {
      await api.deleteSecureSafe(entry.id);
      setEntries((current) => current.filter((item) => item.id !== entry.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <PageHead
        title="Secure Safe"
        blurb="Store credentials behind reusable handles. Values are write-only and never returned by the API."
      />
      <div className="secure-safe-note" role="note">
        Agents may request or reference a handle, but cannot read its value. Never put credential
        values in prompts, <code>AGENTS.md</code>, or project configuration.
      </div>
      <div className="secure-safe-settings-list" data-settings-item="secure-safe.entries">
        <div className="stat-label">Saved handles ({entries.length})</div>
        {loading && <div className="muted">Loading handles…</div>}
        {!loading && entries.length === 0 && !error && (
          <EmptyState title="No saved handles" body="Add a credential below or respond to an agent request in chat." />
        )}
        {entries.map((entry) => (
          <div className="set-row" key={entry.handle}>
            <div className="set-row-text">
              <div className="set-row-label">{entry.label}</div>
              <div className="set-row-hint mono">{entry.handle}</div>
              {entry.purpose && <div className="set-row-hint">{entry.purpose}</div>}
            </div>
            <div className="set-row-control">
              <button className="small-btn danger-btn" onClick={() => void remove(entry)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      <form className="secure-safe-form" onSubmit={(event) => void add(event)}>
        <div className="stat-label">Add credential</div>
        <div className="secure-safe-form-row">
          <label>
            <span>Label</span>
            <input value={label} required placeholder="Deployment token" onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            <span>Handle</span>
            <input
              className="mono"
              value={handle}
              required
              placeholder="deploy-token"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setHandle(event.target.value)}
            />
          </label>
        </div>
        <label>
          <span>Purpose <small>(optional)</small></span>
          <input value={purpose} placeholder="Used for production deployments" onChange={(event) => setPurpose(event.target.value)} />
        </label>
        <label>
          <span>Credential value</span>
          <input
            type="password"
            autoComplete="off"
            value={value}
            required
            placeholder="Write-only value"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="secure-safe-form-actions">
          <button className="small-btn" type="submit" disabled={busy || !handle.trim() || !label.trim() || !value}>
            {busy ? "Saving…" : "Add to Secure Safe"}
          </button>
          <span className="muted">The value is cleared as soon as it is submitted.</span>
        </div>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
    </>
  );
}
