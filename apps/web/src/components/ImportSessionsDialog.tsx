// F14 import half: browse OpenCode sessions that are not yet adopted into
// Polyth and import the selected ones. Listing no longer auto-adopts, so this
// sheet is the only way backend-only sessions enter the sidebar. History is
// hydrated lazily the first time an imported session is opened.
import { useEffect, useState } from "react";
import type { RuntimeSession } from "@polyth/contracts";
import { api } from "../api.ts";
import { refreshSessions } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { ago } from "../format.ts";
import Dialog from "./a11y/Dialog.tsx";

export default function ImportSessionsDialog({ projectId, onClose }: {
  projectId: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<RuntimeSession[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api.backendSessions(projectId).then((r) => {
      if (!active) return;
      setItems(r.items);
      setTotal(r.total);
      setSelected(new Set(r.items.map((s) => s.id))); // preselect everything
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(friendlyError("Couldn’t list OpenCode sessions", cause));
      setLoading(false);
    });
    return () => { active = false; };
  }, [projectId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doImport = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError("");
    try {
      await api.importBackendSessions(projectId, [...selected]);
      await refreshSessions(projectId);
      onClose();
    } catch (cause) {
      setError(friendlyError("Couldn’t import the sessions", cause));
      setBusy(false);
    }
  };

  const allOn = items.length > 0 && selected.size === items.length;

  return (
    <Dialog title="Import sessions" onClose={() => { if (!busy) onClose(); }} className="import-sessions-dialog">
      <div className="dialog-head">
        <div>
          <h2>Import sessions</h2>
          <p className="muted">OpenCode sessions in this workspace that Polyth has not adopted yet.</p>
        </div>
        <button className="icon-btn" aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button>
      </div>

      <div className="import-sessions-body">
        {loading && <div className="empty">Looking for OpenCode sessions…</div>}
        {/* distinct empty states (PS#766): nothing exists vs everything imported */}
        {!loading && !error && items.length === 0 && total === 0 && (
          <div className="empty">No OpenCode sessions were found for this workspace.</div>
        )}
        {!loading && !error && items.length === 0 && total > 0 && (
          <div className="empty">All {total} OpenCode session{total === 1 ? "" : "s"} here {total === 1 ? "is" : "are"} already imported.</div>
        )}
        {!loading && items.length > 0 && (
          <>
            <label className="import-session-row import-session-all">
              <input
                type="checkbox"
                checked={allOn}
                onChange={() => setSelected(allOn ? new Set() : new Set(items.map((s) => s.id)))}
              />
              <span><strong>Select all</strong> <small className="muted">{selected.size} of {items.length}</small></span>
            </label>
            <div className="import-session-list">
              {items.map((s) => (
                <label key={s.id} className="import-session-row">
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                  <span>
                    <strong>{s.title || s.id}</strong>
                    <small className="muted">updated {ago(s.updatedAt)} ago · {s.id}</small>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>

      <div className="dialog-foot">
        <span className="muted">History loads the first time an imported session is opened.</span>
        <span className="header-spacer" />
        <button className="small-btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy || loading || selected.size === 0} onClick={() => void doImport()}>
          {busy ? "Importing…" : `Import ${selected.size || ""}`.trim()}
        </button>
      </div>
    </Dialog>
  );
}
