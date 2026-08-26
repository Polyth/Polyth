// Organized session list: worktree grouping, labels, attention badges,
// inline rename, archived section, bulk archive/restore with partial-failure
// reporting. All mutations go through the REST org endpoints.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { api, type Worktree } from "../../api.ts";
import {
  getState, setSidebarOpen, setUiError, startNewSession, useStore,
} from "../../store.ts";
import { openSession, archiveSession, deleteSession, restoreSession, forkSession, refreshSessions } from "../../init.ts";
import { sessionRowStatus, type SessionRowStatus } from "../../sessionBadges.ts";
import { deriveSessionTitle, fullSessionTitle } from "../../format.ts";
import { friendlyError } from "../../settings.ts";
import { getUiSettings } from "../../uiPrefs.ts";
import { confirmAlert } from "../../alerts.ts";
import { copyText, firstUserText } from "../../utils.ts";
import { announce } from "../a11y/live.tsx";
import { worktreeLabel } from "../../worktreeSessions.ts";
import SlotHost from "../slots/SlotHost.ts";
import Dialog from "../a11y/Dialog.tsx";
import {
  reorderPinnedSessions,
  sortPinnedSessions,
} from "../../sidebarPrefs.ts";
import { Icon } from "../../icons.tsx";
import { formatRelativeTime, getLocale, tr } from "../../i18n/index.ts";

const INITIAL_VISIBLE_SESSIONS = 6;

