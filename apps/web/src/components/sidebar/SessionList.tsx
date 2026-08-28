// Organized session list: worktree grouping, labels, attention badges,
// inline rename, archived section, bulk archive/restore with partial-failure
// reporting. All mutations go through the REST org endpoints.
import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent,
} from "react";
import type { SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { api, type Worktree } from "@polyth/session/web-api";
import {
  getState, setSidebarOpen, setUiError, startNewSession, useStore,
} from "../../store.ts";
import { openSession, archiveSession, deleteSession, restoreSession, forkSession, refreshSessions } from "../../init.ts";
import { sessionRowStatus, type SessionRowStatus } from "../../sessionBadges.ts";
import { deriveSessionTitle, fullSessionTitle } from "../../format.ts";
import { friendlyError } from "../../settings.ts";
import { getUiSettings } from "../../uiPrefs.ts";
import { confirmAlert } from "../../alerts.ts";
import { copyText, firstUserTextCached } from "../../utils.ts";
import { announce } from "../a11y/live.tsx";
import { worktreeLabel } from "../../worktreeSessions.ts";
import SlotHost from "../slots/SlotHost.ts";
import { Button, Checkbox, Dialog, Menu, type MenuEntry } from "../ui/index.ts";
import {
  reorderPinnedSessions,
  sortPinnedSessions,
} from "../../sidebarPrefs.ts";
import { Icon } from "../../icons.tsx";
import { formatRelativeTime, getLocale, tr } from "../../i18n/index.ts";
import { errorFeedback, successFeedback, tapFeedback } from "../../haptics.ts";
import { horizontalDistance, SESSION_SWIPE_REVEAL, type GesturePoint } from "../../mobileGestures.ts";

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
  if (age < 60 * 60_000) return formatRelativeTime(-Math.floor(age / 60_000), "minute", { numeric: "auto", style: "narrow" });
  if (age < 24 * 60 * 60_000) return formatRelativeTime(-Math.floor(age / 3_600_000), "hour", { numeric: "auto", style: "narrow" });
  if (age < 7 * 24 * 60 * 60_000) return formatRelativeTime(-Math.floor(age / 86_400_000), "day", { numeric: "auto", style: "narrow" });
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

// Re-render clock for the running badge's elapsed label. ONE shared interval
// drives every subscribed row (previously each working row scheduled its own
// 1s timer); the interval stops as soon as the last working row unsubscribes.
let tickerTimer: ReturnType<typeof setInterval> | null = null;
let tickerNow = Date.now();
const tickerSubscribers = new Set<() => void>();

function subscribeTicker(onChange: () => void): () => void {
  tickerSubscribers.add(onChange);
  if (tickerTimer === null) {
    tickerNow = Date.now();
    tickerTimer = setInterval(() => {
      tickerNow = Date.now();
      for (const notify of tickerSubscribers) notify();
    }, 1_000);
  }
  return () => {
    tickerSubscribers.delete(onChange);
    if (tickerSubscribers.size === 0 && tickerTimer !== null) {
      clearInterval(tickerTimer);
      tickerTimer = null;
    }
  };
}

const subscribeNothing = () => () => {};

function useNowTick(enabled: boolean): number {
  return useSyncExternalStore(enabled ? subscribeTicker : subscribeNothing, () => tickerNow);
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
  opening: boolean;
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

/** Destructive actions confirm first while the agent is running or a
 *  question/permission is waiting; otherwise act immediately. */
function needsDestructiveConfirm(s: SessionProjection): boolean {
  return s.status === "working" || s.status === "waiting"
    || (s.attention?.questions ?? 0) > 0 || (s.attention?.permissions ?? 0) > 0;
}

function SessionRow({
  s, activeSessionId, labels, eventsTitle, opening, relativeTime, selectMode, selected,
  onToggleSelect, onChanged, onOpen, onTogglePin, pinnedSection, onPinDragStart, onPinDrop,
  contextLabel, pinnedWorktreeLabel,
}: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [swipeRevealed, setSwipeRevealed] = useState(false);
  const [swipeX, setSwipeX] = useState<number | null>(null);
  const sessionBtnRef = useRef<HTMLButtonElement>(null);
  // Menus opened from the row itself (context menu, long-press, Shift+F10)
  // return focus to the row button; trigger-opened menus fall back to the
  // trigger inside ui/Menu.
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressOpenedRef = useRef(false);
  const swipeStartRef = useRef<GesturePoint | null>(null);
  const swipeConsumedRef = useRef(false);
  const now = useNowTick(s.status === "working");
  const rowStatus = sessionRowStatus(s, now);

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
  const startSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || !event.isPrimary || renaming || selectMode) return;
    swipeStartRef.current = { x: event.clientX, y: event.clientY };
    swipeConsumedRef.current = false;
  };
  const moveSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    if (!start || event.pointerType !== "touch") return;
    const dx = horizontalDistance(start, { x: event.clientX, y: event.clientY });
    if (dx === null) return;
    cancelLongPress();
    swipeConsumedRef.current = true;
    const base = swipeRevealed ? -96 : 0;
    setSwipeX(Math.max(-96, Math.min(0, base + dx)));
  };
  const finishSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start || event.pointerType !== "touch") {
      setSwipeX(null);
      return;
    }
    const distance = horizontalDistance(start, { x: event.clientX, y: event.clientY });
    const next = distance !== null
      ? (swipeRevealed ? -96 : 0) + distance
      : (swipeRevealed ? -96 : 0);
    const revealed = next <= -SESSION_SWIPE_REVEAL;
    if (revealed !== swipeRevealed) tapFeedback();
    setSwipeRevealed(revealed);
    setSwipeX(null);
  };
  const cancelSwipe = () => {
    swipeStartRef.current = null;
    setSwipeX(null);
  };

  useEffect(() => () => cancelLongPress(), []);

  const quickArchive = async () => {
    const label = s.title || tr("sidebar.sessionlist.session");
    if (needsDestructiveConfirm(s) && !await confirmAlert(tr("sidebar.sessionlist.archiveValueTheAgentIsStillRunning", { label: label }), { title: tr("sidebar.sessionlist.archiveActiveSession"), confirmLabel: tr("common.archive") })) return;
    if (!needsDestructiveConfirm(s) && getUiSettings().confirmSessionArchive && !await confirmAlert(tr("sidebar.sessionlist.archiveValue", { label: label }), { title: tr("sidebar.sessionlist.archiveSession"), confirmLabel: tr("common.archive") })) return;
    void archiveSession(s.id)
      .then(() => {
        successFeedback();
        setSwipeRevealed(false);
        announce(tr("sidebar.sessionlist.archivedValue", { label: label }));
        onChanged();
      })
      .catch((e) => {
        errorFeedback();
        setUiError(friendlyError(tr("common.error"), e));
      });
  };

  const quickDelete = async () => {
    const label = s.title || tr("sidebar.sessionlist.session");
    const activity = needsDestructiveConfirm(s) ? ` ${tr("sidebar.sessionlist.theAgentIsStillRunningOr")}` : "";
    if (!await confirmAlert(tr("sidebar.sessionlist.deleteValueValueThisPermanentlyRemovesThe", { label: label, activity: activity }), { title: tr("sidebar.sessionlist.deleteSession"), confirmLabel: tr("common.delete") })) return;
    void deleteSession(s.id)
      .then(() => {
        successFeedback();
        setSwipeRevealed(false);
        announce(tr("sidebar.sessionlist.deletedValue", { label: label }));
        onChanged();
      })
      .catch((e) => {
        errorFeedback();
        setUiError(friendlyError(tr("common.error"), e));
      });
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
  const actionsLabel = tr("sidebar.sessionlist.actionsForValue", { value: s.title || tr("sidebar.sessionlist.session") });
  const checkedLabels = s.labelIds ?? [];
  const menuEntries: MenuEntry[] = [
    { id: "rename", label: tr("common.rename"), onSelect: () => { setTitle(s.title); setRenaming(true); } },
    {
      id: "fork",
      label: tr("sidebar.sessionlist.fork"),
      onSelect: () => void forkSession(s.id).catch((e) => setUiError(friendlyError(tr("common.error"), e))),
    },
    { id: "copy-id", label: tr("sidebar.sessionlist.copySessionId"), onSelect: () => void copySessionId() },
    {
      id: "pin",
      label: s.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop"),
      onSelect: () => onTogglePin(s),
    },
    "separator",
    s.status === "archived"
      ? {
          id: "restore",
          label: tr("common.restore"),
          onSelect: () => void restoreSession(s.id).then(onChanged).catch((e) => setUiError(friendlyError(tr("common.error"), e))),
        }
      : { id: "archive", label: tr("common.archive"), onSelect: () => void quickArchive() },
    { id: "delete", label: tr("common.delete"), danger: true, onSelect: () => void quickDelete() },
    ...(labels.length > 0 ? [{ heading: tr("sidebar.sessionlist.labels") }] : []),
    ...labels.map((l): MenuEntry => ({
      id: `label-${l.id}`,
      label: l.name,
      kind: "checkbox",
      checked: checkedLabels.includes(l.id),
      swatch: l.color,
      onSelect: () => void toggleLabel(l.id),
    })),
  ];
  const openRowMenu = () => {
    menuReturnRef.current = sessionBtnRef.current;
    setMenuOpen(true);
  };

  return (
    <div
      className={`session-row ${rowStatus.kind}${contextLabel ? " search-result" : ""} ${s.id === activeSessionId ? "active" : ""} ${s.status === "archived" ? "archived" : ""}${menuOpen ? " menu-open" : ""}`}
      style={swipeX === null ? undefined : { "--session-swipe-x": `${swipeX}px` } as CSSProperties}
      data-swipe={swipeX !== null ? "dragging" : swipeRevealed ? "revealed" : "closed"}
      draggable={pinnedSection}
      onDragStart={() => { if (pinnedSection) onPinDragStart(s.id); }}
      onDragOver={(event) => { if (pinnedSection) event.preventDefault(); }}
      onDrop={(event) => { if (pinnedSection) { event.preventDefault(); onPinDrop(s.id); } }}
      onPointerDown={startSwipe}
      onPointerMove={moveSwipe}
      onPointerUp={finishSwipe}
      onPointerCancel={cancelSwipe}
      onContextMenu={(event) => {
        event.preventDefault();
        openRowMenu();
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
          aria-expanded={swipeRevealed}
          aria-busy={opening || undefined}
          aria-label={tr("sidebar.sessionlist.openValue", { displayTitle: displayTitle })}
          title={hoverTitle}
          onClick={(event) => {
            if (longPressOpenedRef.current || swipeConsumedRef.current) {
              event.preventDefault();
              longPressOpenedRef.current = false;
              swipeConsumedRef.current = false;
              return;
            }
            if (swipeRevealed) {
              event.preventDefault();
              setSwipeRevealed(false);
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
              openRowMenu();
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
            {opening ? (
              <span className="session-opening-indicator" title={tr("common.loading")} aria-label={tr("common.loading")}>
                <span className="spinner" aria-hidden="true" />
              </span>
            ) : (
              <>
                <AttentionBadges status={rowStatus} />
                <StatusBadge status={rowStatus} />
              </>
            )}
            {!opening && (rowStatus.kind === "regular" || rowStatus.kind === "unread") && activityLabel && (
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
        <Menu
          label={actionsLabel}
          title={displayTitle}
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          returnFocusRef={menuReturnRef}
          entries={menuEntries}
          footer={<SlotHost slot="sidebar.session.actions" context={{ sessionId: s.id, status: s.status }} />}
        >
          {(trigger) => (
            <button
              {...trigger}
              type="button"
              className="session-menu-trigger"
              title={actionsLabel}
              aria-label={actionsLabel}
              onClick={() => {
                menuReturnRef.current = null;
                tapFeedback();
                setSwipeRevealed(false);
                trigger.onClick();
              }}
            >
              <Icon.more />
            </button>
          )}
        </Menu>
      )}
      {!renaming && (swipeX !== null || swipeRevealed) && (
        <span className="session-quick">
          {s.status !== "archived" && (
            <button
              className="session-quick-btn"
              title={tr("sidebar.sessionlist.archiveValue2", { value: s.title || tr("sidebar.sessionlist.session") })}
              aria-label={tr("sidebar.sessionlist.archiveValue2", { value: s.title || tr("sidebar.sessionlist.session") })}
              onClick={quickArchive}
            ><Icon.download /></button>
          )}
          <button
            className="session-quick-btn danger"
            title={tr("sidebar.sessionlist.deleteValue", { value: s.title || tr("sidebar.sessionlist.session") })}
            aria-label={tr("sidebar.sessionlist.deleteValue", { value: s.title || tr("sidebar.sessionlist.session") })}
            onClick={quickDelete}
          >✕</button>
        </span>
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
  const openingSessionId = useStore((st) => st.openingSessionId);
  // Narrow subscription: rows only need each session's derived title (its
  // first user message). Selecting the whole events map re-rendered the whole
  // list on EVERY streamed chunk of every session; this fingerprint changes
  // only when a derived title appears or changes (the per-array WeakMap cache
  // keeps the selector cheap, and the store LRU bounds the entry count).
  const titlesFingerprint = useStore((st) => {
    let out = "";
    for (const id in st.events) {
      const text = firstUserTextCached(st.events[id]);
      if (text !== undefined) out += `${id}\u0000${text}\u0001`;
    }
    return out;
  });
  const eventsTitles = useMemo(() => {
    const events = getState().events;
    const titles = new Map<string, string>();
    for (const id in events) {
      const text = firstUserTextCached(events[id]);
      if (text !== undefined) titles.set(id, text);
    }
    return titles;
  }, [titlesFingerprint]);
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
      eventsTitle={eventsTitles.get(s.id)}
      opening={openingSessionId === s.id}
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
        <Dialog
          title={tr("sidebar.sessionlist.deleteWorktreeAndItsSessions")}
          onClose={() => { if (!removeBusy) setRemoveTarget(null); }}
          footer={(
            <>
              <Button size="sm" disabled={removeBusy} onClick={() => setRemoveTarget(null)}>{tr("common.cancel")}</Button>
              <span className="header-spacer" />
              <Button
                size="sm"
                variant="danger"
                busy={removeBusy}
                onClick={() => {
                  setRemoveBusy(true);
                  void Promise.all(sessionsForRemoval.map((session) => deleteSession(session.id)))
                    .then(() => api.removeWorktree(projectId, removeTarget.path, deleteBranch))
                    .then(() => { setRemoveTarget(null); onChanged(); })
                    .catch((error) => setUiError(friendlyError(tr("sidebar.sessionlist.couldnTRemoveTheWorktree"), error)))
                    .finally(() => setRemoveBusy(false));
                }}
              >
                {removeBusy ? tr("sidebar.sessionlist.deleting") : tr("sidebar.sessionlist.deleteWorktree")}
              </Button>
            </>
          )}
        >
          <p className="muted worktree-remove-path">
            {tr("sidebar.sessionlist.deleteValueWorktree", { value: worktreeLabel(removeTarget.branch, removeTarget.path) })}
            <br />{removeTarget.path}
          </p>
          <div className="worktree-remove-options">
            <Checkbox checked disabled onChange={() => {}} label={tr("sidebar.sessionlist.deleteTheLocalWorktreeCheckout")} />
            <Checkbox
              checked
              disabled
              onChange={() => {}}
              label={sessionsForRemoval.length === 1
                ? tr("sidebar.sessionlist.permanentlyDeleteOneSessionIn")
                : tr("sidebar.sessionlist.permanentlyDeleteValueSessionsIn", { count: sessionsForRemoval.length })}
            />
            <Checkbox
              checked={deleteBranch}
              onChange={setDeleteBranch}
              label={`${tr("sidebar.sessionlist.alsoDeleteItsDedicatedBranch")}${removeTarget.branch ? ` (${removeTarget.branch})` : ""}`}
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}
