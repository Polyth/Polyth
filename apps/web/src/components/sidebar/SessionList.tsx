// Organized session list: worktree grouping, labels, attention badges,
// inline rename, archived section, bulk archive/restore with partial-failure
// reporting. All mutations go through the REST org endpoints.
import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import type { SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { api, errorChangesOf, errorCodeOf, type Worktree } from "@polyth/session/web-api";
import {
  getState, setSidebarOpen, setUiError, startNewSession, useStore,
} from "../../store.ts";
import { openSession, prefetchSessionTail, deleteSession, restoreSession, forkSession, refreshSessions } from "../../init.ts";
import { markSessionPerformance } from "../../sessionPerformance.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../../sessionStatus.ts";
import { fullSessionTitle } from "../../format.ts";
import { friendlyError } from "../../settings.ts";
import { confirmAlert } from "../../alerts.ts";
import {
  archiveSessionWithPolicy,
  needsDestructiveConfirm,
  renameSessionTitle,
  toggleSessionPin,
} from "../../sessionActions.ts";
import { copyText, firstUserTextCached } from "../../utils.ts";
import { announce } from "../a11y/live.tsx";
import { worktreeLabel } from "../../worktreeSessions.ts";
import SlotHost from "../slots/SlotHost.ts";
import SessionHoverCard from "./SessionHoverCard.tsx";
import {
  Button, Checkbox, Dialog, EmptyState, Menu, ResponsiveOverlay, TextInput,
  type MenuEntry,
} from "../ui/index.ts";
import {
  compareSessionNavigation,
  groupSessionsByActivityDate,
  sessionDateGroupLabel,
  sessionDateInputValue,
  sessionMatchesDateFilter,
  sortPinnedSessions,
  EMPTY_SESSION_DATE_FILTER,
  type SessionDateFilter,
} from "../../sessionDates.ts";
import { Icon } from "../../icons.tsx";
import { getLocale, tr } from "../../i18n/index.ts";
import { errorFeedback, successFeedback, tapFeedback } from "../../haptics.ts";
import { horizontalDistance, SESSION_SWIPE_REVEAL, type GesturePoint } from "../../mobileGestures.ts";
import { useShiftArmed } from "../../useShiftArmed.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { useInlineRename } from "../input/inlineRename.ts";

const INITIAL_VISIBLE_SESSIONS = 6;
const INLINE_LABEL_LIMIT = 6;
const isManagedIsolationBranch = (branch: string | null | undefined): boolean =>
  branch?.startsWith("polyth/isolate/") === true;
const isIsolatedSession = (session: Pick<SessionProjection, "isolation" | "branch">): boolean =>
  session.isolation?.kind === "git-worktree" || isManagedIsolationBranch(session.branch);

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
    return <span className="session-status-indicator approval" title={status.label} aria-label={status.label}><span aria-hidden>{status.glyph}</span></span>;
  }
  if (status.kind === "needs-reply") {
    return <span className="session-status-indicator reply" title={status.label} aria-label={status.label}><span className="session-question-icon" aria-hidden><Icon.question /></span></span>;
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
  if (status.kind === "failed" || status.kind === "reconciling" || status.kind === "unknown" || status.kind === "epoch-pending") {
    return (
      <span
        className={`session-status-indicator ${status.kind}`}
        title={status.label}
        aria-label={status.label}
      >
        <span aria-hidden>{status.glyph}</span>
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
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
  onTogglePin: (session: SessionProjection) => void;
  projectName?: string;
  branch?: string | null;
  workspacePath?: string | null;
  contextLabel?: string;
  pinnedWorktreeLabel?: string;
  /** Shift-key customization mode (desktop): hovering the row reveals the
   *  Archive/Delete quick actions without opening the menu. */
  shiftQuick: boolean;
}

function SessionRow({
  s, activeSessionId, labels, eventsTitle, opening, selectMode, selected,
  onToggleSelect, onChanged, onOpen, onTogglePin,
  projectName, branch, workspacePath, contextLabel, pinnedWorktreeLabel, shiftQuick,
}: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [labelQuery, setLabelQuery] = useState("");
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
  const rowStatus = resolveSessionStatus(s, now);

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
    void archiveSessionWithPolicy(s)
      .then((archived) => {
        if (!archived) return;
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

  const performDelete = () => {
    const label = s.title || tr("sidebar.sessionlist.session");
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

  const quickDelete = async () => {
    const label = s.title || tr("sidebar.sessionlist.session");
    const activity = [
      s.isolation ? tr("sidebar.sessionlist.theLocalIsolationWorkspaceAndEveryFileInItWillAlsoBePermanentlyDeleted") : "",
      needsDestructiveConfirm(s) ? tr("sidebar.sessionlist.theAgentIsStillRunningOr") : "",
    ].filter(Boolean).join(" ");
    if (!await confirmAlert(tr("sidebar.sessionlist.deleteValueValueThisPermanentlyRemovesThe", { label: label, activity: activity ? ` ${activity}` : "" }), { title: tr("sidebar.sessionlist.deleteSession"), confirmLabel: tr("common.delete") })) return;
    performDelete();
  };

  // Shift-hover quick delete: deliberate (modifier held), so it skips the
  // confirmation unless the session is still active or owns a workspace.
  const shiftQuickDelete = async () => {
    if (s.isolation || needsDestructiveConfirm(s)) {
      const label = s.title || tr("sidebar.sessionlist.session");
      const activity = [
        s.isolation ? tr("sidebar.sessionlist.theLocalIsolationWorkspaceAndEveryFileInItWillAlsoBePermanentlyDeleted") : "",
        needsDestructiveConfirm(s) ? tr("sidebar.sessionlist.theAgentIsStillRunningOr") : "",
      ].filter(Boolean).join(" ");
      if (!await confirmAlert(tr("sidebar.sessionlist.deleteValueValueThisPermanentlyRemovesThe", { label: label, activity: ` ${activity}` }), { title: tr("sidebar.sessionlist.deleteSession"), confirmLabel: tr("common.delete") })) return;
    }
    performDelete();
  };

  const doRename = async () => {
    const t = title.trim();
    setRenaming(false);
    if (!t || t === s.title) return;
    try {
      const renamed = await renameSessionTitle(s.id, s.title, t);
      if (!renamed) return;
      announce(tr("sidebar.sessionlist.sessionRenamedToValue", { t: renamed }));
      onChanged();
    } catch (e) {
      setUiError(friendlyError(tr("common.error"), e));
    }
  };

  const renameKeys = useInlineRename({
    editing: renaming,
    commit: () => void doRename(),
    cancel: () => { setTitle(s.title); setRenaming(false); },
  });

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
  const displayTitle = fullSessionTitle(s.title, eventsTitle);
  const actionsLabel = tr("sidebar.sessionlist.actionsForValue", { value: s.title || tr("sidebar.sessionlist.session") });
  const checkedLabels = s.labelIds ?? [];
  const normalizedLabelQuery = labelQuery.trim().toLocaleLowerCase(getLocale());
  const visibleLabels = normalizedLabelQuery === ""
    ? labels
    : labels.filter((label) => label.name.toLocaleLowerCase(getLocale()).includes(normalizedLabelQuery));
  const labelEntries: MenuEntry[] = labels.length > INLINE_LABEL_LIMIT
    ? [{
        id: "labels",
        label: tr("sidebar.sessionlist.labelsMenu"),
        onSelect: () => {
          setLabelQuery("");
          setLabelPickerOpen(true);
        },
      }]
    : labels.map((l): MenuEntry => ({
        id: `label-${l.id}`,
        label: l.name,
        kind: "checkbox",
        checked: checkedLabels.includes(l.id),
        swatch: l.color,
        onSelect: () => void toggleLabel(l.id),
      }));
  const menuEntries: MenuEntry[] = [
    { id: "rename", label: tr("common.rename"), onSelect: () => { setTitle(s.title); setRenaming(true); } },
    ...(!s.isolation ? [{
      id: "fork",
      label: tr("sidebar.sessionlist.fork"),
      onSelect: () => void forkSession(s.id).catch((e) => setUiError(friendlyError(tr("common.error"), e))),
    } satisfies MenuEntry] : []),
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
    ...labelEntries,
  ];
  const openRowMenu = () => {
    menuReturnRef.current = sessionBtnRef.current;
    setMenuOpen(true);
  };

  return (
    <div
      className={`session-row ${rowStatus.kind}${contextLabel ? " search-result" : ""} ${s.id === activeSessionId ? "active" : ""} ${s.status === "archived" ? "archived" : ""}${s.pinned ? " pinned" : ""}${menuOpen ? " menu-open" : ""}${shiftQuick && !renaming ? " shift-quick" : ""}`}
      style={swipeX === null ? undefined : { "--session-swipe-x": `${swipeX}px` } as CSSProperties}
      data-swipe={swipeX !== null ? "dragging" : swipeRevealed ? "revealed" : "closed"}
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
          {...renameKeys}
        />
      ) : (
        <SessionHoverCard
          title={displayTitle}
          projectName={projectName}
          branch={branch}
          path={workspacePath}
          isolated={isIsolatedSession(s)}
        >
          <button
            ref={sessionBtnRef}
            className="session-btn"
            aria-current={s.id === activeSessionId ? "true" : undefined}
            aria-expanded={swipeRevealed}
            aria-busy={opening || undefined}
            aria-label={tr("sidebar.sessionlist.openValue", { displayTitle: displayTitle })}
            onPointerEnter={() => prefetchSessionTail(s.id)}
            onPointerDown={(event) => {
              if (event.pointerType === "touch") prefetchSessionTail(s.id);
            }}
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
              markSessionPerformance("session_click", s.id);
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
              {s.pinned && (
                <span
                  className="session-pin-icon"
                  title={tr("sidebar.sessionlist.pinnedChats")}
                  aria-label={tr("sidebar.sessionlist.pinnedChats")}
                ><Icon.pin /></span>
              )}
              <span className="session-title-text">{displayTitle}</span>
              {pinnedWorktreeLabel && rowStatus.kind === "regular" && (
                <span
                  className={`session-worktree-label${pinnedWorktreeLabel.length > 12 ? " session-worktree-label-compact" : ""}`}
                  title={pinnedWorktreeLabel}
                  aria-label={pinnedWorktreeLabel}
                >
                  <Icon.branch />
                  {pinnedWorktreeLabel.length <= 12 && <span>{pinnedWorktreeLabel}</span>}
                </span>
              )}
              <SlotHost
                slot="session.list.badges"
                context={{ sessionId: s.id, questions: s.attention?.questions ?? 0, permissions: s.attention?.permissions ?? 0 }}
              />
            </span>
            {contextLabel && <span className="session-search-context">{contextLabel}</span>}
            <span className="session-status-zone">
              {opening ? (
                <span className="session-opening-indicator" title={tr("common.loading")} aria-label={tr("common.loading")}>
                  <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />
                </span>
              ) : (
                <>
                  <AttentionBadges status={rowStatus} />
                  <StatusBadge status={rowStatus} />
                </>
              )}
            </span>
          </button>
        </SessionHoverCard>
      )}
      {!renaming && (
        <Menu
          label={actionsLabel}
          title={pinnedWorktreeLabel ? `${displayTitle} · ${pinnedWorktreeLabel}` : displayTitle}
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
      <ResponsiveOverlay
        open={labelPickerOpen}
        title={tr("sidebar.sessionlist.labels")}
        desktop="dialog"
        dialogSize="sm"
        sheetSize="tall"
        className="session-label-picker"
        restoreFocusRef={sessionBtnRef}
        sheetSearch={{
          value: labelQuery,
          onChange: setLabelQuery,
          placeholder: tr("sidebar.sessionlist.searchLabels"),
          ariaLabel: tr("sidebar.sessionlist.searchLabels"),
          role: "searchbox",
        }}
        onClose={() => setLabelPickerOpen(false)}
      >
        <TextInput
          className="session-label-search"
          type="search"
          value={labelQuery}
          placeholder={tr("sidebar.sessionlist.searchLabels")}
          aria-label={tr("sidebar.sessionlist.searchLabels")}
          onChange={(event) => setLabelQuery(event.target.value)}
        />
        {visibleLabels.length > 0 ? (
          <div className="session-label-options">
            {visibleLabels.map((label) => (
              <Checkbox
                key={label.id}
                className="session-label-option"
                checked={checkedLabels.includes(label.id)}
                onChange={() => void toggleLabel(label.id)}
                label={(
                  <span className="session-label-option-copy">
                    <span className="session-label-swatch" style={{ background: label.color }} aria-hidden="true" />
                    <span>{label.name}</span>
                  </span>
                )}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            variant="compact"
            title={tr("sidebar.sessionlist.noLabelsMatch")}
          />
        )}
      </ResponsiveOverlay>
      {!renaming && (swipeX !== null || swipeRevealed || shiftQuick) && (
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
            onClick={shiftQuick && swipeX === null && !swipeRevealed ? shiftQuickDelete : quickDelete}
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
  dateFilter = EMPTY_SESSION_DATE_FILTER,
}: {
  projectId: string;
  query?: string;
  attentionOnly?: boolean;
  selectMode?: boolean;
  selectedSessionIds?: ReadonlySet<string>;
  onToggleSelected?: (id: string) => void;
  searchMode?: boolean;
  searchProjectName?: string;
  dateFilter?: SessionDateFilter;
}) {
  const sessions = useStore((st) => st.sessions);
  const project = useStore((st) => st.projectRegistry.projects.find((candidate) => candidate.id === projectId));
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
  const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [expandedSubagents, setExpandedSubagents] = useState<ReadonlySet<string>>(new Set());
  const [showArchived, setShowArchived] = useState(expandArchived);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_SESSIONS);
  const [removeTarget, setRemoveTarget] = useState<Worktree | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removePhase, setRemovePhase] = useState<"confirm" | "dirty">("confirm");
  const [dirtyChanges, setDirtyChanges] = useState(0);
  // Shift-key customization mode is a desktop mouse-only affordance: shift+hover
  // reveals Archive/Delete on a row. Landscape-wide tablets still use
  // shellMode "wide", but useShiftArmed refuses any-pointer:coarse devices so
  // a virtual/bluetooth Shift cannot paint every row as if the modifier were
  // held; compact/touch shells keep swipe + menu only.
  const shiftArmed = useShiftArmed();
  const shellMode = useShellMode();
  const shiftQuick = shiftArmed && shellMode === "wide" && !selectMode;

  useEffect(() => {
    setShowArchived(expandArchived);
  }, [expandArchived]);
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_SESSIONS);
  }, [projectId, query, attentionOnly, dateFilter.mode, dateFilter.date, dateFilter.from, dateFilter.to]);
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (projectSessions.length === 0) void refreshSessions(projectId);
  }, [projectId]);
  // Worktrees appear and disappear outside this sidebar — created by the Git
  // UI, by an agent, by a shell. The server bumps this project's topology
  // revision when that happens, so the list re-reads without a reload.
  const worktreeTopology = useStore((st) => st.worktreeTopology[projectId] ?? 0);
  const reloadOrg = () => {
    void api.listLabels().then(setLabels);
    void api.listWorktrees(projectId).then(setWorktrees);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reloadOrg, [projectId, worktreeTopology]);

  const onChanged = () => {
    void refreshSessions(projectId);
    reloadOrg();
  };

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.projectId === projectId).sort(compareSessionNavigation),
    [sessions, projectId],
  );
  const needle = query.trim().toLowerCase();
  const matchesFilters = (session: SessionProjection) => {
    if (
      needle
      && !`${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLowerCase().includes(needle)
    ) return false;
    if (!sessionMatchesDateFilter(session, dateFilter)) return false;
    if (!attentionOnly) return true;
    return session.status === "working"
      || session.status === "waiting"
      || session.status === "reconciling"
      || session.status === "unknown"
      || session.status === "epoch-pending"
      || (session.attention?.questions ?? 0) > 0
      || (session.attention?.permissions ?? 0) > 0;
  };
  const matchingActive = projectSessions.filter((s) => s.status !== "archived" && matchesFilters(s));
  const mainWorktree = worktrees.find((worktree) => worktree.isMain);
  const worktreeKey = (session: SessionProjection): string =>
    !session.worktreePath || session.worktreePath === mainWorktree?.path || isIsolatedSession(session)
      ? "__main__"
      : session.worktreePath;
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
  // Pagination is project-wide, but every worktree still needs its newest
  // matching row or it falsely renders as empty until "Show more" is pressed.
  if (!searchMode) {
    const visibleWorktrees = new Set(
      active.filter((session) => session.pinned === undefined).map(worktreeKey),
    );
    for (const session of unpinnedActive) {
      const key = worktreeKey(session);
      if (visibleWorktrees.has(key)) continue;
      visibleWorktrees.add(key);
      active.push(session);
    }
  }
  // Children are part of the parent's navigation context. They must not
  // disappear behind the session pagination while their parent is visible.
  const visibleIds = new Set(active.map((session) => session.id));
  let addedChild = true;
  while (addedChild) {
    addedChild = false;
    for (const session of orderedActive) {
      if (session.parentId && visibleIds.has(session.parentId) && !visibleIds.has(session.id)) {
        visibleIds.add(session.id);
        active.push(session);
        addedChild = true;
      }
    }
  }
  const archived = projectSessions.filter((s) => s.status === "archived" && matchesFilters(s));
  const hiddenActive = searchMode ? 0 : Math.max(0, orderedActive.length - active.length);
  const sessionsForRemoval = removeTarget === null
    ? []
    : projectSessions.filter((session) => worktreeKey(session) === removeTarget.path);

  const byWorktree = new Map<string, SessionProjection[]>();
  for (const s of active.filter((session) => session.pinned === undefined)) {
    const key = worktreeKey(s);
    byWorktree.set(key, [...(byWorktree.get(key) ?? []), s]);
  }
  for (const grouped of byWorktree.values()) grouped.sort(compareSessionNavigation);
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
      await toggleSessionPin(
        session,
        projectSessions.filter((candidate) => candidate.status !== "archived" && candidate.pinned !== undefined),
      );
      successFeedback();
      onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const dividerNow = Date.now();
  const dateDivider = (timestamp: number) => {
    if (sessionDateInputValue(timestamp) === sessionDateInputValue(dividerNow)) return null;
    const label = sessionDateGroupLabel(timestamp, relativeTime, getLocale(), dividerNow);
    return (
      <div className="session-date-divider" role="separator" aria-label={label}>
        <span>{label}</span>
      </div>
    );
  };

  const row = (
    s: SessionProjection,
    contextLabel?: string,
    pinnedWorktreeLabel?: string,
  ) => {
    const checkout = s.worktreePath
      ? worktrees.find((worktree) => worktree.path === s.worktreePath)
      : mainWorktree;
    return (
      <SessionRow
        key={s.id}
        s={s}
        activeSessionId={activeSessionId}
        labels={labels}
        eventsTitle={eventsTitles.get(s.id)}
        opening={openingSessionId === s.id}
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
        projectName={project?.name || searchProjectName}
        branch={s.branch ?? checkout?.branch}
        workspacePath={s.worktreePath ?? checkout?.path ?? project?.path}
        contextLabel={contextLabel}
        pinnedWorktreeLabel={pinnedWorktreeLabel}
        shiftQuick={shiftQuick}
      />
    );
  };

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
  const sessionTree = (items: readonly SessionProjection[]) => {
    const byParent = new Map<string, SessionProjection[]>();
    const ids = new Set(items.map((item) => item.id));
    for (const item of items) {
      if (!item.parentId || !ids.has(item.parentId)) continue;
      byParent.set(item.parentId, [...(byParent.get(item.parentId) ?? []), item]);
    }
    const roots = items.filter((item) => !item.parentId || !ids.has(item.parentId));
    const renderNode = (item: SessionProjection): ReactNode => {
      const children = byParent.get(item.id) ?? [];
      const expanded = expandedSubagents.has(item.id);
      return (
        <div className="session-subagent-parent" key={item.id}>
          {row(item)}
          {children.length > 0 && (
            <button
              type="button"
              className="session-subagent-toggle"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${children.length} subagents`}
              onClick={() => setExpandedSubagents((previous) => {
                const next = new Set(previous);
                if (next.has(item.id)) next.delete(item.id);
                else next.add(item.id);
                return next;
              })}
            >{expanded ? <Icon.chevronDown /> : <Icon.chevronRight />}</button>
          )}
          {expanded && <div className="session-subagent-children">{children.map(renderNode)}</div>}
        </div>
      );
    };
    return groupSessionsByActivityDate(roots).map((group) => (
      <div className="session-date-group" key={group.key}>
        {dateDivider(group.timestamp)}
        {group.sessions.map(renderNode)}
      </div>
    ));
  };
  const datedRows = (
    items: readonly SessionProjection[],
    render: (session: SessionProjection) => ReturnType<typeof row> = (session) => row(session),
  ) => groupSessionsByActivityDate(items).map((group) => (
    <div className="session-date-group" key={group.key}>
      {dateDivider(group.timestamp)}
      {group.sessions.map(render)}
    </div>
  ));

  if (searchMode) {
    const results = [...orderedActive, ...archived].sort(compareSessionNavigation);
    const pinnedResults = results.filter((session) => session.pinned !== undefined);
    const datedResults = results.filter((session) => session.pinned === undefined);
    const searchRow = (session: SessionProjection) => row(
      session,
      `${searchProjectName} · ${worktreeNameForSession(session)}`,
    );
    return (
      <div className="session-org session-search-mode">
        {pinnedResults.length > 0 && (
          <div className="session-pinned" aria-label={tr("sidebar.sessionlist.pinnedChats")}>
            <div className="session-date-divider session-pinned-divider" role="separator">
              <span><Icon.pin />{tr("sidebar.sessionlist.pinnedChats")}</span>
            </div>
            {pinnedResults.map(searchRow)}
          </div>
        )}
        {datedRows(datedResults, searchRow)}
        {results.length === 0 && <div className="empty session-list-empty">{tr("sidebar.sessionlist.noMatchingSessions")}</div>}
      </div>
    );
  }

  return (
    <div className="session-org">
      {pinned.length > 0 && (
        <div className="session-pinned" aria-label={tr("sidebar.sessionlist.pinnedChats")}>
          <div className="session-date-divider session-pinned-divider" role="separator">
            <span><Icon.pin />{tr("sidebar.sessionlist.pinnedChats")}</span>
          </div>
          {pinned.map((session) => row(
            session,
            undefined,
            isIsolatedSession(session) ? undefined : worktreeNameForSession(session),
          ))}
        </div>
      )}
      {mainSessions.length > 0 && (
        <div className="session-project-sessions session-worktree-sessions">
          {sessionTree(mainSessions)}
        </div>
      )}
      {worktreeGroups.map((group) => {
        const isCollapsed = collapsed.get(group.key) ?? group.sessions.length === 0;
        const managedIsolation = isManagedIsolationBranch(group.worktree?.branch)
          || group.sessions.some((session) => session.isolation?.kind === "git-worktree");
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
                  const next = new Map(prev);
                  next.set(group.key, !isCollapsed);
                  return next;
                })}
              >
                <span className="session-worktree-toggle-sign" aria-hidden="true">{isCollapsed ? "+" : "−"}</span>
                <Icon.branch />
                <span className="session-worktree-name">{group.label}</span>
              </button>
              {!managedIsolation && <span className="session-worktree-actions">
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
                      setRemovePhase("confirm");
                      setDirtyChanges(0);
                      setRemoveTarget(group.worktree);
                    }}
                  ><Icon.trash /></button>
                )}
              </span>}
            </div>
            {!isCollapsed && (
              <div className="session-worktree-sessions">
                {sessionTree(group.sessions)}
                {group.sessions.length === 0 && <div className="empty session-list-empty">{tr("sidebar.sessionlist.noMatchingSessions")}</div>}
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
          {showArchived && datedRows(archived)}
        </div>
      )}
      {removeTarget && (
        <Dialog
          title={tr("sidebar.sessionlist.deleteWorktreeAndItsSessions")}
          onClose={() => {
            if (removeBusy) return;
            setRemovePhase("confirm");
            setDirtyChanges(0);
            setRemoveTarget(null);
          }}
          footer={(
            <>
              <Button
                size="sm"
                disabled={removeBusy}
                onClick={() => {
                  setRemovePhase("confirm");
                  setDirtyChanges(0);
                  setRemoveTarget(null);
                }}
              >{tr("common.cancel")}</Button>
              <span className="header-spacer" />
              <Button
                size="sm"
                variant="danger"
                busy={removeBusy}
                onClick={() => {
                  const force = removePhase === "dirty";
                  const path = removeTarget.path;
                  const sessionIds = sessionsForRemoval.map((session) => session.id);
                  setRemoveBusy(true);
                  void api.removeWorktree(projectId, path, deleteBranch, force)
                    .then(async (result) => {
                      setRemoveTarget(null);
                      setRemovePhase("confirm");
                      setDirtyChanges(0);
                      onChanged();
                      const settled = await Promise.allSettled(sessionIds.map((id) => deleteSession(id)));
                      if (result.metadataCleanupFailed || result.branchCleanupFailed || settled.some((item) => item.status === "rejected")) {
                        setUiError(tr("sidebar.sessionlist.couldnTCleanUpSessionsAfterRemovingTheWorktree"));
                      }
                    })
                    .catch((error) => {
                      if (!force && errorCodeOf(error) === "worktree-dirty") {
                        setRemovePhase("dirty");
                        setDirtyChanges(errorChangesOf(error));
                        return;
                      }
                      setUiError(friendlyError(tr("sidebar.sessionlist.couldnTRemoveTheWorktree"), error));
                    })
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
          <p className="muted">{tr("gitview.theLinkedWorktreeAtValue", { path: removeTarget.path })}</p>
          {removePhase === "dirty" && (
            <p className="muted" role="alert">
              {dirtyChanges > 0
                ? tr("gitview.destroyDirtyWorktreeValue", { count: dirtyChanges })
                : tr("gitview.destroyDirtyWorktree")}
            </p>
          )}
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
