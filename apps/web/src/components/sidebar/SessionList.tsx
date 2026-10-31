// Organized session list: worktree grouping, labels, attention badges,
// inline rename, archive entry, bulk archive/restore with partial-failure
// reporting. All mutations go through the REST org endpoints.
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import type { SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { api, errorChangesOf, errorCodeOf, type Worktree } from "@polyth/session/web-api";
import {
  getState, openArchivedSessions, openSessionSharing, overlaySessionProjection, setSidebarOpen, setUiError, startFreshSession, useStore,
} from "../../store.ts";
import { canManageSession, sharingMarkerLabel } from "../../sessionSharing.ts";
import { conversationUnread, hasMentionAttention, setSessionMuted, unreadBadgeText } from "../../sessionPeople.ts";
import { useHasArchivedSessions } from "../../useHasArchivedSessions.ts";
import { openSession, prefetchSessionTail, deleteSession, restoreSession, forkSession, refreshSessions, withOptimisticSessionChange } from "../../init.ts";
import { markSessionPerformance } from "../../sessionPerformance.ts";
import { collectSessionSummaries } from "../../sessionSummaryPages.ts";
import { useSessionSummaryPages } from "../../useSessionSummaryPages.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../../sessionStatus.ts";
import { fmtSessionElapsed, fullSessionTitle } from "../../format.ts";
import { draftTitleSource, sessionDraftMark } from "../../sessionDraft.ts";
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
  sessionMatchesDateFilter,
  sortPinnedSessions,
  EMPTY_SESSION_DATE_FILTER,
  type SessionDateFilter,
} from "../../sessionDates.ts";
import { Icon } from "../../icons.tsx";
import UiIcon from "../ui/Icon.tsx";
import Badge from "../ui/Badge.tsx";
import { ArchiveIcon, ChevronRightIcon, MentionIcon, PeopleIcon, SharedIcon, ShieldAlertIcon, TimerIcon } from "../ui/icons.ts";
import { getLocale, tr } from "../../i18n/index.ts";
import {
  arrangeSessions, getVisibleSessionCount, isIsolatedSession, sessionGroupsOf, setVisibleSessionCount,
  SESSION_MAIN_WORKTREE_KEY, useSessionGrouping, useSessionSortMode, useSidebarViewMode,
} from "../../sidebarPrefs.ts";
import { errorFeedback, successFeedback, tapFeedback } from "../../haptics.ts";
import { horizontalDistance, SESSION_SWIPE_REVEAL, type GesturePoint } from "../../mobileGestures.ts";
import { useShiftArmed } from "../../useShiftArmed.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { openSessionInSplit } from "../../sessionSplit.ts";
import { setDragSession } from "../../dnd.ts";
import { useInlineRename } from "../input/inlineRename.ts";
import { useLaneSessions } from "../../workbench/profileNavigation.ts";
import { childrenByParent, isNavigatorRoot, listedAncestors } from "../../sessionTree.ts";
import { useSessionParentPending } from "../../sessionParents.ts";
import { sessionActivityState, subagentActivity, subagentActivityTone, type SubagentActivity } from "../../subagentActivity.ts";
import { SubagentCount, subagentActivityLabel } from "./SubagentCount.tsx";

const INLINE_LABEL_LIMIT = 6;
const isManagedIsolationBranch = (branch: string | null | undefined): boolean =>
  branch?.startsWith("polyth/isolate/") === true;

/** Leading status mark. Every row reserves this one fixed slot so titles
 *  align down the list whatever the state; an idle row leaves it empty. */
function LeadStatus({ status, opening }: { status: SessionRowStatus; opening: boolean }) {
  if (opening) return <span className="ui-spinner ui-spinner--sm" aria-hidden="true" />;
  switch (status.kind) {
    case "working":
    case "reconciling":
      return <span className={`session-lead-spinner ${status.kind}`} aria-hidden="true" />;
    case "needs-reply":
      return <span className="session-lead-mark reply" aria-hidden="true"><Icon.question /></span>;
    case "needs-approval":
      // A shield, never a check: a check reads as "done" next to finished work.
      return <span className="session-lead-mark approval" aria-hidden="true"><UiIcon icon={ShieldAlertIcon} size="sm" /></span>;
    case "failed":
    case "epoch-pending":
      return <span className={`session-lead-mark ${status.kind}`} aria-hidden="true">!</span>;
    case "unknown":
      return <span className="session-lead-mark unknown" aria-hidden="true">?</span>;
    case "rate-limited":
      return <span className="session-lead-mark rate-limited" aria-hidden="true"><UiIcon icon={TimerIcon} size="sm" /></span>;
    case "unread":
      return <span className="session-lead-dot" aria-hidden="true" />;
    default:
      return null;
  }
}

