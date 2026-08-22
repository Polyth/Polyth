// Organized session list: worktree grouping, labels, attention badges,
// inline rename, archived section, bulk archive/restore with partial-failure
// reporting. All mutations go through the REST org endpoints.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { api, type Worktree } from "../../api.ts";
import { getState, setSidebarOpen, setUiError, useStore } from "../../store.ts";
import { openSession, archiveSession, deleteSession, restoreSession, forkSession, refreshSessions } from "../../init.ts";
import { sessionStatusBadge } from "../../sessionBadges.ts";
import { ago, deriveSessionTitle, fmtDuration, fullSessionTitle } from "../../format.ts";
import { friendlyError } from "../../settings.ts";
import { getUiSettings } from "../../uiPrefs.ts";
import { firstUserText } from "../../utils.ts";
import { announce } from "../a11y/live.tsx";
import { worktreeLabel } from "../../worktreeSessions.ts";
import SlotHost from "../slots/SlotHost.ts";
import {
  reorderPinnedSessions,
  sortPinnedSessions,
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

/** Re-render clock for the running badge's elapsed label (paused when off). */
function useNowTick(enabled: boolean, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

/** Finding 3: derived status badge — running (elapsed), waiting, completed,
 *  merged (lite: worktree cleanup signal). Read + nothing pending → nothing. */
function StatusBadge({ s }: { s: SessionProjection }) {
  const now = useNowTick(s.status === "working");
  const badge = sessionStatusBadge(s, now);
  if (!badge) return null;
  if (badge.kind === "running") {
    return (
      <span className="status-badge running" title={`Agent running for ${fmtDuration(badge.elapsedMs)}`}>
        <span className="status-badge-spin" aria-hidden>●</span> {fmtDuration(badge.elapsedMs)}
      </span>
    );
  }
  if (badge.kind === "waiting") {
    return <span className="status-badge waiting" title="Waiting on your answer" aria-label="Waiting on a question">?</span>;
  }
  if (badge.kind === "merged") {
    return <span className="status-badge merged" title="Worktree removed — branch merged/cleaned up">merged</span>;
  }
  return <span className="status-badge completed" title="Turn completed">✓ done</span>;
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

/** Finding 4 guard: destructive quick actions confirm first while the agent
 *  is running or a question/permission is waiting; otherwise act immediately. */
function needsDestructiveConfirm(s: SessionProjection): boolean {
  return s.status === "working" || s.status === "waiting"
    || (s.attention?.questions ?? 0) > 0 || (s.attention?.permissions ?? 0) > 0;
}

// Finding 4: Shift is tracked in a module-level store whose window listeners
// attach on first row mount — not after a row is hovered — so pressing Shift
// before pointing at a row still arms it. Pointer moves over rows also feed
// the sampled `event.shiftKey` in, covering inputs whose key events never
// reach the window (synthesized pointers). Either signal arms; releasing
// Shift (keyup or window blur) disarms both.
let shiftKeyDown = false;
let shiftSampled = false;
let shiftListening = false;
const shiftSubscribers = new Set<() => void>();
const isShiftArmed = () => shiftKeyDown || shiftSampled;

function publishShift(prev: boolean) {
  if (isShiftArmed() === prev) return;
  for (const notify of shiftSubscribers) notify();
}

function sampleShiftModifier(shiftKey: boolean) {
  const prev = isShiftArmed();
  shiftSampled = shiftKey;
  publishShift(prev);
}

function setShiftKeyDown(down: boolean) {
  const prev = isShiftArmed();
  shiftKeyDown = down;
  if (!down) shiftSampled = false; // releasing Shift disarms immediately
  publishShift(prev);
}

function ensureShiftListeners() {
  if (shiftListening) return;
  shiftListening = true;
  window.addEventListener("keydown", (e) => { if (e.key === "Shift") setShiftKeyDown(true); });
  window.addEventListener("keyup", (e) => { if (e.key === "Shift") setShiftKeyDown(false); });
  window.addEventListener("blur", () => setShiftKeyDown(false));
}

function useShiftArmed(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      ensureShiftListeners();
      shiftSubscribers.add(onChange);
      return () => { shiftSubscribers.delete(onChange); };
    },
    isShiftArmed,
  );
}

function SessionRow({
  s, activeSessionId, labels, eventsTitle, relativeTime, selectMode, selected,
  onToggleSelect, onChanged, onOpen, onTogglePin, pinnedSection, onPinDragStart, onPinDrop,
}: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  // Shift+hover arms the quick actions (they stay keyboard-reachable through
  // :focus-within regardless of the modifier).
  const [hovered, setHovered] = useState(false);
  const shiftHeld = useShiftArmed();
  const quickArmed = hovered && shiftHeld;
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  // Both mouse and pointer flavors are wired (idempotent, so duplicates are
  // harmless): pointer events cover inputs that never synthesize mouseenter,
  // and every move re-samples the modifier so arming stays live even when the
  // Shift keydown itself is missed.
  const hoverUpdate = (event: { shiftKey: boolean }) => {
    setHovered(true);
    sampleShiftModifier(event.shiftKey);
  };
  const hoverEnd = () => setHovered(false);

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);

  // Menu keyboard contract: focus lands on the first item on open; arrows
  // cycle; Escape closes and returns focus to the row's menu button.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus();
  }, [menuOpen]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      menuBtnRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : current < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1)
      : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const quickArchive = () => {
    const label = s.title || "session";
    if (needsDestructiveConfirm(s) && !window.confirm(`Archive "${label}"? The agent is still running or waiting on you.`)) return;
    if (!needsDestructiveConfirm(s) && getUiSettings().confirmSessionArchive && !window.confirm(`Archive "${label}"?`)) return;
    void archiveSession(s.id)
      .then(() => { announce(`Archived ${label}`); onChanged(); })
      .catch((e) => setUiError(friendlyError("Couldn’t archive the session", e)));
  };

  const quickDelete = () => {
    const label = s.title || "session";
    const activity = needsDestructiveConfirm(s) ? " The agent is still running or waiting on you." : "";
    if (!window.confirm(`Delete "${label}"?${activity} This permanently removes the session and its history.`)) return;
    void deleteSession(s.id)
      .then(() => { announce(`Deleted ${label}`); onChanged(); })
      .catch((e) => setUiError(friendlyError("Couldn’t delete the session", e)));
  };

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
      className={`session-row ${s.id === activeSessionId ? "active" : ""} ${s.status === "archived" ? "archived" : ""}${quickArmed ? " quick-armed" : ""}`}
      draggable={pinnedSection}
      onDragStart={() => { if (pinnedSection) onPinDragStart(s.id); }}
      onDragOver={(event) => { if (pinnedSection) event.preventDefault(); }}
      onDrop={(event) => { if (pinnedSection) { event.preventDefault(); onPinDrop(s.id); } }}
      onMouseEnter={hoverUpdate}
      onMouseMove={hoverUpdate}
      onMouseLeave={hoverEnd}
      onPointerEnter={hoverUpdate}
      onPointerMove={hoverUpdate}
      onPointerLeave={hoverEnd}
      // Finding 5: right-click opens this row's action menu — the same menu
      // (and handlers) the ellipsis button anchors, so one action model.
      onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true); }}
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
              <StatusBadge s={s} />
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
      <span className="session-quick">
        {s.status !== "archived" && (
          <button
            className="session-quick-btn"
            title={`Archive ${s.title || "session"} (Shift+hover quick action)`}
            aria-label={`Archive ${s.title || "session"}`}
            onClick={quickArchive}
          >⤓</button>
        )}
        <button
          className="session-quick-btn danger"
          title={`Delete ${s.title || "session"} (Shift+hover quick action)`}
          aria-label={`Delete ${s.title || "session"}`}
          onClick={quickDelete}
        >✕</button>
      </span>
      <span className="session-actions">
        <button
          ref={menuBtnRef}
          title="Session menu"
          aria-label={`Menu for ${s.title || "session"}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >⋯</button>
      </span>
      {menuOpen && (
        <div
          className="session-menu"
          role="menu"
          aria-label={`Actions for ${s.title || "session"}`}
          ref={menuRef}
          onKeyDown={onMenuKey}
        >
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
                quickArchive();
              }}
            >Archive</button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenuOpen(false);
              quickDelete();
            }}
          >Delete</button>
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

export default function SessionList({
  projectId,
  selectMode = false,
  selectedSessionIds = new Set<string>(),
  onToggleSelected = () => {},
}: {
  projectId: string;
  selectMode?: boolean;
  selectedSessionIds?: ReadonlySet<string>;
  onToggleSelected?: (id: string) => void;
}) {
  const sessions = useStore((st) => st.sessions);
  const activeSessionId = useStore((st) => st.activeSessionId);
  const eventsMap = useStore((st) => st.events);
  const expandArchived = useStore((st) => st.settings.showArchived);
  const relativeTime = useStore((st) => st.settings.relativeTime);
  const [labels, setLabels] = useState<WorkspaceLabel[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showArchived, setShowArchived] = useState(expandArchived);
  const [draggedPin, setDraggedPin] = useState<string | null>(null);

  useEffect(() => {
    setShowArchived(expandArchived);
  }, [expandArchived]);

  const reloadOrg = () => {
    void api.listLabels().then(setLabels);
    void api.listWorktrees(projectId).then(setWorktrees);
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
  const pinRank = new Map(pinned.map((session, index) => [session.id, index]));
  const mainWorktree = worktrees.find((worktree) => worktree.isMain);

  const byWorktree = new Map<string, SessionProjection[]>();
  for (const s of active) {
    const key = !s.worktreePath || s.worktreePath === mainWorktree?.path ? "__main__" : s.worktreePath;
    byWorktree.set(key, [...(byWorktree.get(key) ?? []), s]);
  }
  for (const grouped of byWorktree.values()) {
    grouped.sort((a, b) => {
      const aRank = pinRank.get(a.id);
      const bRank = pinRank.get(b.id);
      if (aRank !== undefined || bRank !== undefined) {
        if (aRank === undefined) return 1;
        if (bRank === undefined) return -1;
        return aRank - bRank;
      }
      return b.updatedAt - a.updatedAt;
    });
  }
  const knownWorktreePaths = new Set(worktrees.filter((worktree) => !worktree.isMain).map((worktree) => worktree.path));
  const worktreeGroups = [
    {
      key: "__main__",
      label: mainWorktree?.branch || "Main worktree",
      sessions: byWorktree.get("__main__") ?? [],
    },
    ...worktrees.filter((worktree) => !worktree.isMain).map((worktree) => ({
      key: worktree.path,
      label: worktree.branch || worktreeLabel(null, worktree.path),
      sessions: byWorktree.get(worktree.path) ?? [],
    })),
    ...[...byWorktree.entries()]
      .filter(([path]) => path !== "__main__" && !knownWorktreePaths.has(path))
      .map(([path, grouped]) => ({
        key: path,
        label: worktreeLabel(grouped[0]?.branch ?? null, path),
        sessions: grouped,
      })),
  ];

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
      eventsTitle={firstUserText(eventsMap[s.id])}
      relativeTime={relativeTime}
      selectMode={selectMode}
      selected={selectedSessionIds.has(s.id)}
      onToggleSelect={onToggleSelected}
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
      {worktreeGroups.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        return (
          <div key={group.key} className="session-worktree-group" data-worktree={group.key}>
            <button
              className="session-worktree-toggle"
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.label} worktree`}
              onClick={() => setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(group.key)) next.delete(group.key);
                else next.add(group.key);
                return next;
              })}
            >
              <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
              <span className="session-worktree-name">{group.label}</span>
              <span className="muted">{group.sessions.length}</span>
            </button>
            {!isCollapsed && (
              <div className="session-worktree-sessions">
                {group.sessions.map((session) => row(session, session.pinned !== undefined))}
                {group.sessions.length === 0 && <div className="empty session-worktree-empty">No sessions</div>}
              </div>
            )}
          </div>
        );
      })}

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
