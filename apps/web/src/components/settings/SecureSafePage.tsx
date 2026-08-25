import { useEffect, useState, type FormEvent } from "react";
import type { SecureSafeEntryDto } from "@polyth/contracts";
import { api } from "../../api.ts";
import { confirmAlert } from "../../alerts.ts";
import { EmptyState, PageHead } from "./parts.tsx";
import { tr } from "../../i18n/index.ts";

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
    if (!await confirmAlert(tr("settings.securesafepage.deleteTheSecureSafeHandleValue", { handle: entry.handle }), { title: tr("settings.securesafepage.deleteSecureSafeHandle"), confirmLabel: tr("common.delete") })) return;
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
        title={tr("settings.securesafepage.secureSafe")}
        blurb={tr("settings.securesafepage.storeCredentialsBehindReusableHandlesValuesAre")}
      />
      <div className="secure-safe-note" role="note">
        {tr("settings.securesafepage.agentsMayRequestOrReferenceAHandle")}<code>{tr("settings.securesafepage.agentsMd")}</code>{tr("settings.securesafepage.orProjectConfiguration")}</div>
      <div className="secure-safe-settings-list" data-settings-item="secure-safe.entries">
        <div className="stat-label">{tr("settings.securesafepage.savedHandles")}{entries.length})</div>
        {loading && <div className="muted">{tr("settings.securesafepage.loadingHandles")}</div>}
        {!loading && entries.length === 0 && !error && (
          <EmptyState
            title={tr("settings.securesafepage.noSavedHandles")}
            body={tr("settings.securesafepage.addACredentialBelowOrRespondToAn")}
          />
        )}
        {entries.map((entry) => (
          <div className="set-row" key={entry.handle}>
            <div className="set-row-text">
              <div className="set-row-label">{entry.label}</div>
              <div className="set-row-hint mono">{entry.handle}</div>
              {entry.purpose && <div className="set-row-hint">{entry.purpose}</div>}
            </div>
            <div className="set-row-control">
              <button className="small-btn danger-btn" onClick={() => void remove(entry)}>{tr("common.delete")}</button>
            </div>
          </div>
        ))}
      </div>
      <form className="secure-safe-form" onSubmit={(event) => void add(event)}>
        <div className="stat-label">{tr("settings.securesafepage.addCredential")}</div>
        <div className="secure-safe-form-row">
          <label>
            <span>{tr("settings.securesafepage.label")}</span>
            <input value={label} required placeholder={tr("settings.securesafepage.deploymentToken")} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            <span>{tr("settings.securesafepage.handle")}</span>
            <input
              className="mono"
              value={handle}
              required
              placeholder={tr("settings.securesafepage.deployToken")}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setHandle(event.target.value)}
            />
          </label>
        </div>
        <label>
          <span>{tr("settings.securesafepage.purpose")}{" "}<small>{tr("settings.securesafepage.optional")}</small></span>
          <input value={purpose} placeholder={tr("settings.securesafepage.usedForProductionDeployments")} onChange={(event) => setPurpose(event.target.value)} />
        </label>
        <label>
          <span>{tr("settings.securesafepage.credentialValue")}</span>
          <input
            type="password"
            autoComplete="off"
            value={value}
            required
            placeholder={tr("settings.securesafepage.writeOnlyValue")}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="secure-safe-form-actions">
          <button className="small-btn" type="submit" disabled={busy || !handle.trim() || !label.trim() || !value}>
            {busy ? tr("common.saving") : tr("settings.securesafepage.addToSecureSafe")}
          </button>
          <span className="muted">{tr("settings.securesafepage.theValueIsClearedAsSoonAs")}</span>
        </div>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
    </>
  );
}
