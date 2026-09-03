// "Open on a server (SSH)" — a project-create source contributed to the folder
// picker's `project.create.options` slot. It is disclosed *inline* inside the
// picker (no nested dialog). Because it browses a remote filesystem it is a
// `solo` source: while open, the picker hides its local file manager and this
// panel's own remote browser takes that space. Projects are created through
// /api/ssh/projects; the agent for such a project runs on the chosen host.
import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "../../../../apps/web/src/components/a11y/live.tsx";
import { api, type SshConnectionWithStatus } from "@polyth/session/web-api";
import type { SshBrowseDto } from "@polyth/contracts";
import { addSshProject } from "../../../../apps/web/src/init.ts";
import { connectionTarget, remoteBasename, stateBadge } from "./sshUi.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import {
  Button,
  Checkbox,
  HomeIcon,
  IconButton,
  ParentFolderIcon,
  Select,
  TextInput,
} from "../../../../apps/web/src/components/ui/index.ts";

const SOURCE_ID = "ssh-remote-project";

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const folderIcon = (
  <svg className="ui-icon ui-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6.5h7l2 2h9v10H3z" />
  </svg>
);

interface HostContext {
  busy: boolean;
  armedId: string | null;
  arm: (id: string, opts?: { soloBrowser?: boolean }) => void;
  disarm: (id: string) => void;
  onProjectOpened?: () => void;
}

function readContext(props: Record<string, unknown>): HostContext {
  return {
    busy: props.busy === true,
    armedId: typeof props.armedId === "string" ? props.armedId : null,
    arm: typeof props.arm === "function"
      ? props.arm as HostContext["arm"]
      : () => undefined,
    disarm: typeof props.disarm === "function" ? props.disarm as (id: string) => void : () => undefined,
    onProjectOpened: typeof props.onProjectOpened === "function"
      ? props.onProjectOpened as () => void
      : undefined,
  };
}

function SshInlinePanel({ ctx, onCancel }: { ctx: HostContext; onCancel: () => void }) {
  const [connections, setConnections] = useState<SshConnectionWithStatus[] | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [browse, setBrowse] = useState<SshBrowseDto | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [createDirectory, setCreateDirectory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const busy = submitting || ctx.busy;

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
  const suggestedName = nameTouched ? name : remoteBasename(target);

  const create = async () => {
    if (!connectionId || !target || busy) return;
    setSubmitting(true);
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
      ctx.onProjectOpened?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="folder-source-panel ssh-source-panel"
      role="group"
      aria-label={tr("ssh.sshprojectsource.openAProjectOnAServer")}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); if (!busy) onCancel(); }
      }}
    >
      <p className="folder-source-hint">{tr("ssh.sshprojectsource.theCodingAgentRunsOnTheServer")}</p>

      {connections !== null && connections.length === 0 ? (
        <>
          <p className="folder-empty">{tr("ssh.sshprojectsource.noSshServersConfiguredYetAddOne")}</p>
          <div className="folder-source-actions">
            <Button size="sm" variant="ghost" onClick={onCancel}>{tr("common.cancel")}</Button>
          </div>
        </>
      ) : (
        <>
          <label className="folder-source-field ssh-dialog-server">
            <span>{tr("ssh.sshprojectsource.server")}</span>
            <Select
              label={tr("ssh.sshprojectsource.server")}
              value={connectionId}
              disabled={busy || loading}
              onChange={setConnectionId}
              options={(connections ?? []).map((conn) => ({
                value: conn.id,
                label: `${conn.name} (${connectionTarget(conn)}) — ${stateBadge(conn.status?.state).text}`,
              }))}
            />
          </label>

          <div className="folder-toolbar">
            <IconButton
              icon={HomeIcon}
              size="sm"
              title={tr("ssh.sshprojectsource.remoteHomeDirectory")}
              label={tr("ssh.sshprojectsource.goToRemoteHomeDirectory")}
              disabled={busy || loading || !browse}
              onClick={() => browse && void loadDir(connectionId, browse.home)}
            />
            <IconButton
              icon={ParentFolderIcon}
              size="sm"
              title={tr("ssh.sshprojectsource.parentFolder")}
              label={tr("ssh.sshprojectsource.goToParentFolder")}
              disabled={busy || loading || !browse?.parent}
              onClick={() => browse?.parent && void loadDir(connectionId, browse.parent)}
            />
            <TextInput
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
            <label className="folder-source-field ssh-dialog-name">
              <span>{tr("ssh.sshprojectsource.projectName")}</span>
              <TextInput
                value={suggestedName}
                placeholder={tr("ssh.sshprojectsource.remoteProject")}
                disabled={busy}
                onChange={(e) => { setNameTouched(true); setName(e.target.value); }}
              />
            </label>
            <Checkbox
              className="ssh-dialog-create"
              checked={createDirectory}
              disabled={busy}
              onChange={setCreateDirectory}
              label={tr("ssh.sshprojectsource.createTheFolderIfItDoesnT")}
            />
          </div>

          {error && <div className="form-error folder-error" role="alert">{error}</div>}

          <div className="folder-source-actions">
            <span className="folder-selected mono" title={target}>{target}</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{tr("common.cancel")}</Button>
            <Button
              size="sm"
              variant="primary"
              busy={submitting}
              disabled={busy || loading || !connectionId || !target}
              onClick={() => void create()}
            >
              {tr("ssh.sshprojectsource.openRemoteProject")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Slot contribution: the disclosure chip plus, when open, the inline panel. */
export default function SshProjectSource(props: Record<string, unknown>) {
  const ctx = readContext(props);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const armRef = useRef(ctx.arm);
  const disarmRef = useRef(ctx.disarm);
  armRef.current = ctx.arm;
  disarmRef.current = ctx.disarm;

  useEffect(() => {
    if (!open) return;
    armRef.current(SOURCE_ID, { soloBrowser: true });
    return () => disarmRef.current(SOURCE_ID);
  }, [open]);

  useEffect(() => {
    if (open && ctx.armedId !== null && ctx.armedId !== SOURCE_ID) setOpen(false);
  }, [ctx.armedId, open]);

  const close = () => {
    setOpen(false);
    chipRef.current?.focus();
  };
  const otherArmed = ctx.armedId !== null && ctx.armedId !== SOURCE_ID;

  return (
    <>
      <Button
        ref={chipRef}
        type="button"
        variant="ghost"
        className="ghost-link ssh-open-remote folder-source-chip"
        aria-expanded={open}
        disabled={ctx.busy || otherArmed}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {tr("ssh.sshprojectsource.openOnAServer")}
      </Button>
      {open && <SshInlinePanel ctx={ctx} onCancel={close} />}
    </>
  );
}
