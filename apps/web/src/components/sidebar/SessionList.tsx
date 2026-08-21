// Organized session list (WP5): folder grouping, labels, attention badges,
// inline rename, archived section, bulk archive/restore with partial-failure
// reporting. All mutations go through the REST org endpoints.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionFolderDto, SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { api } from "../../api.ts";
import { getState, setSidebarOpen, setUiError, useStore } from "../../store.ts";
import { openSession, archiveSession, restoreSession, forkSession, refreshSessions } from "../../init.ts";
import { ago, deriveSessionTitle, fullSessionTitle } from "../../format.ts";
import { friendlyError } from "../../settings.ts";
import { getUiSettings } from "../../uiPrefs.ts";
import { firstUserText } from "../../utils.ts";
import { announce } from "../a11y/live.tsx";
import { worktreeLabel } from "../../worktreeSessions.ts";
import SlotHost from "../slots/SlotHost.ts";
import {
  groupSessions,
  listGroupings,
  reorderPinnedSessions,
  sortPinnedSessions,
  useGroupingMode,
} from "../../sidebarPrefs.ts";

const STATUS_DOT: Record<string, string> = {
  working: "working", waiting: "waiting", idle: "idle",
  finished: "finished", failed: "failed", archived: "archived",
};

function activityTime(updatedAt: number, relative: boolean): string {
  if (relative) return ago(updatedAt);
  return new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AttentionBadges({ s }: { s: SessionProjection }) {
  const a = s.attention;
  if (!a || (a.questions === 0 && a.permissions === 0)) return null;
  return (
    <span className="attn-badges">
      {a.questions > 0 && <span className="attn-badge q" title={`${a.questions} open question(s)`}>?{a.questions}</span>}
      {a.permissions > 0 && <span className="attn-badge p" title={`${a.permissions} open permission(s)`}>!{a.permissions}</span>}
    </span>
  );
}

function LabelDots({ ids, labels }: { ids: string[] | undefined; labels: WorkspaceLabel[] }) {
  if (!ids || ids.length === 0) return null;
  return (
    <span className="label-dots">
      {ids.map((id) => {
        const l = labels.find((x) => x.id === id);
        return l ? <span key={id} className="label-dot" title={l.name} style={{ background: l.color }} /> : null;
      })}
    </span>
  );
}

interface RowProps {
  s: SessionProjection;
  activeSessionId: string | null;
  labels: WorkspaceLabel[];
  folders: SessionFolderDto[];
  eventsTitle: string | undefined;
  relativeTime: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
  onTogglePin: (session: SessionProjection) => void;
  pinnedSection: boolean;
  onPinDragStart: (id: string) => void;
  onPinDrop: (targetId: string) => void;
}

function SessionRow({
  s, activeSessionId, labels, folders, eventsTitle, relativeTime, selectMode, selected,
  onToggleSelect, onChanged, onOpen, onTogglePin, pinnedSection, onPinDragStart, onPinDrop,
}: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  const doRename = async () => {
    const t = title.trim();
    setRenaming(false);
    if (!t || t === s.title) return;
    try {
      await api.renameSession(s.id, t);
      announce(`Session renamed to ${t}`);
      onChanged();
    } catch (e) {
      setUiError(friendlyError("Couldn’t rename the session", e));
    }
  };

  const moveToFolder = async (folderId: string | null) => {
    setMenuOpen(false);
    try {
      await api.organizeSession(s.id, { folderId });
      onChanged();
    } catch (e) {
      setUiError(friendlyError("Couldn’t move the session", e));
    }
  };

  const toggleLabel = async (labelId: string) => {
    const cur = s.labelIds ?? [];
    const next = cur.includes(labelId) ? cur.filter((x) => x !== labelId) : [...cur, labelId];
    try {
      await api.organizeSession(s.id, { labelIds: next });
      onChanged();
    } catch (e) {
      setUiError(friendlyError("Couldn’t update session labels", e));
    }
  };
  const displayTitle = deriveSessionTitle(s.title, eventsTitle);
  const hoverTitle = fullSessionTitle(s.title, eventsTitle);

  return (
    <div
      className={`session-row ${s.id === activeSessionId ? "active" : ""} ${s.status === "archived" ? "archived" : ""}`}
      draggable={pinnedSection}
      onDragStart={() => { if (pinnedSection) onPinDragStart(s.id); }}
      onDragOver={(event) => { if (pinnedSection) event.preventDefault(); }}
      onDrop={(event) => { if (pinnedSection) { event.preventDefault(); onPinDrop(s.id); } }}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="session-check"
          checked={selected}
          aria-label={`Select ${s.title || "session"}`}
          onChange={() => onToggleSelect(s.id)}
        />
      )}
      {renaming ? (
        <input
          className="session-rename-input"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void doRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doRename();
            else if (e.key === "Escape") { setTitle(s.title); setRenaming(false); }
          }}
        />
      ) : (
        <button
          className="session-btn"
          aria-current={s.id === activeSessionId ? "true" : undefined}
          title={hoverTitle}
          onClick={() => onOpen(s.id)}
          onDoubleClick={() => { setTitle(s.title); setRenaming(true); }}
        >
          <span className={`dot ${STATUS_DOT[s.status] ?? "idle"}`} />
          <span className="session-body">
            <span className="session-title-line">
              <span className="session-title">{displayTitle}</span>
              {s.worktreePath && (
                <span
                  className={`session-worktree-badge${s.worktreeState === "missing" ? " missing" : ""}`}
                  title={`${s.worktreeState === "missing" ? "Missing worktree" : "Worktree"}: ${s.worktreePath}`}
                >
                  {worktreeLabel(s.branch, s.worktreePath)}
                </span>
              )}
              {s.pinned && <span className="session-pin" title="Pinned" aria-label="Pinned">◆</span>}
              <LabelDots ids={s.labelIds} labels={labels} />
              <AttentionBadges s={s} />
              <SlotHost
                slot="session.list.badges"
                context={{ sessionId: s.id, questions: s.attention?.questions ?? 0, permissions: s.attention?.permissions ?? 0 }}
              />
            </span>
            <span className="session-sub">
              {s.worktreeState === "missing" ? "worktree missing" : s.status === "working" ? "Agent working" : s.status}
            </span>
          </span>
          <span className="session-time">{activityTime(s.updatedAt, relativeTime)}</span>
        </button>
      )}
      <span className="session-actions">
        <button title="Session menu" aria-label={`Menu for ${s.title || "session"}`} aria-haspopup="menu" onClick={() => setMenuOpen((v) => !v)}>⋯</button>
      </span>
      {menuOpen && (
        <div className="session-menu" role="menu" ref={menuRef}>
          <button role="menuitem" onClick={() => { setMenuOpen(false); setTitle(s.title); setRenaming(true); }}>Rename</button>
          <button role="menuitem" onClick={() => {
            setMenuOpen(false);
            void forkSession(s.id).catch((e) => setUiError(friendlyError("Couldn’t fork the session", e)));
          }}>Fork</button>
          <button role="menuitem" onClick={() => { setMenuOpen(false); onTogglePin(s); }}>
            {s.pinned ? "Unpin" : "Pin to top"}
          </button>
          {s.status === "archived" ? (
            <button role="menuitem" onClick={() => {
              setMenuOpen(false);
              void restoreSession(s.id).then(onChanged).catch((e) => setUiError(friendlyError("Couldn’t restore the session", e)));
            }}>Restore</button>
          ) : (
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                if (getUiSettings().confirmSessionArchive && !window.confirm(`Archive "${s.title || "session"}"?`)) return;
                void archiveSession(s.id).then(onChanged).catch((e) => setUiError(friendlyError("Couldn’t archive the session", e)));
              }}
            >Archive</button>
          )}
          {folders.length > 0 && <div className="session-menu-head">Move to folder</div>}
          {s.folderId && <button role="menuitem" onClick={() => void moveToFolder(null)}>⌂ No folder</button>}
          {folders.filter((f) => f.id !== s.folderId).map((f) => (
            <button key={f.id} role="menuitem" onClick={() => void moveToFolder(f.id)}>▸ {f.name}</button>
          ))}
          {labels.length > 0 && <div className="session-menu-head">Labels</div>}
          {labels.map((l) => (
            <button key={l.id} role="menuitemcheckbox" aria-checked={(s.labelIds ?? []).includes(l.id)} onClick={() => void toggleLabel(l.id)}>
              <span className="label-dot" style={{ background: l.color }} /> {l.name} {(s.labelIds ?? []).includes(l.id) ? "✓" : ""}
            </button>
          ))}
          <SlotHost slot="sidebar.session.actions" context={{ sessionId: s.id, status: s.status }} />
        </div>
      )}
    </div>
  );
}