export function sessionActivityLabel(
  s: Pick<SessionProjection, "updatedAt" | "status" | "attention">,
  relative: boolean,
  now = Date.now(),
): string {
  if (!relative) {
    return new Date(s.updatedAt).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
  }
  const age = Math.max(0, now - s.updatedAt);
  if (age < 60_000) return formatRelativeTime(0, "second", { numeric: "auto", style: "narrow" });
  if (age < 60 * 60_000) return formatRelativeTime(-Math.floor(age / 60_000), "minute", { style: "narrow" });
  if (age < 24 * 60 * 60_000) return formatRelativeTime(-Math.floor(age / 3_600_000), "hour", { style: "narrow" });
  if (age < 7 * 24 * 60 * 60_000) return formatRelativeTime(-Math.floor(age / 86_400_000), "day", { style: "narrow" });
  return new Date(s.updatedAt).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

function sidebarElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function AttentionBadges({ status }: { status: SessionRowStatus }) {
  if (status.kind === "needs-approval") {
    return <span className="session-status-indicator approval" title={tr("sidebar.sessionlist.approvalRequired")} aria-label={tr("sidebar.sessionlist.approvalRequired")}><span aria-hidden>✓</span></span>;
  }
  if (status.kind === "needs-reply") {
    return <span className="session-status-indicator reply" title={tr("sidebar.sessionlist.replyNeeded")} aria-label={tr("sidebar.sessionlist.replyNeeded")}><span className="session-question-icon" aria-hidden><Icon.question /></span></span>;
  }
  if (status.kind === "unread") {
    return <span className="session-status-indicator unread" title={tr("sidebar.sessionlist.unreadActivity")} aria-label={tr("sidebar.sessionlist.unreadActivity")}><span aria-hidden>●</span></span>;
  }
  return null;
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

function StatusBadge({ status }: { status: SessionRowStatus }) {
  if (status.kind === "working") {
    return (
      <span className="session-status-indicator working" title={tr("sidebar.sessionlist.agentWorkingForValue", { value: sidebarElapsed(status.elapsedMs) })} aria-label={tr("sidebar.sessionlist.agentWorkingForValue", { value: sidebarElapsed(status.elapsedMs) })}>
        <span className="session-status-pulse" aria-hidden>◌</span>
        <span aria-hidden>{sidebarElapsed(status.elapsedMs)}</span>
      </span>
    );
  }
  return null;
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
  contextLabel?: string;
  pinnedWorktreeLabel?: string;
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
  contextLabel, pinnedWorktreeLabel,
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
  const sessionBtnRef = useRef<HTMLButtonElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuReturnRef = useRef<HTMLButtonElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOpenedRef = useRef(false);
  const now = useNowTick(s.status === "working", 1_000);
  const rowStatus = sessionRowStatus(s, now);

  // Both mouse and pointer flavors are wired (idempotent, so duplicates are
  // harmless): pointer events cover inputs that never synthesize mouseenter,
  // and every move re-samples the modifier so arming stays live even when the
  // Shift keydown itself is missed.
  const hoverUpdate = (event: { shiftKey: boolean }) => {
    setHovered(true);
    sampleShiftModifier(event.shiftKey);
  };
  const hoverEnd = () => setHovered(false);
  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };
  const startLongPress = () => {
    cancelLongPress();
    longPressOpenedRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressOpenedRef.current = true;
      menuReturnRef.current = sessionBtnRef.current;
      setMenuOpen(true);
    }, 550);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current
        && !menuRef.current.contains(target)
        && !menuTriggerRef.current?.contains(target)
      ) setMenuOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menuOpen]);
  useEffect(() => () => cancelLongPress(), []);

  // Menu keyboard contract: focus lands on the first item on open; arrows
  // cycle; Escape closes and returns focus to the session button.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus();
  }, [menuOpen]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      menuReturnRef.current?.focus();
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

  const quickArchive = async () => {
    const label = s.title || tr("sidebar.sessionlist.session");
    if (needsDestructiveConfirm(s) && !await confirmAlert(tr("sidebar.sessionlist.archiveValueTheAgentIsStillRunning", { label: label }), { title: tr("sidebar.sessionlist.archiveActiveSession"), confirmLabel: tr("common.archive") })) return;
    if (!needsDestructiveConfirm(s) && getUiSettings().confirmSessionArchive && !await confirmAlert(tr("sidebar.sessionlist.archiveValue", { label: label }), { title: tr("sidebar.sessionlist.archiveSession"), confirmLabel: tr("common.archive") })) return;
    void archiveSession(s.id)
      .then(() => { announce(tr("sidebar.sessionlist.archivedValue", { label: label })); onChanged(); })
      .catch((e) => setUiError(friendlyError(tr("common.error"), e)));
  };

  const quickDelete = async () => {
    const label = s.title || tr("sidebar.sessionlist.session");
    const activity = needsDestructiveConfirm(s) ? ` ${tr("sidebar.sessionlist.theAgentIsStillRunningOr")}` : "";
    if (!await confirmAlert(tr("sidebar.sessionlist.deleteValueValueThisPermanentlyRemovesThe", { label: label, activity: activity }), { title: tr("sidebar.sessionlist.deleteSession"), confirmLabel: tr("common.delete") })) return;
    void deleteSession(s.id)
      .then(() => { announce(tr("sidebar.sessionlist.deletedValue", { label: label })); onChanged(); })
      .catch((e) => setUiError(friendlyError(tr("common.error"), e)));
  };

  const doRename = async () => {
    const t = title.trim();
    setRenaming(false);
    if (!t || t === s.title) return;
    try {
      await api.renameSession(s.id, t);
      announce(tr("sidebar.sessionlist.sessionRenamedToValue", { t: t }));
      onChanged();
    } catch (e) {
      setUiError(friendlyError(tr("common.error"), e));
    }
  };

  const toggleLabel = async (labelId: string) => {
    const cur = s.labelIds ?? [];
    const next = cur.includes(labelId) ? cur.filter((x) => x !== labelId) : [...cur, labelId];
    try {
      await api.organizeSession(s.id, { labelIds: next });
      onChanged();
    } catch (e) {
      setUiError(friendlyError(tr("sidebar.sessionlist.couldnTUpdateSessionLabels"), e));
    }
  };
  const copySessionId = async () => {
    setMenuOpen(false);
    if (await copyText(s.id)) {
      announce(tr("sidebar.sessionlist.sessionIdCopied"));
    } else {
      setUiError(tr("questioncards.copyFailedClipboardUnavailable"));
    }
  };
  const displayTitle = deriveSessionTitle(s.title, eventsTitle);
  const hoverTitle = fullSessionTitle(s.title, eventsTitle);
  const activityLabel = sessionActivityLabel(s, relativeTime);

  return (
    <div
      className={`session-row ${rowStatus.kind}${contextLabel ? " search-result" : ""} ${s.id === activeSessionId ? "active" : ""} ${s.status === "archived" ? "archived" : ""}${quickArmed ? " quick-armed" : ""}${menuOpen ? " menu-open" : ""}`}
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
      onContextMenu={(event) => {
        event.preventDefault();
        menuReturnRef.current = sessionBtnRef.current;
        setMenuOpen(true);
      }}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="session-check"
          checked={selected}
          aria-label={tr("sidebar.sessionlist.selectValue", { value: s.title || tr("sidebar.sessionlist.session") })}
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
          ref={sessionBtnRef}
          className="session-btn"
          aria-current={s.id === activeSessionId ? "true" : undefined}
          aria-label={tr("sidebar.sessionlist.openValue", { displayTitle: displayTitle })}
          title={hoverTitle}
          onClick={(event) => {
            if (longPressOpenedRef.current) {
              event.preventDefault();
              longPressOpenedRef.current = false;
              return;
            }
            onOpen(s.id);
          }}
          onDoubleClick={() => { setTitle(s.title); setRenaming(true); }}
          onTouchStart={startLongPress}
          onTouchEnd={cancelLongPress}
          onTouchCancel={cancelLongPress}
          onTouchMove={cancelLongPress}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              menuReturnRef.current = sessionBtnRef.current;
              setMenuOpen(true);
            }
          }}
        >
          <span className="session-title">
            {pinnedSection && <span className="session-pin-icon" title="Pinned" aria-label="Pinned"><Icon.pin /></span>}
            <span className="session-title-text">{displayTitle}</span>
            {pinnedWorktreeLabel && (
              <span className="session-worktree-label" title={`Worktree: ${pinnedWorktreeLabel}`}>
                <Icon.branch />{pinnedWorktreeLabel}
              </span>
            )}
          </span>
          {contextLabel && <span className="session-search-context">{contextLabel}</span>}
          <span className="session-status-zone">
            <AttentionBadges status={rowStatus} />
            <StatusBadge status={rowStatus} />
            {(rowStatus.kind === "regular" || rowStatus.kind === "unread") && activityLabel && (
              <span className="session-time">{activityLabel}</span>
            )}
            <SlotHost
              slot="session.list.badges"
              context={{ sessionId: s.id, questions: s.attention?.questions ?? 0, permissions: s.attention?.permissions ?? 0 }}
            />
          </span>
        </button>
      )}
      {!renaming && (
        <button
          ref={menuTriggerRef}
          className="session-menu-btn"
          title={tr("sidebar.sessionlist.actionsForValue", { value: s.title || tr("sidebar.sessionlist.session") })}
          aria-label={tr("sidebar.sessionlist.actionsForValue", { value: s.title || tr("sidebar.sessionlist.session") })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            menuReturnRef.current = menuTriggerRef.current;
            setMenuOpen((current) => !current);
          }}
        >
          <Icon.more />
        </button>
      )}
      <span className="session-quick">
        {s.status !== "archived" && (
          <button
            className="session-quick-btn"
            title={tr("sidebar.sessionlist.archiveValueShiftHoverQuickAction", { value: s.title || tr("sidebar.sessionlist.session") })}
            aria-label={tr("sidebar.sessionlist.archiveValue2", { value: s.title || tr("sidebar.sessionlist.session") })}
            onClick={quickArchive}
          ><Icon.download /></button>
        )}
        <button
          className="session-quick-btn danger"
          title={tr("sidebar.sessionlist.deleteValueShiftHoverQuickAction", { value: s.title || tr("sidebar.sessionlist.session") })}
          aria-label={tr("sidebar.sessionlist.deleteValue", { value: s.title || tr("sidebar.sessionlist.session") })}
          onClick={quickDelete}
        >✕</button>
      </span>
      {menuOpen && (
        <div
          className="session-menu"
          role="menu"
          aria-label={tr("sidebar.sessionlist.actionsForValue", { value: s.title || tr("sidebar.sessionlist.session") })}
          ref={menuRef}
          onKeyDown={onMenuKey}
        >
          <button role="menuitem" onClick={() => { setMenuOpen(false); setTitle(s.title); setRenaming(true); }}>{tr("common.rename")}</button>
          <button role="menuitem" onClick={() => {
            setMenuOpen(false);
            void forkSession(s.id).catch((e) => setUiError(friendlyError(tr("common.error"), e)));
          }}>{tr("sidebar.sessionlist.fork")}</button>
          <button role="menuitem" onClick={() => { void copySessionId(); }}>
            {tr("sidebar.sessionlist.copySessionId")}
          </button>
          <button role="menuitem" onClick={() => { setMenuOpen(false); onTogglePin(s); }}>
            {s.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop")}
          </button>
          <div className="session-menu-danger-separator" role="separator" />
          {s.status === "archived" ? (
            <button role="menuitem" onClick={() => {
              setMenuOpen(false);
              void restoreSession(s.id).then(onChanged).catch((e) => setUiError(friendlyError(tr("common.error"), e)));
            }}>{tr("common.restore")}</button>
          ) : (
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                quickArchive();
              }}
            >{tr("common.archive")}</button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenuOpen(false);
              quickDelete();
            }}
          >{tr("common.delete")}</button>
          {labels.length > 0 && <div className="session-menu-head">{tr("sidebar.sessionlist.labels")}</div>}
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
  query = "",
  attentionOnly = false,
  selectMode = false,
  selectedSessionIds = new Set<string>(),
  onToggleSelected = () => {},
  searchMode = false,
  searchProjectName = "",
}: {
  projectId: string;
  query?: string;
  attentionOnly?: boolean;
  selectMode?: boolean;
  selectedSessionIds?: ReadonlySet<string>;
  onToggleSelected?: (id: string) => void;
  searchMode?: boolean;
  searchProjectName?: string;
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
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_SESSIONS);
  const [removeTarget, setRemoveTarget] = useState<Worktree | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);

  useEffect(() => {
    setShowArchived(expandArchived);
  }, [expandArchived]);
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_SESSIONS);
  }, [projectId, query, attentionOnly]);
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
  const needle = query.trim().toLowerCase();
  const matchesFilters = (session: SessionProjection) => {
    if (
      needle
      && !`${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLowerCase().includes(needle)
    ) return false;
    if (!attentionOnly) return true;
    return session.status === "working"
      || session.status === "waiting"
      || (session.attention?.questions ?? 0) > 0
      || (session.attention?.permissions ?? 0) > 0;
  };
  const matchingActive = projectSessions.filter((s) => s.status !== "archived" && matchesFilters(s));
  // Pinned chats belong to one project-level section, rather than their
  // individual worktree buckets. This keeps them at the top even when their
  // worktree is collapsed or appears later in the list.
  const pinned = sortPinnedSessions(matchingActive);
  const unpinnedActive = matchingActive.filter((session) => session.pinned === undefined);
  const orderedActive = [...pinned, ...unpinnedActive];
  let active = searchMode
    ? orderedActive
    : [...pinned, ...unpinnedActive.slice(0, Math.max(0, visibleCount - pinned.length))];
  const selectedActive = orderedActive.find((session) => session.id === activeSessionId);
  if (!searchMode && selectedActive && !active.some((session) => session.id === selectedActive.id) && active.length > 0) {
    active = [...active.slice(0, -1), selectedActive];
  }
  const archived = projectSessions.filter((s) => s.status === "archived" && matchesFilters(s));
  const hiddenActive = searchMode ? 0 : Math.max(0, orderedActive.length - active.length);
  const mainWorktree = worktrees.find((worktree) => worktree.isMain);
  const worktreeKey = (session: SessionProjection): string =>
    !session.worktreePath || session.worktreePath === mainWorktree?.path ? "__main__" : session.worktreePath;
  const sessionsForRemoval = removeTarget === null
    ? []
    : projectSessions.filter((session) => worktreeKey(session) === removeTarget.path);

  const byWorktree = new Map<string, SessionProjection[]>();
  for (const s of active.filter((session) => session.pinned === undefined)) {
    const key = worktreeKey(s);
    byWorktree.set(key, [...(byWorktree.get(key) ?? []), s]);
  }
  for (const grouped of byWorktree.values()) {
    grouped.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  // A project's checkout is its root, not another branch in the navigation.
  // Only linked worktrees get their own expandable subtrees.
  const mainSessions = byWorktree.get("__main__") ?? [];
  const knownWorktreePaths = new Set(worktrees.filter((worktree) => !worktree.isMain).map((worktree) => worktree.path));
  const worktreeGroups = [
    ...worktrees.filter((worktree) => !worktree.isMain).map((worktree) => ({
      key: worktree.path,
      label: worktree.branch || worktreeLabel(null, worktree.path),
      sessions: byWorktree.get(worktree.path) ?? [],
      worktree,
    })),
    ...[...byWorktree.entries()]
      .filter(([path]) => path !== "__main__" && !knownWorktreePaths.has(path))
      .map(([path, grouped]) => ({
        key: path,
        label: worktreeLabel(grouped[0]?.branch ?? null, path),
        sessions: grouped,
        worktree: null,
      })),
  ];

  const togglePin = async (session: SessionProjection) => {
    try {
      const position = pinned.reduce((max, item) => Math.max(max, item.pinned?.position ?? -1), -1) + 1;
      await api.organizeSession(session.id, { pinned: session.pinned ? null : { position } });
      onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
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
      announce(tr("sidebar.sessionlist.pinnedSessionsReordered"));
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
      onChanged();
    }
  };

  const row = (
    s: SessionProjection,
    pinnedSection = false,
    contextLabel?: string,
    pinnedWorktreeLabel?: string,
  ) => (
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
      contextLabel={contextLabel}
      pinnedWorktreeLabel={pinnedWorktreeLabel}
    />
  );

  const worktreeNameForSession = (session: SessionProjection): string => {
    const key = worktreeKey(session);
    if (key === "__main__") return tr("sidebar.sessionlist.mainWorktree");
    if (session.branch) return session.branch;
    return worktrees.find((worktree) => worktree.path === key)?.branch || worktreeLabel(null, key);
  };
  const startInWorktree = (key: string) => {
    startNewSession(projectId, key === "__main__" ? {} : { worktreePath: key });
    if (getState().sidebarOpen) setSidebarOpen(false);
  };

  if (searchMode) {
    const results = [...orderedActive, ...archived].sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <div className="session-org session-search-mode">
        {results.map((session) => row(
          session,
          false,
          `${searchProjectName} · ${worktreeNameForSession(session)}`,
        ))}
        {results.length === 0 && <div className="empty session-list-empty">{tr("sidebar.sessionlist.noMatchingSessions")}</div>}
      </div>
    );
  }

  return (
    <div className="session-org">
      {pinned.length > 0 && (
        <div className="session-pinned" aria-label="Pinned chats">
          {pinned.map((session) => row(session, true, undefined, worktreeNameForSession(session)))}
        </div>
      )}
      {mainSessions.length > 0 && (
        <div className="session-project-sessions session-worktree-sessions">
          {mainSessions.map((session) => row(session))}
        </div>
      )}
      {worktreeGroups.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        return (
          <div key={group.key} className="session-worktree-group" data-worktree={group.key}>
            <div className="session-worktree-head">
              <button
                className="session-worktree-toggle"
                aria-expanded={!isCollapsed}
                aria-label={tr("sidebar.sessionlist.valueValueWorktree", {
                  value: isCollapsed
                    ? tr("sidebar.sessionlist.expand")
                    : tr("sidebar.sessionlist.collapse"),
                  label: group.label,
                })}
                onClick={() => setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })}
              >
                <span className="session-worktree-toggle-sign" aria-hidden="true">{isCollapsed ? "+" : "−"}</span>
                <Icon.branch />
                <span className="session-worktree-name">{group.label}</span>
              </button>
              <span className="session-worktree-actions">
                <button
                  title={tr("sidebar.sessionlist.newSessionInValue", { label: group.label })}
                  aria-label={tr("sidebar.sessionlist.newSessionInValue", { label: group.label })}
                  onClick={() => startInWorktree(group.key)}
                ><Icon.plus /></button>
                {group.worktree && !group.worktree.isMain && (
                  <button
                    className="danger"
                    title={tr("sidebar.sessionlist.deleteValueWorktreeAndIts", { label: group.label })}
                    aria-label={tr("sidebar.sessionlist.deleteValueWorktreeAndAll", { label: group.label })}
                    onClick={() => {
                      setDeleteBranch(false);
                      setRemoveTarget(group.worktree);
                    }}
                  ><Icon.trash /></button>
                )}
              </span>
            </div>
            {!isCollapsed && (
              <div className="session-worktree-sessions">
                {group.sessions.map((session) => row(session))}
                {group.sessions.length === 0 && <div className="empty session-worktree-empty">{tr("sidebar.sessionlist.noSessions")}</div>}
              </div>
            )}
          </div>
        );
      })}

      {hiddenActive > 0 && (
        <button
          className="show-more-sessions"
          onClick={() => setVisibleCount((count) => count + INITIAL_VISIBLE_SESSIONS)}
        >
          {tr("sidebar.sessionlist.showMoreSessions")}{" "}<Icon.chevronDown />
        </button>
      )}

      {matchingActive.length === 0 && <div className="empty session-list-empty">{tr("sidebar.sessionlist.noMatchingSessions")}</div>}

      {archived.length > 0 && (
        <div className="session-archived">
          <button className="session-folder-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <span>{showArchived ? "▾" : "▸"}</span> {tr("sidebar.sessionlist.archived")}{" "}<span className="muted">{archived.length}</span>
          </button>
          {showArchived && archived.map((session) => row(session))}
        </div>
      )}
      {removeTarget && (
        <Dialog title={tr("sidebar.sessionlist.deleteValueWorktree", { value: worktreeLabel(removeTarget.branch, removeTarget.path) })} onClose={() => { if (!removeBusy) setRemoveTarget(null); }}>
          <div className="dialog-head">
            <div><h2>{tr("sidebar.sessionlist.deleteWorktreeAndItsSessions")}</h2><p className="muted">{removeTarget.path}</p></div>
            <button className="icon-btn" aria-label={tr("common.close")} disabled={removeBusy} onClick={() => setRemoveTarget(null)}>{tr("sidebar.sessionlist.message")}</button>
          </div>
          <div className="worktree-remove-options">
            <label><input type="checkbox" checked readOnly /> {tr("sidebar.sessionlist.deleteTheLocalWorktreeCheckout")}</label>
            <label><input type="checkbox" checked readOnly /> {sessionsForRemoval.length === 1
              ? tr("sidebar.sessionlist.permanentlyDeleteOneSessionIn")
              : tr("sidebar.sessionlist.permanentlyDeleteValueSessionsIn", { count: sessionsForRemoval.length })}</label>
            <label>
              <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} />
              {tr("sidebar.sessionlist.alsoDeleteItsDedicatedBranch")}{removeTarget.branch ? ` (${removeTarget.branch})` : ""}
            </label>
          </div>
          <div className="dialog-foot">
            <button className="small-btn" disabled={removeBusy} onClick={() => setRemoveTarget(null)}>{tr("common.cancel")}</button>
            <span className="header-spacer" />
            <button
              className="primary-btn danger-btn"
              disabled={removeBusy}
              onClick={() => {
                setRemoveBusy(true);
                void Promise.all(sessionsForRemoval.map((session) => deleteSession(session.id)))
                  .then(() => api.removeWorktree(projectId, removeTarget.path, deleteBranch))
                  .then(() => { setRemoveTarget(null); onChanged(); })
                  .catch((error) => setUiError(friendlyError(tr("sidebar.sessionlist.couldnTRemoveTheWorktree"), error)))
                  .finally(() => setRemoveBusy(false));
              }}
            >{removeBusy ? tr("sidebar.sessionlist.deleting") : tr("sidebar.sessionlist.deleteWorktree")}</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
