// "Open on a server (SSH)" — the project-create option contributed to the
// `project.create.options` slot inside the folder picker. Opens a remote
// directory picker over /api/ssh/browse and registers the project through
// /api/ssh/projects; the agent for such a project runs on the chosen host.
import { useCallback, useEffect, useRef, useState } from "react";
import Dialog from "../../../../apps/web/src/components/a11y/Dialog.tsx";
import { announce } from "../../../../apps/web/src/components/a11y/live.tsx";
import { api, type SshConnectionWithStatus } from "@polyth/session/web-api";
import type { SshBrowseDto } from "@polyth/contracts";
import { addSshProject } from "../../../../apps/web/src/init.ts";
import { connectionTarget, remoteBasename, stateBadge } from "./sshUi.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const folderIcon = (
  <svg className="ui-icon ui-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6.5h7l2 2h9v10H3z" />
  </svg>
);

function SshProjectDialog({ onClose, onOpened }: {
  onClose: () => void;
  /** Called after the project was created and applied to the store. */
  onOpened: () => void;
}) {
  const [connections, setConnections] = useState<SshConnectionWithStatus[] | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [browse, setBrowse] = useState<SshBrowseDto | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [createDirectory, setCreateDirectory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    void api.sshConnections()
      .then((r) => {
        setConnections(r.items);
        if (r.items[0]) setConnectionId(r.items[0].id);
      })
      .catch((cause: unknown) => {
        setConnections([]);
        setError(errorText(cause));
      });
  }, []);

  const loadDir = useCallback(async (id: string, path?: string) => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const dto = await api.sshBrowse(id, path);
      setBrowse(dto);
      setPathInput(dto.path);
      setSelected(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connectionId) void loadDir(connectionId);
  }, [connectionId, loadDir]);

  const target = selected ?? pathInput.trim();

  const create = async () => {
    if (!connectionId || !target || busyRef.current) return;
    setBusy(true);
    setError("");
    try {
      const project = await addSshProject({
        connectionId,
        path: target,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(createDirectory ? { createDirectory: true } : {}),
      });
      announce(tr("ssh.sshprojectsource.openedValueOnValue", {
        name: project.name,
        value: connections?.find((c) => c.id === connectionId)?.name
          ?? tr("ssh.sshprojectsource.server"),
      }));
      onOpened();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (busyRef.current) return;
    onClose();
  };

  const suggestedName = nameTouched ? name : remoteBasename(target);

  return (
    <Dialog title={tr("ssh.sshprojectsource.openAProjectOnAServer")} onClose={requestClose} size="lg" className="ssh-project-dialog">
      <div className="folder-dialog-body">
        <div className="folder-dialog-head">
          <div>
            <div className="folder-dialog-title">{tr("ssh.sshprojectsource.openAProjectOnAServer")}</div>
            <div className="folder-dialog-subtitle">
              {tr("ssh.sshprojectsource.theCodingAgentRunsOnTheServer")}</div>
          </div>
          <button className="icon-btn" aria-label={tr("common.close")} disabled={busy} onClick={requestClose}>✕</button>
        </div>

        {connections !== null && connections.length === 0 ? (
          <p className="folder-empty">
            {tr("ssh.sshprojectsource.noSshServersConfiguredYetAddOne")}</p>
        ) : (
          <>
            <label className="ssh-dialog-server">
              {tr("ssh.sshprojectsource.server")}<select
                value={connectionId}
                disabled={busy || loading}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                {(connections ?? []).map((conn) => (
                  <option key={conn.id} value={conn.id}>
                    {conn.name} ({connectionTarget(conn)}) — {stateBadge(conn.status?.state).text}
                  </option>
                ))}
              </select>
            </label>

            <div className="folder-toolbar">
              <button
                className="small-btn"
                title={tr("ssh.sshprojectsource.remoteHomeDirectory")}
                aria-label={tr("ssh.sshprojectsource.goToRemoteHomeDirectory")}
                disabled={busy || loading || !browse}
                onClick={() => browse && void loadDir(connectionId, browse.home)}
              >
                ~
              </button>
              <button
                className="small-btn"
                title={tr("ssh.sshprojectsource.parentFolder")}
                aria-label={tr("ssh.sshprojectsource.goToParentFolder")}
                disabled={busy || loading || !browse?.parent}
                onClick={() => browse?.parent && void loadDir(connectionId, browse.parent)}
              >
                ↑
              </button>
              <input
                className="folder-path mono"
                value={pathInput}
                aria-label={tr("ssh.sshprojectsource.remotePath")}
                spellCheck={false}
                disabled={busy}
                onChange={(e) => { setPathInput(e.target.value); setSelected(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) void loadDir(connectionId, pathInput.trim() || undefined);
                }}
              />
            </div>

            <div
              className="folder-list ssh-remote-list"
              role="listbox"
              aria-label={tr("ssh.sshprojectsource.remoteFolders")}
              aria-busy={loading || undefined}
              tabIndex={0}
              aria-activedescendant={selected
                ? `ssh-folder-${(browse?.entries ?? []).findIndex((entry) => entry.path === selected)}`
                : undefined}
              onKeyDown={(event) => {
                const entries = browse?.entries ?? [];
                const index = entries.findIndex((entry) => entry.path === selected);
                if (event.key === "Enter" && index >= 0) {
                  event.preventDefault();
                  void loadDir(connectionId, entries[index]!.path);
                  return;
                }
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || entries.length === 0) return;
                event.preventDefault();
                const nextIndex = event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? entries.length - 1
                    : event.key === "ArrowDown"
                      ? Math.min(entries.length - 1, index + 1)
                      : Math.max(0, index < 0 ? 0 : index - 1);
                const next = entries[nextIndex];
                if (next) {
                  setSelected(next.path);
                  document.getElementById(`ssh-folder-${nextIndex}`)?.scrollIntoView({ block: "nearest" });
                }
              }}
            >
              {(browse?.entries ?? []).map((entry, index) => (
                <div
                  key={entry.path}
                  id={`ssh-folder-${index}`}
                  className={`folder-row ${selected === entry.path ? "selected" : ""}`}
                  role="option"
                  aria-selected={selected === entry.path}
                  onClick={() => {
                    if (busy) return;
                    if (window.matchMedia?.("(pointer: coarse)").matches) {
                      void loadDir(connectionId, entry.path);
                      return;
                    }
                    setSelected(entry.path);
                  }}
                  onDoubleClick={() => { if (!busy) void loadDir(connectionId, entry.path); }}
                >
                  <span className="folder-row-icon">{folderIcon}</span>
                  <span className="folder-row-name">{entry.name}</span>
                  <span className="folder-row-meta" />
                  <span className="folder-row-enter" aria-hidden="true">{tr("projectfolderdialog.enterFolder")} <span>›</span></span>
                </div>
              ))}
              {browse && browse.entries.length === 0 && !loading && (
                <div className="folder-empty">{tr("ssh.sshprojectsource.noSubFoldersHereOpenThisFolder")}</div>
              )}
              {loading && <div className="folder-empty">{tr("common.loading")}</div>}
            </div>

            <div className="ssh-dialog-meta">
              <label className="ssh-dialog-name">
                {tr("ssh.sshprojectsource.projectName")}<input
                  value={suggestedName}
                  placeholder={tr("ssh.sshprojectsource.remoteProject")}
                  disabled={busy}
                  onChange={(e) => { setNameTouched(true); setName(e.target.value); }}
                />
              </label>
              <label className="ssh-dialog-create">
                <input
                  type="checkbox"
                  checked={createDirectory}
                  disabled={busy}
                  onChange={(e) => setCreateDirectory(e.target.checked)}
                />
                {tr("ssh.sshprojectsource.createTheFolderIfItDoesnT")}</label>
            </div>

            {error && <div className="form-error folder-error" role="alert">{error}</div>}

            <div className="folder-foot">
              <span className="header-spacer" />
              <span className="folder-selected mono" title={target}>{target}</span>
              <button
                className="primary-btn"
                disabled={busy || loading || !connectionId || !target}
                onClick={() => void create()}
              >
                {busy ? tr("ssh.sshprojectsource.opening") : tr("ssh.sshprojectsource.openRemoteProject")}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Slot contribution: renders the alternative-source button; the dialog nests
 *  above the folder picker and, on success, completes the picker through the
 *  host-provided `onProjectOpened` callback. */
export default function SshProjectSource(props: Record<string, unknown>) {
  const [open, setOpen] = useState(false);
  const onProjectOpened = typeof props.onProjectOpened === "function"
    ? (props.onProjectOpened as () => void)
    : undefined;
  const pickerBusy = props.busy === true;

  return (
    <>
      <button
        type="button"
        className="ghost-link ssh-open-remote"
        disabled={pickerBusy}
        onClick={() => setOpen(true)}
      >
        {tr("ssh.sshprojectsource.openOnAServer")}</button>
      {open && (
        <SshProjectDialog
          onClose={() => setOpen(false)}
          onOpened={() => {
            setOpen(false);
            onProjectOpened?.();
          }}
        />
      )}
    </>
  );
}