const statusDescription = (status: SessionRowStatus, opening: boolean): string | undefined => {
  if (opening) return tr("common.loading");
  if (status.kind === "working") {
    return tr("sidebar.sessionlist.agentWorkingForValue", { value: fmtSessionElapsed(status.elapsedMs) });
  }
  return status.kind === "regular" || status.kind === "resume-ready" ? undefined : status.label;
};

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

/** Running clock: the one piece of status that is a measurement, so it sits
 *  in the trailing meta column rather than the leading state slot. */
function ElapsedBadge({ status }: { status: SessionRowStatus }) {
  if (status.kind !== "working") return null;
  return <span className="session-elapsed" aria-hidden="true">{fmtSessionElapsed(status.elapsedMs)}</span>;
}

interface SubagentDisclosure {
  /** Listed direct children and what their subtrees are doing. */
  activity: SubagentActivity;
  expanded: boolean;
  onToggle: () => void;
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
  /** Present when this session has delegated children in the list. */
  subagents?: SubagentDisclosure;
}

function SessionRow({
  s, activeSessionId, labels, eventsTitle, opening, selectMode, selected,
  onToggleSelect, onChanged, onOpen, onTogglePin,
  projectName, branch, workspacePath, contextLabel, pinnedWorktreeLabel, shiftQuick, subagents,
}: RowProps) {
  const statusId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [labelQuery, setLabelQuery] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [swipeRevealed, setSwipeRevealed] = useState(false);
  const [swipeX, setSwipeX] = useState<number | null>(null);
  const sessionBtnRef = useRef<HTMLButtonElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
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
  // Split view needs room for two chats; the phone shell never offers it.
  const splitAvailable = useShellMode() !== "phone" && s.id !== activeSessionId;
  // Dragging a row is a mouse gesture; touch keeps its long-press menu.
  const splitDraggable = splitAvailable && !selectMode
    && typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
  const conversation = s.purpose === "conversation";
  const unreadMessages = conversationUnread(s);

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };
  const startLongPress = () => {
    cancelLongPress();
    if (selectMode) return;
    longPressOpenedRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressOpenedRef.current = true;
      menuReturnRef.current = sessionBtnRef.current;
      setMenuOpen(true);
    }, 550);
  };
  const startSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || !event.isPrimary || renaming || selectMode || !canManageSession(s)) return;
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
      await withOptimisticSessionChange(
        s.id,
        { kind: "patch", patch: { labelIds: next } },
        () => api.organizeSession(s.id, { labelIds: next }),
      );
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
  const toggleMute = async () => {
    try {
      await setSessionMuted(s.id, !s.muted);
      onChanged();
    } catch (e) {
      setUiError(friendlyError(tr("common.error"), e));
    }
  };
  const displayTitle = fullSessionTitle(s.title, eventsTitle ?? draftTitleSource(s));
  const draftMark = sessionDraftMark(s, s.id === activeSessionId);
  const draftLabel = tr("sidebar.sessionlist.draft");
  const leadDescription = conversation ? undefined : statusDescription(rowStatus, opening);
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
  // Rename, archive, delete and sharing changes need manage access; a chat
  // shared with less offers only what the reader may do.
  const manage = canManageSession(s);
  // A conversation is shared by nature; its lead mark already says so.
  const sharedLabel = conversation ? undefined : sharingMarkerLabel(s.sharing);
  const menuEntries: MenuEntry[] = [
    ...(manage ? [{ id: "rename", label: tr("common.rename"), onSelect: () => { setTitle(s.title); setRenaming(true); } } satisfies MenuEntry] : []),
    ...(!s.isolation ? [{
      id: "fork",
      label: tr("sidebar.sessionlist.fork"),
      onSelect: () => void forkSession(s.id).catch((e) => setUiError(friendlyError(tr("common.error"), e))),
    } satisfies MenuEntry] : []),
    ...(splitAvailable ? [{
      id: "split",
      label: tr("split.openBeside"),
      onSelect: () => { prefetchSessionTail(s.id); openSessionInSplit(s.id); },
    } satisfies MenuEntry] : []),
    { id: "copy-id", label: tr("sidebar.sessionlist.copySessionId"), onSelect: () => void copySessionId() },
    {
      id: "pin",
      label: s.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop"),
      onSelect: () => onTogglePin(s),
    },
    ...(s.sharing ? [{
      id: "share",
      label: manage ? tr("sharing.share") : tr("sharing.whoHasAccess"),
      onSelect: () => openSessionSharing(s.id),
    } satisfies MenuEntry] : []),
    ...(s.purpose === "conversation" ? [{
      id: "mute",
      label: s.muted ? tr("sidebar.sessionlist.unmuteConversation") : tr("sidebar.sessionlist.muteConversation"),
      onSelect: () => void toggleMute(),
    } satisfies MenuEntry] : []),
    ...(manage ? [
      "separator",
      s.status === "archived"
        ? {
            id: "restore",
            label: tr("common.restore"),
            onSelect: () => void restoreSession(s.id).then(onChanged).catch((e) => setUiError(friendlyError(tr("common.error"), e))),
          }
        : { id: "archive", label: tr("common.archive"), onSelect: () => void quickArchive() },
      { id: "delete", label: tr("common.delete"), danger: true, onSelect: () => void quickDelete() },
    ] satisfies MenuEntry[] : []),
    ...(labels.length > 0 ? [{ heading: tr("sidebar.sessionlist.labels") }] : []),
    ...labelEntries,
  ];
  const openRowMenu = () => {
    menuReturnRef.current = sessionBtnRef.current;
    setMenuOpen(true);
  };

  return (
    <div
      className={`session-row ${rowStatus.kind}${draftMark ? " draft" : ""}${contextLabel ? " search-result" : ""} ${s.id === activeSessionId ? "active" : ""} ${s.status === "archived" ? "archived" : ""}${s.pinned ? " pinned" : ""}${menuOpen ? " menu-open" : ""}${shiftQuick && !renaming ? " shift-quick" : ""}${selectMode ? " selecting" : ""}${subagents ? " has-subagents" : ""}${subagents?.expanded ? " subagents-open" : ""}`}
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
          {...(leadDescription ? { status: { label: leadDescription, tone: opening ? "working" as const : rowStatus.kind } } : {})}
        >
          <button
            ref={sessionBtnRef}
            className="session-btn"
            aria-describedby={leadDescription ? statusId : undefined}
            aria-current={s.id === activeSessionId ? "true" : undefined}
            aria-expanded={swipeRevealed}
            aria-busy={opening || undefined}
            aria-label={selectMode
              ? tr("sidebar.sessionlist.selectValue", { value: s.title || tr("sidebar.sessionlist.session") })
              : tr("sidebar.sessionlist.openValue", { displayTitle: draftMark ? `${displayTitle}, ${draftLabel}` : displayTitle })}
            aria-pressed={selectMode ? selected : undefined}
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
              // While selecting, the whole row is the selection target: a
              // click on the title toggles the row instead of opening it.
              if (selectMode) {
                onToggleSelect(s.id);
                return;
              }
              // Alt-click shows the chat beside the open one instead.
              if (event.altKey && splitAvailable) {
                event.preventDefault();
                prefetchSessionTail(s.id);
                openSessionInSplit(s.id);
                return;
              }
              markSessionPerformance("session_click", s.id);
              onOpen(s.id);
            }}
            onDoubleClick={() => { if (manage && !selectMode) { setTitle(s.title); setRenaming(true); } }}
            // A row dragged onto the workspace opens beside the open chat.
            draggable={splitDraggable ? true : undefined}
            onDragStart={splitDraggable ? (event) => {
              setDragSession(event.dataTransfer, s.id);
              event.dataTransfer.effectAllowed = "link";
              prefetchSessionTail(s.id);
            } : undefined}
            onTouchStart={startLongPress}
            onTouchEnd={cancelLongPress}
            onTouchCancel={cancelLongPress}
            onTouchMove={cancelLongPress}
            onKeyDown={(event) => {
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                openRowMenu();
              } else if (subagents && (event.key === "ArrowRight" || event.key === "ArrowLeft")
                && subagents.expanded !== (event.key === "ArrowRight")) {
                event.preventDefault();
                subagents.onToggle();
              }
            }}
          />
        </SessionHoverCard>
      )}
      {/* The open button above is the row's full-size hit surface; this body
          only paints. Keeping it outside the button lets the subagent
          disclosure sit right after the title as a real, separate control.
          Fixed columns: state mark | title (+ disclosure) | meta. */}
      {!renaming && (
        <span className="session-row-body">
          <span className="session-lead" id={statusId}>
            {leadDescription && <span className="sr-only">{leadDescription}</span>}
            {/* A conversation has no agent state: the slot names its kind. */}
            {conversation
              ? <span className="session-lead-mark people" aria-hidden="true"><UiIcon icon={PeopleIcon} size="sm" /></span>
              : <LeadStatus status={rowStatus} opening={opening} />}
          </span>
          <span className="session-title">
            <span className="session-title-text">{displayTitle}</span>
            {subagents && (
              <button
                type="button"
                className="session-subagent-toggle"
                data-activity={subagentActivityTone(subagents.activity)}
                aria-expanded={subagents.expanded}
                aria-label={`${subagents.expanded ? tr("sidebar.sessionlist.collapse") : tr("sidebar.sessionlist.expand")}: ${subagentActivityLabel(subagents.activity)}`}
                title={subagentActivityLabel(subagents.activity)}
                onClick={subagents.onToggle}
              >
                <Icon.chevronRight />
                <SubagentCount activity={subagents.activity} className="session-subagent-count" />
              </button>
            )}
          </span>
          {contextLabel && <span className="session-search-context">{contextLabel}</span>}
          <span className="session-status-zone">
            {pinnedWorktreeLabel && !conversation && rowStatus.kind === "regular" && (
              <span
                className={`session-worktree-label${pinnedWorktreeLabel.length > 12 ? " session-worktree-label-compact" : ""}`}
                title={pinnedWorktreeLabel}
                aria-label={pinnedWorktreeLabel}
              >
                <Icon.branch />
                {pinnedWorktreeLabel.length <= 12 && <span>{pinnedWorktreeLabel}</span>}
              </span>
            )}
            {!conversation && <ElapsedBadge status={rowStatus} />}
            {draftMark && <span aria-hidden="true" className="session-draft-slot"><Badge tone="accent" className="session-draft-mark">{draftLabel}</Badge></span>}
            <span className="session-identity">
              <SlotHost
                slot="session.list.badges"
                context={{ sessionId: s.id, questions: s.attention?.questions ?? 0, permissions: s.attention?.permissions ?? 0 }}
              />
              {unreadMessages > 0 && (
                <span
                  className="session-unread-count"
                  role="img"
                  title={tr("sidebar.sessionlist.unreadMessages", { count: unreadMessages })}
                  aria-label={tr("sidebar.sessionlist.unreadMessages", { count: unreadMessages })}
                >{unreadBadgeText(unreadMessages)}</span>
              )}
              {hasMentionAttention(s) && (
                <span
                  className="session-mention-badge"
                  role="img"
                  title={tr("sidebar.sessionlist.mentionedYou")}
                  aria-label={tr("sidebar.sessionlist.mentionedYou")}
                ><UiIcon icon={MentionIcon} size="sm" /></span>
              )}
              {sharedLabel && (
                <span className="session-shared-icon" title={sharedLabel} aria-label={sharedLabel} role="img">
                  <UiIcon icon={SharedIcon} size="sm" />
                </span>
              )}
              {s.pinned && (
                <span
                  className="session-pin-icon"
                  title={tr("sidebar.sessionlist.pinnedChats")}
                  aria-label={tr("sidebar.sessionlist.pinnedChats")}
                ><Icon.pin /></span>
              )}
            </span>
          </span>
        </span>
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
          footer={<SlotHost slot="sidebar.session.actions" context={{
            sessionId: s.id,
            status: s.status,
            closeMenu: () => {
              setMenuOpen(false);
              requestAnimationFrame(() => (menuReturnRef.current ?? menuTriggerRef.current)?.focus());
            },
          }} />}
        >
          {(trigger) => (
            <button
              {...trigger}
              ref={(node) => {
                menuTriggerRef.current = node;
                const ref = trigger.ref;
                if (typeof ref === "function") ref(node);
                else if (ref && typeof ref === "object") ref.current = node;
              }}
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
        anchorRef={menuTriggerRef}
        align="end"
        side="down"
        className="session-label-picker"
        restoreFocusRef={menuTriggerRef}
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
      {!renaming && manage && (swipeX !== null || swipeRevealed || shiftQuick) && (
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
  const sessionsRaw = useStore((st) => st.sessions);
  const pendingSends = useStore((st) => st.pendingSends);
  const activeSessionId = useStore((st) => st.activeSessionId);
  // While a package page (an agent) owns the canvas, no chat row is current.
  const pageOpen = useStore((st) => st.activePage !== null);
  const currentSessionId = pageOpen ? null : activeSessionId;
  const sessions = useMemo(
    () => sessionsRaw.map((session) => overlaySessionProjection(session, pendingSends) ?? session),
    // The overlay derives attention from cached events only for the open session.
    [sessionsRaw, pendingSends, activeSessionId],
  );
  const project = useStore((st) => st.projectRegistry.projects.find((candidate) => candidate.id === projectId));
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
  const relativeTime = useStore((st) => st.settings.relativeTime);
  const defaultVisibleSessionCount = useStore((st) => st.settings.defaultVisibleSessionCount);
  const grouping = useSessionGrouping();
  const sessionSort = useSessionSortMode();
  const shellMode = useShellMode();
  const sidebarViewMode = useSidebarViewMode();
  // The project rail now renders in compact drawers too, so pagination follows
  // the persisted presentation regardless of shell width. The account setting
  // supplies the baseline; project-local expansion is restored separately.
  const sessionViewMode = sidebarViewMode;
  const initialVisibleSessions = defaultVisibleSessionCount;
  const [labels, setLabels] = useState<WorkspaceLabel[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [expandedSubagents, setExpandedSubagents] = useState<ReadonlySet<string>>(new Set());
  const summaryQuery = useMemo(() => {
    const from = dateFilter.mode === "date" ? dateFilter.date : dateFilter.mode === "range" ? dateFilter.from : "";
    const to = dateFilter.mode === "date" ? dateFilter.date : dateFilter.mode === "range" ? dateFilter.to : "";
    return { projectId, query: query || undefined, attentionOnly, archived: false,
      ...(from ? { fromTime: new Date(`${from}T00:00:00`).getTime() } : {}),
      ...(to ? { toTime: new Date(`${to}T23:59:59.999`).getTime() } : {}),
    };
  }, [projectId, query, attentionOnly, dateFilter]);
  const pages = useSessionSummaryPages(summaryQuery);
  const [visibleCounts, setVisibleCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [removeTarget, setRemoveTarget] = useState<Worktree | null>(null);
  const [removalSessions, setRemovalSessions] = useState<SessionProjection[] | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removePhase, setRemovePhase] = useState<"confirm" | "dirty">("confirm");
  const [dirtyChanges, setDirtyChanges] = useState(0);
  useEffect(() => {
    setRemovalSessions(null);
    if (!removeTarget) return;
    const controller = new AbortController();
    void collectSessionSummaries(api.listSessionSummaries, { projectId, worktreePath: removeTarget.path }, controller.signal)
      .then((rows) => { if (!controller.signal.aborted) setRemovalSessions(rows.filter((row) => !isIsolatedSession(row))); })
      .catch((error) => { if (!controller.signal.aborted) setUiError(friendlyError(tr("sidebar.sessionlist.couldnTRemoveTheWorktree"), error)); });
    return () => controller.abort();
  }, [projectId, removeTarget]);
  // Shift-key customization mode is a desktop mouse-only affordance: shift+hover
  // reveals Archive/Delete on a row. Landscape-wide tablets still use
  // shellMode "wide", but useShiftArmed refuses any-pointer:coarse devices so
  // a virtual/bluetooth Shift cannot paint every row as if the modifier were
  // held; compact/touch shells keep swipe + menu only.
  const shiftArmed = useShiftArmed();
  const shiftQuick = shiftArmed && shellMode === "wide" && !selectMode;

  useEffect(() => {
    setVisibleCounts(new Map());
  }, [projectId, sessionViewMode, initialVisibleSessions]);
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

  const laneSessions = useLaneSessions(sessions);
  const projectSessions = useMemo(
    () => laneSessions
      .filter((s) => s.projectId === projectId)
      .sort(compareSessionNavigation),
    [laneSessions, projectId],
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
      || resolveSessionStatus(session).kind === "epoch-pending"
      || (session.attention?.questions ?? 0) > 0
      || (session.attention?.permissions ?? 0) > 0;
  };
  const matchingActive = projectSessions.filter((s) => s.status !== "archived" && matchesFilters(s));
  const mainWorktree = worktrees.find((worktree) => worktree.isMain);
  const worktreeKey = (session: SessionProjection): string =>
    !session.worktreePath || session.worktreePath === mainWorktree?.path || isIsolatedSession(session)
      ? SESSION_MAIN_WORKTREE_KEY
      : session.worktreePath;

  const visibleCountFor = (key: string): number => visibleCounts.get(key)
    ?? getVisibleSessionCount(projectId, sessionViewMode, initialVisibleSessions, key);
  const updateVisibleCount = (key: string, next: number): void => {
    setVisibleCounts((previous) => {
      const updated = new Map(previous);
      updated.set(key, next);
      return updated;
    });
    setVisibleSessionCount(projectId, sessionViewMode, next, key);
  };

  // Pinned chats belong to one project-level section, rather than their
  // individual worktree buckets. This keeps them at the top even when their
  // worktree is collapsed or appears later in the list.
  const pinned = sortPinnedSessions(matchingActive);
  const unpinnedActive = matchingActive.filter((session) => session.pinned === undefined);
  const orderedActive = [...pinned, ...unpinnedActive];

  // Delegated children (subagents, workflow units) ride inside their listed
  // parent's disclosure and never take a row, or a page slot, of their own.
  // A pinned child keeps its pinned row instead.
  const unpinnedChildren = useMemo(
    () => unpinnedActive.filter((session) => !!session.parentId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unpinnedActive.map((session) => `${session.id}>${session.parentId ?? ""}`).join(",")],
  );
  const parentPending = useSessionParentPending(unpinnedChildren);
  const listedIds = new Set(matchingActive.map((session) => session.id));
  const nestedChildren = new Map([...childrenByParent(matchingActive)]
    .map(([parentId, children]) => [parentId, children.filter((child) => child.pinned === undefined)] as const)
    .filter(([, children]) => children.length > 0));
  const unpinnedRoots = unpinnedActive.filter((session) => isNavigatorRoot(session, listedIds, parentPending));
  const listedById = new Map(matchingActive.map((session) => [session.id, session]));
  // The open chat may be a nested child: its ancestors open around it and its
  // top ancestor holds a visible slot.
  const activeAncestors = listedAncestors(activeSessionId, listedById);
  const activeRootId = activeAncestors.at(-1) ?? activeSessionId;
  const activeAncestorsKey = activeAncestors.join(",");
  useEffect(() => {
    if (!activeAncestorsKey) return;
    setExpandedSubagents((previous) => {
      const missing = activeAncestorsKey.split(",").filter((id) => !previous.has(id));
      return missing.length ? new Set([...previous, ...missing]) : previous;
    });
  }, [activeSessionId, activeAncestorsKey]);

  const allByWorktree = new Map<string, SessionProjection[]>();
  for (const session of unpinnedRoots) {
    const key = worktreeKey(session);
    allByWorktree.set(key, [...(allByWorktree.get(key) ?? []), session]);
  }
  // Grouped then sorted before paging, so the first page holds the leading groups.
  for (const [key, grouped] of allByWorktree) allByWorktree.set(key, arrangeSessions(grouped, grouping, sessionSort));

  const selectedActive = unpinnedRoots.find((session) => session.id === activeRootId);
  const visibleByWorktree = new Map<string, SessionProjection[]>();
  for (const [key, sessionsForWorktree] of allByWorktree) {
    const limit = searchMode ? sessionsForWorktree.length : visibleCountFor(key);
    let visible = sessionsForWorktree.slice(0, limit);
    if (
      !searchMode
      && selectedActive
      && worktreeKey(selectedActive) === key
      && !visible.some((session) => session.id === selectedActive.id)
    ) {
      visible = visible.length > 0
        ? [...visible.slice(0, -1), selectedActive]
        : [selectedActive];
    }
    visibleByWorktree.set(key, arrangeSessions(visible, grouping, sessionSort));
  }
  // A remembered expansion can exceed the first summary page after a reload;
  // keep paging until the primary checkout can fill the count the user chose.
  const mainLoadedCount = allByWorktree.get(SESSION_MAIN_WORKTREE_KEY)?.length ?? 0;
  const mainWantedCount = searchMode ? 0 : visibleCountFor(SESSION_MAIN_WORKTREE_KEY);
  const autoPageFailedRef = useRef(false);
  useEffect(() => { autoPageFailedRef.current = false; }, [summaryQuery]);
  useEffect(() => {
    if (autoPageFailedRef.current || !pages.hasMore || pages.busy || mainWantedCount <= mainLoadedCount) return;
    void pages.more().then((ok) => { if (!ok) autoPageFailedRef.current = true; });
  }, [pages.hasMore, pages.busy, mainWantedCount, mainLoadedCount]);
  const archived = projectSessions.filter((s) => s.status === "archived" && matchesFilters(s));
  const hasArchived = useHasArchivedSessions(projectId, !searchMode);
  const sessionsForRemoval = removalSessions ?? [];

  // A project's checkout is its root, not another branch in the navigation.
  // Only linked worktrees get their own expandable subtrees.
  const mainSessions = visibleByWorktree.get(SESSION_MAIN_WORKTREE_KEY) ?? [];
  const allMainSessions = allByWorktree.get(SESSION_MAIN_WORKTREE_KEY) ?? [];
  const knownWorktreePaths = new Set(worktrees.filter((worktree) => !worktree.isMain).map((worktree) => worktree.path));
  const worktreeGroups = [
    ...worktrees.filter((worktree) => !worktree.isMain).map((worktree) => ({
      key: worktree.path,
      label: worktree.branch || worktreeLabel(null, worktree.path),
      sessions: visibleByWorktree.get(worktree.path) ?? [],
      allSessions: allByWorktree.get(worktree.path) ?? [],
      worktree,
    })),
    ...[...allByWorktree.entries()]
      .filter(([path]) => path !== SESSION_MAIN_WORKTREE_KEY && !knownWorktreePaths.has(path))
      .map(([path, allSessions]) => ({
        key: path,
        label: worktreeLabel(allSessions[0]?.branch ?? null, path),
        sessions: visibleByWorktree.get(path) ?? [],
        allSessions,
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

  const groupLabelContext = { relativeTime, locale: getLocale(), now: Date.now() };
  const groupHeading = (label: string | null) => label && (
    <div className="session-date-divider" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );

  const row = (
    s: SessionProjection,
    contextLabel?: string,
    pinnedWorktreeLabel?: string,
    subagents?: SubagentDisclosure,
  ) => {
    const checkout = s.worktreePath
      ? worktrees.find((worktree) => worktree.path === s.worktreePath)
      : mainWorktree;
    return (
      <SessionRow
        key={s.id}
        s={s}
        activeSessionId={currentSessionId}
        labels={labels}
        eventsTitle={eventsTitles.get(s.id)}
        opening={openingSessionId === s.id}
        selectMode={selectMode}
        selected={selectedSessionIds.has(s.id)}
        onToggleSelect={onToggleSelected}
        onChanged={onChanged}
        // The compact drawer closes only after activation resolves;
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
        subagents={subagents}
      />
    );
  };

  const worktreeNameForSession = (session: SessionProjection): string => {
    const key = worktreeKey(session);
    // A branch name is never translated; "Main" names the checkout only when
    // its branch is unknown. An isolated chat's own branch is internal.
    if (key === SESSION_MAIN_WORKTREE_KEY) {
      return (!isIsolatedSession(session) && session.branch)
        || mainWorktree?.branch
        || tr("sidebar.sessionlist.mainWorktree");
    }
    if (session.branch) return session.branch;
    return worktrees.find((worktree) => worktree.path === key)?.branch || worktreeLabel(null, key);
  };
  const startInWorktree = (key: string) => {
    startFreshSession(projectId, key === "__main__" ? {} : { worktreePath: key });
    if (getState().sidebarOpen) setSidebarOpen(false);
  };
  const subagentsExpanded = (id: string): boolean => expandedSubagents.has(id);
  const renderNode = (
    item: SessionProjection,
    contextLabel?: string,
    pinnedWorktreeLabel?: string,
    seen: ReadonlySet<string> = new Set(),
  ): ReactNode => {
    const children = (nestedChildren.get(item.id) ?? []).filter((child) => !seen.has(child.id));
    const expanded = subagentsExpanded(item.id);
    const subagents = children.length > 0 ? {
      // Folded or open, the pill says whether anything below is working or
      // waiting for a person; a grandchild counts for its listed child.
      activity: subagentActivity(children, {
        idOf: (session) => session.id,
        childrenOf: (session) => nestedChildren.get(session.id) ?? [],
        stateOf: sessionActivityState,
      }),
      expanded,
      onToggle: () => setExpandedSubagents((previous) => {
        const next = new Set(previous);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      }),
    } : undefined;
    const path = new Set([...seen, item.id]);
    return (
      <div className="session-subagent-parent" key={item.id}>
        {row(item, contextLabel, pinnedWorktreeLabel, subagents)}
        {expanded && children.length > 0 && (
          <div className="session-subagent-children">
            {children.map((child) => renderNode(child, undefined, undefined, path))}
          </div>
        )}
      </div>
    );
  };
  const sessionTree = (roots: readonly SessionProjection[]) => {
    return sessionGroupsOf(roots, grouping, groupLabelContext).map((group) => (
      <div className="session-date-group" key={group.key}>
        {groupHeading(group.label)}
        {group.sessions.map((session) => renderNode(session))}
      </div>
    ));
  };
  const datedRows = (
    items: readonly SessionProjection[],
    render: (session: SessionProjection) => ReturnType<typeof row> = (session) => row(session),
  ) => sessionGroupsOf(arrangeSessions(items, grouping, sessionSort), grouping, groupLabelContext).map((group) => (
    <div className="session-date-group" key={group.key}>
      {groupHeading(group.label)}
      {group.sessions.map(render)}
    </div>
  ));
  const sessionPagination = (
    key: string,
    allSessions: readonly SessionProjection[],
    visibleSessions: readonly SessionProjection[],
  ) => {
    const hasRemotePage = key === SESSION_MAIN_WORKTREE_KEY && pages.hasMore;
    if (searchMode || (allSessions.length === 0 && !hasRemotePage)) return null;
    const visibleIds = new Set(visibleSessions.map((session) => session.id));
    const hasHiddenSessions = allSessions.some((session) => !visibleIds.has(session.id));
    const visibleCount = visibleCountFor(key);
    if (!hasHiddenSessions && !hasRemotePage && visibleCount <= initialVisibleSessions) return null;
    return (
      <div className="session-pagination" data-worktree={key}>
        {(hasHiddenSessions || hasRemotePage) && (
          <button
            type="button"
            className="show-more-sessions"
            disabled={pages.busy && hasRemotePage}
            onClick={() => {
              const nextCount = visibleCount + initialVisibleSessions;
              updateVisibleCount(key, hasRemotePage ? nextCount : Math.min(nextCount, allSessions.length));
              if (hasRemotePage && nextCount >= allSessions.length) void pages.more();
            }}
          >
            {tr("sidebar.sessionlist.showMoreSessions")}
          </button>
        )}
        {visibleCount > initialVisibleSessions && (
          <button
            type="button"
            className="show-less-sessions"
            onClick={() => updateVisibleCount(
              key,
              Math.max(initialVisibleSessions, visibleCount - initialVisibleSessions),
            )}
          >
            {tr("sidebar.sessionlist.showLessSessions")}
          </button>
        )}
      </div>
    );
  };

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
        {pages.hasMore && <button className="show-more-sessions" disabled={pages.busy} onClick={() => void pages.more()}>{tr("sidebar.sessionlist.showMoreSessions")}</button>}
      </div>
    );
  }

  return (
    <div className="session-org">
      <SlotHost
        slot="sidebar.project.leading"
        context={{
          projectId,
          activeSessionId: currentSessionId,
          query: needle,
          attentionOnly,
          // As a chat row does, an opened row closes the compact drawer.
          onNavigate: () => { if (getState().sidebarOpen) setSidebarOpen(false); },
        }}
      />
      {pinned.length > 0 && (
        <div className="session-pinned" aria-label={tr("sidebar.sessionlist.pinnedChats")}>
          <div className="session-date-divider session-pinned-divider" role="separator">
            <span><Icon.pin />{tr("sidebar.sessionlist.pinnedChats")}</span>
          </div>
          {pinned.map((session) => renderNode(
            session,
            undefined,
            isIsolatedSession(session) ? undefined : worktreeNameForSession(session),
          ))}
        </div>
      )}
      {(mainSessions.length > 0 || pages.hasMore) && (
        <div className="session-project-sessions session-worktree-sessions">
          {sessionTree(mainSessions)}
          {sessionPagination(SESSION_MAIN_WORKTREE_KEY, allMainSessions, mainSessions)}
        </div>
      )}
      {worktreeGroups.map((group) => {
        const isCollapsed = collapsed.get(group.key) ?? group.sessions.length === 0;
        const managedIsolation = isManagedIsolationBranch(group.worktree?.branch)
          || group.sessions.some(isIsolatedSession);
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
                {sessionPagination(group.key, group.allSessions, group.sessions)}
              </div>
            )}
          </div>
        );
      })}

      {matchingActive.length === 0 && (
        <div className="empty session-list-empty">
          {/* A first chat is not a filter miss. */}
          {projectSessions.some((session) => session.status !== "archived")
            ? tr("sidebar.sessionlist.noMatchingSessions")
            : tr("sidebar.sessionlist.noChatsYet")}
        </div>
      )}

      {hasArchived && (
        <button
          type="button"
          className="session-archive-entry"
          aria-haspopup="dialog"
          aria-label={tr("archivedsessions.openForValue", { value: project?.name || project?.path || "" })}
          onClick={() => {
            openArchivedSessions(projectId);
            if (getState().sidebarOpen) setSidebarOpen(false);
          }}
        >
          <UiIcon icon={ArchiveIcon} size="sm" />
          <span>{tr("archivedsessions.entry")}</span>
          <UiIcon icon={ChevronRightIcon} size="sm" className="session-archive-entry-chevron" />
        </button>
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
                disabled={removalSessions === null}
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
                      let cleanupFailed = false;
                      for (const id of sessionIds) {
                        try { await deleteSession(id); } catch { cleanupFailed = true; }
                      }
                      if (result.metadataCleanupFailed || result.branchCleanupFailed || cleanupFailed) {
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
              label={removalSessions === null ? tr("common.loading") : sessionsForRemoval.length === 1
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