export default function SessionList({ projectId }: { projectId: string }) {
  const sessions = useStore((st) => st.sessions);
  const activeSessionId = useStore((st) => st.activeSessionId);
  const eventsMap = useStore((st) => st.events);
  const expandArchived = useStore((st) => st.settings.showArchived);
  const relativeTime = useStore((st) => st.settings.relativeTime);
  const [folders, setFolders] = useState<SessionFolderDto[]>([]);
  const [labels, setLabels] = useState<WorkspaceLabel[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showArchived, setShowArchived] = useState(expandArchived);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [draggedPin, setDraggedPin] = useState<string | null>(null);
  const groupingMode = useGroupingMode(); // flat | folder | status | worktree | plugin

  useEffect(() => {
    setShowArchived(expandArchived);
  }, [expandArchived]);

  const reloadOrg = () => {
    void api.listFolders(projectId).then(setFolders);
    void api.listLabels().then(setLabels);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reloadOrg, [projectId]);

  const onChanged = () => {
    void refreshSessions(projectId);
    reloadOrg();
  };

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, projectId],
  );
  const active = projectSessions.filter((s) => s.status !== "archived");
  const archived = projectSessions.filter((s) => s.status === "archived");
  const pinned = sortPinnedSessions(active);
  const unpinned = active.filter((session) => session.pinned === undefined);

  const byFolder = new Map<string, SessionProjection[]>();
  const rootSessions: SessionProjection[] = [];
  for (const s of unpinned) {
    if (s.folderId && folders.some((f) => f.id === s.folderId)) {
      const list = byFolder.get(s.folderId) ?? [];
      list.push(s);
      byFolder.set(s.folderId, list);
    } else {
      rootSessions.push(s);
    }
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const runBulk = async (op: "archive" | "restore") => {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const result = await api.bulkSessions(op, ids);
      const failNote = result.failed.length ? `; ${result.failed.length} failed (${result.failed.map((f) => f.code).join(", ")})` : "";
      announce(`${op === "archive" ? "Archived" : "Restored"} ${result.succeeded.length} session(s)${failNote}`);
      if (result.failed.length) {
        setUiError(`Some sessions could not be ${op === "archive" ? "archived" : "restored"}: ${result.failed.map((f) => `${f.id.slice(0, 8)}:${f.code}`).join(", ")}`);
      }
    } catch (e) {
      setUiError(friendlyError(`Couldn’t ${op} the selected sessions`, e));
    }
    setSelected(new Set());
    setSelectMode(false);
    onChanged();
  };

  const createFolder = async () => {
    const name = folderName.trim();
    setCreatingFolder(false);
    setFolderName("");
    if (!name) return;
    try {
      await api.createFolder(projectId, name);
      reloadOrg();
    } catch (e) {
      setUiError(friendlyError("Couldn’t create the folder", e));
    }
  };

  const removeFolder = async (f: SessionFolderDto) => {
    if (!window.confirm(`Delete folder "${f.name}"? Sessions stay; children hoist up.`)) return;
    try {
      await api.deleteFolder(f.id);
      onChanged();
    } catch (e) {
      setUiError(friendlyError("Couldn’t delete the folder", e));
    }
  };

  const togglePin = async (session: SessionProjection) => {
    try {
      const position = pinned.reduce((max, item) => Math.max(max, item.pinned?.position ?? -1), -1) + 1;
      await api.organizeSession(session.id, { pinned: session.pinned ? null : { position } });
      onChanged();
    } catch (error) {
      setUiError(friendlyError(`Couldn’t ${session.pinned ? "unpin" : "pin"} the session`, error));
    }
  };

  const dropPin = async (targetId: string) => {
    const draggedId = draggedPin;
    setDraggedPin(null);
    if (!draggedId || draggedId === targetId) return;
    const next = reorderPinnedSessions(pinned, draggedId, targetId);
    try {
      await Promise.all(next.map((session, position) =>
        session.pinned?.position === pinned.find((item) => item.id === session.id)?.pinned?.position
          ? Promise.resolve()
          : api.organizeSession(session.id, { pinned: { position } }),
      ));
      onChanged();
      announce("Pinned sessions reordered");
    } catch (error) {
      setUiError(friendlyError("Couldn’t reorder pinned sessions", error));
      onChanged();
    }
  };

  const row = (s: SessionProjection, pinnedSection = false) => (
    <SessionRow
      key={s.id}
      s={s}
      activeSessionId={activeSessionId}
      labels={labels}
      folders={folders}
      eventsTitle={firstUserText(eventsMap[s.id])}
      relativeTime={relativeTime}
      selectMode={selectMode}
      selected={selected.has(s.id)}
      onToggleSelect={toggleSelect}
      onChanged={onChanged}
      // UX-A390: the compact drawer closes only after activation resolves;
      // a failure leaves it open with the existing error path.
      onOpen={(id) => void openSession(id).then(() => {
        if (getState().sidebarOpen) setSidebarOpen(false);
      })}
      onTogglePin={(session) => void togglePin(session)}
      pinnedSection={pinnedSection}
      onPinDragStart={setDraggedPin}
      onPinDrop={(targetId) => void dropPin(targetId)}
    />
  );

  return (
    <div className="session-org">
      <div className="session-org-bar">
        {groupingMode === "folder" && <button className="small-btn" onClick={() => setCreatingFolder(true)}>＋ Folder</button>}
        <button className="small-btn" aria-pressed={selectMode} onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}>
          {selectMode ? "Cancel" : "Select"}
        </button>
        {selectMode && selected.size > 0 && (
          <>
            <button className="small-btn" onClick={() => void runBulk("archive")}>Archive {selected.size}</button>
            <button className="small-btn" onClick={() => void runBulk("restore")}>Restore {selected.size}</button>
          </>
        )}
      </div>
      {creatingFolder && (
        <div className="folder-create">
          <input
            autoFocus
            placeholder="Folder name"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createFolder();
              else if (e.key === "Escape") { setCreatingFolder(false); setFolderName(""); }
            }}
          />
          <button className="small-btn" onClick={() => void createFolder()}>Add</button>
        </div>
      )}

      {pinned.length > 0 && (
        <div className="session-pinned">
          <div className="session-group-head">Pinned <span className="muted">{pinned.length}</span></div>
          {pinned.map((session) => row(session, true))}
        </div>
      )}

      {groupingMode === "folder" && folders.map((f) => {
        const inFolder = byFolder.get(f.id) ?? [];
        const isCollapsed = collapsed.has(f.id);
        return (
          <div key={f.id} className="session-folder">
            <div className="session-folder-head">
              <button
                className="session-folder-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((prev) => {
                  const n = new Set(prev);
                  if (n.has(f.id)) n.delete(f.id);
                  else n.add(f.id);
                  return n;
                })}
              >
                <span>{isCollapsed ? "▸" : "▾"}</span> {f.name}
                <span className="muted"> {inFolder.length}</span>
              </button>
              <button className="session-folder-del" title={`Delete folder ${f.name}`} onClick={() => void removeFolder(f)}>✕</button>
            </div>
            {!isCollapsed && inFolder.map((session) => row(session))}
            {!isCollapsed && inFolder.length === 0 && <div className="empty session-folder-empty">Empty</div>}
          </div>
        );
      })}
      {groupingMode === "folder" && rootSessions.map((session) => row(session))}

      {groupingMode === "flat" && unpinned.map((session) => row(session))}

      {groupingMode !== "folder" && groupingMode !== "flat" &&
        groupSessions(unpinned, groupingMode, listGroupings()).map((g) => (
          <div key={g.key} className="session-group">
            <div className="session-group-head">
              {g.label} <span className="muted">{g.sessions.length}</span>
            </div>
            {g.sessions.map((session) => row(session))}
          </div>
        ))}

      {active.length === 0 && <div className="empty" style={{ padding: "12px" }}>No sessions.</div>}

      {archived.length > 0 && (
        <div className="session-archived">
          <button className="session-folder-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <span>{showArchived ? "▾" : "▸"}</span> Archived <span className="muted">{archived.length}</span>
          </button>
          {showArchived && archived.map((session) => row(session))}
        </div>
      )}
    </div>
  );
}
