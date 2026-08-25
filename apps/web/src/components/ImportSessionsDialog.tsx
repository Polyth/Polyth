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
import { tr } from "../i18n/index.ts";

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
      setError(friendlyError(tr("common.error"), cause));
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
      setError(friendlyError(tr("common.error"), cause));
      setBusy(false);
    }
  };

  const allOn = items.length > 0 && selected.size === items.length;

  return (
    <Dialog title={tr("importsessionsdialog.importSessions")} onClose={() => { if (!busy) onClose(); }} className="import-sessions-dialog">
      <div className="dialog-head">
        <div>
          <h2>{tr("importsessionsdialog.importSessions")}</h2>
          <p className="muted">{tr("importsessionsdialog.opencodeSessionsInThisWorkspaceThatPolyth")}</p>
        </div>
        <button className="icon-btn" aria-label={tr("importsessionsdialog.closeDialog")} disabled={busy} onClick={onClose}>{tr("importsessionsdialog.message")}</button>
      </div>

      <div className="import-sessions-body">
        {loading && <div className="empty">{tr("importsessionsdialog.lookingForOpencodeSessions")}</div>}
        {/* distinct empty states (PS#766): nothing exists vs everything imported */}
        {!loading && !error && items.length === 0 && total === 0 && (
          <div className="empty">{tr("importsessionsdialog.noOpencodeSessionsWereFoundForThis")}</div>
        )}
        {!loading && !error && items.length === 0 && total > 0 && (
          <div className="empty">{tr("importsessionsdialog.all")}{" "}{total} {tr("importsessionsdialog.opencodeSession")}{total === 1 ? "" : tr("importsessionsdialog.s")} {tr("importsessionsdialog.here")}{" "}{total === 1 ? tr("importsessionsdialog.is") : tr("importsessionsdialog.are")} {tr("importsessionsdialog.alreadyImported")}</div>
        )}
        {!loading && items.length > 0 && (
          <>
            <label className="import-session-row import-session-all">
              <input
                type="checkbox"
                checked={allOn}
                onChange={() => setSelected(allOn ? new Set() : new Set(items.map((s) => s.id)))}
              />
              <span><strong>{tr("importsessionsdialog.selectAll")}</strong> <small className="muted">{selected.size} {tr("importsessionsdialog.of")}{" "}{items.length}</small></span>
            </label>
            <div className="import-session-list">
              {items.map((s) => (
                <label key={s.id} className="import-session-row">
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                  <span>
                    <strong>{s.title || s.id}</strong>
                    <small className="muted">{tr("importsessionsdialog.updated")}{" "}{ago(s.updatedAt)} {tr("importsessionsdialog.ago")}{" "}{s.id}</small>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>

      <div className="dialog-foot">
        <span className="muted">{tr("importsessionsdialog.historyLoadsTheFirstTimeAnImported")}</span>
        <span className="header-spacer" />
        <button className="small-btn" disabled={busy} onClick={onClose}>{tr("common.cancel")}</button>
        <button className="primary-btn" disabled={busy || loading || selected.size === 0} onClick={() => void doImport()}>
          {busy ? tr("importsessionsdialog.importing") : `Import ${selected.size || ""}`.trim()}
        </button>
      </div>
    </Dialog>
  );
}
