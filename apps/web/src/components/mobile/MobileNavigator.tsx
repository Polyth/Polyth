import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { switchWorkbenchNavigation, useLaneSessions, useWorkbenchNavigation } from "../../workbench/profileNavigation.ts";
import { projectIsolationLevel, type SessionProjection } from "@polyth/contracts";
import { flushSync } from "react-dom";
import {
  getState,
  openArchivedSessions,
  openSessionSharing,
  openWorktreeSessionDialog,
  setOverlay,
  setSidebarOpen,
  setUiError,
  startFreshSession,
  useStore,
} from "../../store.ts";
import {
  deleteSession,
  openSession,
  refreshSessions,
  removeProject,
  renameProject,
} from "../../init.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../../sessionStatus.ts";
import { draftTitleSource, sessionDraftMark } from "../../sessionDraft.ts";
import { fullSessionTitle } from "../../format.ts";
import { projectSessionStatusCounts } from "../../mobileIsland.ts";
import { Icon } from "../../icons.tsx";
import { isImeComposing } from "../input/editorCore.ts";
import ProjectGlyph from "../ProjectGlyph.tsx";
import { soloPersonalProject } from "../../personalProject.ts";
import ProjectAppearanceDialog from "../ProjectAppearanceDialog.tsx";
import ConversationCreateDialog from "../ConversationCreateDialog.tsx";
import { getLocale, tr } from "../../i18n/index.ts";
import { friendlyError } from "../../settings.ts";
import { useSessionSummaryPages } from "../../useSessionSummaryPages.ts";
import { useHasArchivedSessions } from "../../useHasArchivedSessions.ts";
import { confirmAlert } from "../../alerts.ts";
import {
  archiveSessionWithPolicy,
  renameSessionTitle,
  toggleSessionPin,
} from "../../sessionActions.ts";
import { successFeedback, tapFeedback } from "../../haptics.ts";
import { copyText } from "../../utils.ts";
import { canManageSession, sharingMarkerLabel } from "../../sessionSharing.ts";
import { conversationUnread, hasMentionAttention, setSessionMuted, unreadBadgeText } from "../../sessionPeople.ts";
import { motionDurationMs, scheduleSurfaceExit } from "../../motionPresence.ts";
import { swipeZoneInHost, useSwipePeek } from "../../shellSwipe.ts";
import { attachSwipeSurface, holdHandoff, parkLeavingLayer } from "../../swipeSurface.ts";
import { useUiSettings } from "../../uiPrefs.ts";
import { presentSettingsFrom } from "../../settingsPresentation.ts";
import { announce } from "../a11y/live.tsx";
import { useModalSurface } from "../a11y/Dialog.tsx";
import UiIcon from "../ui/Icon.tsx";
import Badge from "../ui/Badge.tsx";
import SlotHost from "../slots/SlotHost.ts";
import {
  AddProjectIcon,
  ArchiveIcon,
  CheckIcon,
  MentionIcon,
  NewChatIcon,
  PeopleIcon,
  PinIcon,
  SelectIcon,
  SharedIcon,
} from "../ui/icons.ts";
import { activeSpace, getSpacesState, loadSpaces, switchSpace, useSpaces } from "../../spaces.ts";
import { canSwitchMobileServer, switchMobileServer } from "../../nativeConnections.ts";
import { MobileStatusIcon, type MobileStatusKind } from "./MobileStatusIcon.tsx";
import { Menu, type MenuEntry } from "../ui/index.ts";
import SessionDateFilterControls from "../sidebar/SessionDateFilterControls.tsx";
import SessionSelectionBar from "../sidebar/SessionSelectionBar.tsx";
import { useSessionArrangementEntries } from "../sidebar/sessionArrangementEntries.ts";
import { useEscape } from "../../useEscape.ts";
import {
  compareSessionNavigation,
  EMPTY_SESSION_DATE_FILTER,
  sessionDateFilterActive,
  sessionMatchesDateFilter,
  type SessionDateFilter,
} from "../../sessionDates.ts";
import {
  buildSessionTree,
  includeSessionTreeContext,
  isNavigatorRoot,
  type SessionTreeNode,
} from "../../sessionTree.ts";
import { useSessionParentPending } from "../../sessionParents.ts";
import { sessionActivityState, subagentActivity, subagentActivityTone, type SubagentActivity } from "../../subagentActivity.ts";
import { SubagentCount, subagentActivityLabel } from "../sidebar/SubagentCount.tsx";
import {
  applyManualProjectOrder,
  arrangeSessions,
  permuteManualProjects,
  sessionGroupsOf,
  setProjectOrder,
  setProjectSortMode,
  useProjectOrder,
  useProjectSortMode,
  useSessionGrouping,
  useSessionSortMode,
  type ProjectSortMode,
} from "../../sidebarPrefs.ts";
import { guardedProjectAddAllowed, limitedProjectAddAllowed, useAccountLimits, useGuardrails } from "../../guardrails.ts";
import {
  EXPANDED_PROJECTS_KEY,
  readNavigatorState,
  SHOW_ALL_PROJECTS_KEY,
  writeNavigatorState,
} from "../../navigatorState.ts";
import { ARRANGE_LIST_LIFT_MS, useArrange, type ArrangeItem } from "../../workspaceArrange.ts";
import "./MobileNavigator.css";

const LONG_PRESS_MS = 550;
const SWIPE_WIDTH = 82;
const SWIPE_THRESHOLD = 38;

/** How long after the navigator comes up the current chat's project is kept
 *  in place while session lists are still arriving. */
const REVEAL_WINDOW_MS = 1500;

/** Scrolls the list so the project — and the current chat's row, when it is
 *  listed — is in view. Already in view, nothing moves; otherwise the
 *  project's row leads the list, pulled up further only when the chat would
 *  still sit below the fold. Instant: the drawer is arriving, not scrolling. */
function revealProjectInList(scroller: HTMLElement, section: HTMLElement, row: HTMLElement | null): void {
  const style = getComputedStyle(scroller);
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const padBottom = Number.parseFloat(style.paddingBottom) || 0;
  const box = scroller.getBoundingClientRect();
  const offset = (rect: DOMRect) => ({
    top: rect.top - box.top + scroller.scrollTop,
    bottom: rect.bottom - box.top + scroller.scrollTop,
  });
  const head = offset((section.firstElementChild ?? section).getBoundingClientRect());
  const target = row ? offset(row.getBoundingClientRect()) : head;
  const viewTop = scroller.scrollTop + padTop;
  const viewBottom = scroller.scrollTop + scroller.clientHeight - padBottom;
  if (head.top >= viewTop && target.bottom <= viewBottom) return;
  let next = head.top - padTop;
  if (target.bottom - next > scroller.clientHeight - padBottom) next = target.bottom - scroller.clientHeight + padBottom;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.min(max, Math.max(0, next));
}

function loadExpanded(activeProjectId: string | null): ReadonlySet<string> {
  try {
    const raw = JSON.parse(readNavigatorState(EXPANDED_PROJECTS_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) {
      const ids = raw.filter((value): value is string => typeof value === "string");
      if (ids.length > 0) return new Set(ids);
    }
  } catch {
    // Best-effort UI persistence only.
  }
  return new Set(activeProjectId ? [activeProjectId] : []);
}

/** Projects whose session list the user opened up with "Show more". */
function loadShowAll(): ReadonlySet<string> {
  try {
    const raw = JSON.parse(readNavigatorState(SHOW_ALL_PROJECTS_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) return new Set(raw.filter((value): value is string => typeof value === "string"));
  } catch {
    // Best-effort UI persistence only.
  }
  return new Set();
}

function statusPriority(session: SessionProjection): number {
  const status = resolveSessionStatus(session);
  if (status.kind === "working") return 0;
  if (
    status.kind === "needs-approval"
    || status.kind === "needs-reply"
    || status.kind === "failed"
    || status.kind === "epoch-pending"
    || status.kind === "reconciling"
    || status.kind === "unknown"
  ) return 1;
  if ((session.attention?.unread ?? 0) > 0) return 2;
  return 3;
}

function workingDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function statusIcon(kind: MobileStatusKind) {
  return <MobileStatusIcon kind={kind} />;
}

/** Leading state mark. Every row reserves its slot so titles align down the
 *  list whatever the state; an idle row leaves it empty. Decorative: the
 *  open button's accessible name already carries the status label. */
function leadStatus(status: SessionRowStatus, conversation = false) {
  if (conversation) {
    return <span className="mobile-nav-session-state is-conversation"><UiIcon icon={PeopleIcon} size="sm" /></span>;
  }
  switch (status.kind) {
    case "working":
      return <span className="mobile-nav-running-ring" />;
    case "needs-reply":
    case "epoch-pending":
    case "reconciling":
    case "unknown":
      return <span className="mobile-nav-session-state is-attention">{statusIcon(status.kind)}</span>;
    case "needs-approval":
      return <span className="mobile-nav-session-state is-attention is-approval">{statusIcon(status.kind)}</span>;
    case "failed":
      return <span className="mobile-nav-session-state is-failed">{statusIcon(status.kind)}</span>;
    case "rate-limited":
      return <span className="mobile-nav-session-state is-limited">{statusIcon(status.kind)}</span>;
    case "unread":
      return <span className="mobile-nav-unread-dot" />;
    default:
      return null;
  }
}

/** Multi-select state for the rows; rows are rendered recursively, so the
 *  navigator shares it instead of threading it through every tree level. */
const RowSelection = createContext<{
  active: boolean;
  ids: ReadonlySet<string>;
  toggle: (id: string) => void;
}>({ active: false, ids: new Set(), toggle: () => {} });

function SessionRow({
  session,
  active,
  now,
  pinnedSessions,
  onChanged,
  treeDepth = 0,
  childActivity,
  childrenExpanded = false,
  onToggleChildren,
}: {
  session: SessionProjection;
  active: boolean;
  now: number;
  pinnedSessions: SessionProjection[];
  onChanged: () => void;
  treeDepth?: number;
  /** Listed direct children and what their subtrees are doing. */
  childActivity?: SubagentActivity;
  childrenExpanded?: boolean;
  onToggleChildren?: () => void;
}) {
  const childCount = childActivity?.total ?? 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [swipeX, setSwipeX] = useState(0);
  // A finger is moving the row: it tracks 1:1 until the finger lets go.
  const [rowDragging, setRowDragging] = useState(false);
  const swipeSettledRef = useRef(0);
  const swipedOpenAtStart = useRef(false);
  const swipedDuringTouch = useRef(false);
  const longPressOpenedRef = useRef(false);
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const unread = (session.attention?.unread ?? 0) > 0;
  const rowStatus = resolveSessionStatus(session, now);
  const conversation = session.purpose === "conversation";
  const unreadMessages = conversationUnread(session);
  const draftLine = draftTitleSource(session);
  const displayTitle = draftLine
    ? fullSessionTitle(session.title, draftLine)
    : session.title || tr("sidebar.sessionlist.newSession");
  const draftMark = sessionDraftMark(session, active);
  const draftLabel = tr("sidebar.sessionlist.draft");
  const opening = useStore((state) => state.openingSessionId === session.id);
  const selection = useContext(RowSelection);
  const selecting = selection.active;
  const selected = selecting && selection.ids.has(session.id);

  useEffect(() => setTitle(session.title), [session.title]);
  useEffect(() => () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  }, []);

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  // The drawer closes at once; its close animation covers the session surface's
  // placeholder delay, after which a slow open shows the loading layer.
  const openCurrent = () => {
    setSidebarOpen(false);
    void openSession(session.id).catch((error) => {
      setUiError(friendlyError(tr("common.error"), error));
    });
  };

  const commitRename = async () => {
    setRenaming(false);
    try {
      const renamed = await renameSessionTitle(session.id, session.title, title);
      if (renamed) onChanged();
      else setTitle(session.title);
    } catch (error) {
      setTitle(session.title);
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const archive = async () => {
    try {
      swipeSettledRef.current = 0;
      setSwipeX(0);
      if (await archiveSessionWithPolicy(session)) onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const remove = async () => {
    const label = session.title || tr("sidebar.sessionlist.session");
    const activity = session.isolation
      ? ` ${tr("sidebar.sessionlist.theLocalIsolationWorkspaceAndEveryFileInItWillAlsoBePermanentlyDeleted")}`
      : "";
    if (!await confirmAlert(
      tr("sidebar.sessionlist.deleteValueValueThisPermanentlyRemovesThe", { label, activity }),
      { title: tr("sidebar.sessionlist.deleteSession"), confirmLabel: tr("common.delete") },
    )) return;
    try {
      await deleteSession(session.id);
      onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const togglePin = async () => {
    // The row moves optimistically; close the swipe tray with it.
    swipeSettledRef.current = 0;
    setSwipeX(0);
    try {
      await toggleSessionPin(session, pinnedSessions);
      successFeedback();
      onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const copySessionId = async () => {
    if (await copyText(session.id)) {
      successFeedback();
      announce(tr("sidebar.sessionlist.sessionIdCopied"));
    } else {
      setUiError(tr("questioncards.copyFailedClipboardUnavailable"));
    }
  };

  const toggleMute = async () => {
    try {
      await setSessionMuted(session.id, !session.muted);
      onChanged();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  // Rename, archive and delete need manage access to a shared chat.
  const manage = canManageSession(session);
  const sharedLabel = conversation ? undefined : sharingMarkerLabel(session.sharing);
  const entries: MenuEntry[] = [
    ...(manage ? [{
      id: "rename",
      label: tr("common.rename"),
      onSelect: () => {
        setTitle(session.title);
        setRenaming(true);
      },
    } satisfies MenuEntry] : []),
    {
      id: "copy-id",
      label: tr("sidebar.sessionlist.copySessionId"),
      onSelect: () => void copySessionId(),
    },
    {
      id: "pin",
      label: session.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop"),
      onSelect: () => void togglePin(),
    },
    ...(session.sharing ? [{
      id: "share",
      label: manage ? tr("sharing.share") : tr("sharing.whoHasAccess"),
      onSelect: () => openSessionSharing(session.id),
    } satisfies MenuEntry] : []),
    ...(session.purpose === "conversation" ? [{
      id: "mute",
      label: session.muted ? tr("sidebar.sessionlist.unmuteConversation") : tr("sidebar.sessionlist.muteConversation"),
      onSelect: () => void toggleMute(),
    } satisfies MenuEntry] : []),
    ...(manage ? [
      "separator",
      {
        id: "archive",
        label: tr("common.archive"),
        onSelect: () => void archive(),
      },
      {
        id: "delete",
        label: tr("common.delete"),
        danger: true,
        onSelect: () => void remove(),
      },
    ] satisfies MenuEntry[] : []),
  ];

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== "touch"
      || renaming
      || selecting
      || (event.target instanceof Element && event.target.closest(".mobile-nav-subagent-toggle"))
    ) return;
    pointerStart.current = { x: event.clientX, y: event.clientY };
    swipedOpenAtStart.current = swipeSettledRef.current !== 0;
    swipedDuringTouch.current = false;
    longPressOpenedRef.current = false;
    clearPress();
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      longPressOpenedRef.current = true;
      tapFeedback();
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    if (!start || event.pointerType !== "touch") return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    clearPress();
    if (Math.abs(dx) <= Math.abs(dy)) return;
    // Measured toward the inline end: the row only reveals Pin that way. A
    // swipe toward the inline start belongs to the Navigator, which closes.
    const inline = document.documentElement.dir === "rtl" ? -dx : dx;
    const base = swipedOpenAtStart.current ? swipeSettledRef.current : 0;
    if (base === 0 && inline <= 0) return;
    if (Math.abs(dx) >= SWIPE_THRESHOLD) {
      swipedDuringTouch.current = true;
    }
    setRowDragging(true);
    setSwipeX(Math.max(0, Math.min(SWIPE_WIDTH, base + inline)));
  };

  const onPointerEnd = () => {
    clearPress();
    pointerStart.current = null;
    setRowDragging(false);
    setSwipeX((current) => {
      const next = current > SWIPE_THRESHOLD ? SWIPE_WIDTH : 0;
      swipeSettledRef.current = next;
      return next;
    });
  };

  return (
    <div
      className={`mobile-nav-session-swipe${swipeX !== 0 ? " is-swiped" : ""}${rowDragging ? " is-dragging" : ""}`}
      // At rest the row owns only its Pin swipe (toward the inline end); a
      // swipe the other way closes the Navigator. Once Pin is showing, the
      // drag back is the row's too. Archive lives in the row menu.
      data-owns-swipe={swipeX === 0 ? "toward-end" : ""}
      style={{ "--mobile-nav-tree-depth": treeDepth } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={() => {
        clearPress();
        pointerStart.current = null;
        setRowDragging(false);
        swipedOpenAtStart.current = false;
        swipedDuringTouch.current = false;
        swipeSettledRef.current = 0;
        setSwipeX(0);
      }}
    >
      <div className="mobile-nav-session-underlay" aria-hidden={swipeX === 0 || undefined}>
        <button
          className="mobile-nav-swipe-action is-leading"
          tabIndex={swipeX !== 0 ? 0 : -1}
          onClick={() => void togglePin()}
        >
          {session.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop")}
        </button>
      </div>
      <div
        className={`mobile-nav-session-row${active ? " is-active" : ""}${draftMark ? " is-draft" : ""}${selecting ? " is-selecting" : ""}${selected ? " is-selected" : ""}${session.pinned ? " is-pinned" : ""}${unread ? " is-unread" : ""}${rowStatus.kind === "failed" ? " is-failed" : ""}${childCount > 0 ? " has-subagents" : ""}`}
        style={{ transform: `translateX(${document.documentElement.dir === "rtl" ? -swipeX : swipeX}px)` }}
      >
        {renaming ? (
          <input
            className="mobile-nav-inline-rename"
            ref={(node) => { if (node) menuReturnRef.current = node; }}
            autoFocus
            value={title}
            aria-label={tr("common.rename")}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              if (event.key === "Enter") void commitRename();
              if (event.key === "Escape") { setTitle(session.title); setRenaming(false); }
            }}
          />
        ) : (
          <>
            {/* The open button is the row's full-size tap surface; the body
                after it only paints, so the subagent disclosure can sit right
                after the title as a separate control. Fixed columns:
                state mark | title (+ disclosure) | meta. */}
            <button
              ref={(node) => {
                rowButtonRef.current = node;
                if (node) menuReturnRef.current = node;
              }}
              className="mobile-nav-session-main"
              aria-label={`${displayTitle}, ${draftMark ? `${draftLabel}, ` : ""}${rowStatus.label}`}
              aria-current={active ? "page" : undefined}
              aria-busy={opening || undefined}
              aria-pressed={selecting ? selected : undefined}
              onClick={() => {
                if (selecting) {
                  selection.toggle(session.id);
                  return;
                }
                if (longPressOpenedRef.current) {
                  longPressOpenedRef.current = false;
                  return;
                }
                if (swipedOpenAtStart.current || swipedDuringTouch.current || swipeSettledRef.current !== 0) {
                  swipedOpenAtStart.current = false;
                  swipedDuringTouch.current = false;
                  swipeSettledRef.current = 0;
                  setSwipeX(0);
                  return;
                }
                openCurrent();
              }}
            />
            <span className="mobile-nav-session-body">
              <span className="mobile-nav-session-lead" aria-hidden="true">
                {selecting
                  ? <span className={`mobile-nav-select-mark${selected ? " is-selected" : ""}`}>{selected && <UiIcon icon={CheckIcon} size="sm" />}</span>
                  : opening ? <span className="ui-spinner ui-spinner--sm" /> : leadStatus(rowStatus, conversation)}
              </span>
              <span className="mobile-nav-session-heading">
                {/* dir="auto": a title in the other script direction truncates
                    at its own end, so it keeps its first words. */}
                <span className="mobile-nav-session-title" dir="auto">{displayTitle}</span>
                {childActivity && childCount > 0 && (
                  <button
                    type="button"
                    className="mobile-nav-subagent-toggle"
                    data-activity={subagentActivityTone(childActivity)}
                    aria-expanded={childrenExpanded}
                    aria-label={`${childrenExpanded ? tr("sidebar.sessionlist.collapse") : tr("sidebar.sessionlist.expand")}: ${subagentActivityLabel(childActivity)}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleChildren?.();
                    }}
                  >
                    <Icon.chevronRight />
                    <SubagentCount activity={childActivity} className="mobile-nav-subagent-count" />
                  </button>
                )}
              </span>
              {/* Meta: running clock, then identity (package badges, pin)
                  always last so those icons line up at the trailing edge. */}
              <span className="mobile-nav-session-trailing">
                {!conversation && rowStatus.kind === "working" && (
                  <span className="mobile-nav-duration" aria-hidden="true">{workingDuration(rowStatus.elapsedMs)}</span>
                )}
                {draftMark && <span aria-hidden="true" className="session-draft-slot"><Badge tone="accent" className="session-draft-mark">{draftLabel}</Badge></span>}
                <span className="mobile-nav-session-flags">
                  <SlotHost
                    slot="session.list.badges"
                    context={{ sessionId: session.id, questions: session.attention?.questions ?? 0, permissions: session.attention?.permissions ?? 0 }}
                  />
                  {unreadMessages > 0 && (
                    <span
                      className="session-unread-count"
                      role="img"
                      aria-label={tr("sidebar.sessionlist.unreadMessages", { count: unreadMessages })}
                      title={tr("sidebar.sessionlist.unreadMessages", { count: unreadMessages })}
                    >{unreadBadgeText(unreadMessages)}</span>
                  )}
                  {hasMentionAttention(session) && (
                    <span
                      className="mobile-nav-mention-badge"
                      role="img"
                      aria-label={tr("sidebar.sessionlist.mentionedYou")}
                      title={tr("sidebar.sessionlist.mentionedYou")}
                    ><UiIcon icon={MentionIcon} size="sm" /></span>
                  )}
                  {sharedLabel && (
                    <span className="mobile-nav-shared-icon" role="img" aria-label={sharedLabel} title={sharedLabel}>
                      <UiIcon icon={SharedIcon} size="sm" />
                    </span>
                  )}
                  {session.pinned && (
                    <span
                      className="mobile-nav-pin-icon"
                      aria-label={tr("sidebar.sessionlist.pinnedChats")}
                      title={tr("sidebar.sessionlist.pinnedChats")}
                    ><UiIcon icon={PinIcon} size="sm" /></span>
                  )}
                </span>
              </span>
            </span>
          </>
        )}
        <Menu
          label={tr("sidebar.sessionlist.actionsForValue", { value: session.title || tr("sidebar.sessionlist.session") })}
          entries={entries}
          align="end"
          phonePresentation="popover"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          returnFocusRef={menuReturnRef}
          footer={<SlotHost slot="sidebar.session.actions" context={{
            sessionId: session.id,
            status: session.status,
            closeMenu: () => {
              setMenuOpen(false);
              requestAnimationFrame(() => rowButtonRef.current?.focus());
            },
          }} />}
        >
          {(trigger) => (
            <button className="mobile-nav-more" aria-label={tr("common.more")} {...trigger}>
              <Icon.more />
            </button>
          )}
        </Menu>
      </div>
    </div>
  );
}

/** Doorway to a project's archive view; hidden while the project has none. */
function MobileArchiveLink({ projectId }: { projectId: string }) {
  if (!useHasArchivedSessions(projectId)) return null;
  return (
    <button
      type="button"
      className="mobile-nav-more-sessions mobile-nav-archive-link"
      aria-haspopup="dialog"
      onClick={() => { openArchivedSessions(projectId); setSidebarOpen(false); }}
    >
      <UiIcon icon={ArchiveIcon} size="sm" />
      {tr("archivedsessions.entry")}
    </button>
  );
}

/** The toolbar's title: the Space this list belongs to. In the native app it
 *  opens the server menu (paired servers and Add server) where a separate
 *  tool used to; with several Spaces it is the Space switcher as well. With
 *  nothing to choose it is plain text. The page never learns a paired
 *  server's name (the native menu keeps those), so the Space names the place. */
function NavigatorPlace() {
  const spaces = useSpaces();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (getSpacesState().status === "idle") void loadSpaces();
  }, []);
  const name = spaces.status === "ready"
    ? activeSpace(spaces)?.name ?? ""
    : spaces.status === "error" ? "Polyth" : "";
  const servers = canSwitchMobileServer();
  const choose = spaces.status === "ready" && spaces.spaces.length > 1;
  const label = <span className="mobile-nav-place-name" dir="auto">{name}</span>;
  if (!servers && !choose) return <span className="mobile-nav-place">{label}</span>;
  if (!choose) {
    return (
      <button
        type="button"
        className="mobile-nav-place"
        aria-haspopup="menu"
        onClick={(event) => { tapFeedback(); switchMobileServer(event.currentTarget); }}
      >
        {label}
        <span className="sr-only">{tr("sidebar.switchServer")}</span>
        <Icon.chevronDown />
      </button>
    );
  }
  const entries: MenuEntry[] = [
    ...spaces.spaces.map((space): MenuEntry => ({
      id: `space:${space.id}`,
      label: space.name,
      kind: "radio",
      checked: space.id === spaces.activeSpaceId,
      ...(space.color ? { swatch: space.color } : {}),
      disabled: spaces.switching,
      onSelect: () => { void switchSpace(space.id); },
    })),
    ...(servers ? ["separator" as const, {
      id: "server",
      label: tr("sidebar.switchServer"),
      // The native menu opens at the title, as it does with one Space.
      onSelect: () => switchMobileServer(buttonRef.current),
    }] : []),
  ];
  return (
    <Menu label={tr("spaces.switcherLabel", { name })} title={tr("spaces.title")} entries={entries} align="start">
      {(trigger) => (
        <button
          {...trigger}
          ref={(node) => {
            buttonRef.current = node;
            if (typeof trigger.ref === "function") trigger.ref(node);
            else if (trigger.ref) (trigger.ref as { current: HTMLButtonElement | null }).current = node;
          }}
          type="button"
          className="mobile-nav-place"
          disabled={spaces.switching}
        >
          {label}
          <Icon.chevronDown />
        </button>
      )}
    </Menu>
  );
}

export default function MobileNavigator() {
  const guardrails = useGuardrails();
  const accountLimits = useAccountLimits();
  const drawerOpen = useStore((state) => state.sidebarOpen);
  const [drawerMounted, setDrawerMounted] = useState(drawerOpen);
  // How the drawer leaves: back off its own edge, or held in place and covered
  // by Settings arriving from the same side (settingsPresentation.ts).
  const [drawerExit, setDrawerExit] = useState<"leave" | "covered">("leave");
  // Mounted, inert and off-screen while a swipe from Chat pulls it in.
  const peeking = useSwipePeek("navigator");
  const swipeZone = swipeZoneInHost(useUiSettings().swipeNavigation);
  const swipeZoneRef = useRef(swipeZone);
  swipeZoneRef.current = swipeZone;
  const registry = useStore((state) => state.projectRegistry);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const storeSessionId = useStore((state) => state.activeSessionId);
  // While a package page (an agent) owns the canvas, no chat row is current.
  const pageOpen = useStore((state) => state.activePage !== null);
  const activeSessionId = pageOpen ? null : storeSessionId;
  const sessions = useLaneSessions(useStore((state) => state.sessions));
  // A purpose lane (Playground, Monitoring…) lists only its own chats. Opening
  // one of its chats switches the phone into that lane, and the header's lane
  // switch is hidden on a phone, so the navigator must name the lane and lead
  // back to ordinary chats; otherwise every project expands to nothing.
  const workbenchNavigation = useWorkbenchNavigation();
  const laneProfile = workbenchNavigation.profiles.find((profile) =>
    profile.id === workbenchNavigation.activeProfileId && profile.sessionPurpose);
  const relativeTime = useStore((state) => state.settings.relativeTime);
  const defaultVisibleSessionCount = useStore((state) => state.settings.defaultVisibleSessionCount);
  const projects = registry.projects;
  // Only the personal project: its chats list open, with no project row.
  const soloPersonal = registry.status === "ready" ? soloPersonalProject(projects) : null;
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const endSelection = () => {
    setSelectedIds(new Set());
    setSelectMode(false);
  };
  // Escape (and Android Back, through the escape stack) ends the selection first.
  useEscape(selectMode, endSelection);
  const rowSelection = useMemo(() => ({
    active: selectMode,
    ids: selectedIds,
    toggle: (id: string) => setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }),
  }), [selectMode, selectedIds]);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [dateFilter, setDateFilter] = useState<SessionDateFilter>(EMPTY_SESSION_DATE_FILTER);
  const from = dateFilter.mode === "date" ? dateFilter.date : dateFilter.from;
  const to = dateFilter.mode === "date" ? dateFilter.date : dateFilter.to;
  const pages = useSessionSummaryPages({ query, attentionOnly, archived: false,
    ...(from ? { fromTime: new Date(`${from}T00:00:00`).getTime() } : {}),
    ...(to ? { toTime: new Date(`${to}T23:59:59.999`).getTime() } : {}),
  }, drawerOpen || peeking);
  const sort = useProjectSortMode();
  const setSort = (mode: ProjectSortMode) => setProjectSortMode(mode);
  const projectOrder = useProjectOrder();
  const grouping = useSessionGrouping();
  const sessionSort = useSessionSortMode();
  const arrangementEntries = useSessionArrangementEntries();
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => loadExpanded(activeProjectId));
  const [showAllProjects, setShowAllProjects] = useState<ReadonlySet<string>>(loadShowAll);
  const [expandedSubagents, setExpandedSubagents] = useState<ReadonlySet<string>>(new Set());
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [appearanceProjectId, setAppearanceProjectId] = useState<string | null>(null);
  const [conversationProjectId, setConversationProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [now, setNow] = useState(Date.now());
  const navRef = useRef<HTMLElement>(null);
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (drawerOpen) {
      setDrawerMounted(true);
      setDrawerExit("leave");
      return;
    }
    if (!drawerMounted) return;
    // Covered by Settings, the drawer stays until Settings has fully arrived.
    return scheduleSurfaceExit(() => setDrawerMounted(false), drawerExit === "covered" ? "--motion-stack" : "--motion-surface");
  }, [drawerMounted, drawerOpen, drawerExit]);

  // Swipe toward the inline start to close: the drawer follows the finger and
  // a release either hands its position to the exit or springs it back.
  const closeSwipeOn = drawerOpen && swipeZone !== null;
  useEffect(() => {
    if (!closeSwipeOn) return;
    return attachSwipeSurface({
      surface: () => navRef.current,
      direction: "toward-start",
      zone: () => swipeZoneRef.current ?? "edge",
      enabled: () => swipeZoneRef.current !== null
        && getState().sidebarOpen
        && navRef.current?.dataset.arrangeDragging !== "true",
      motion: "--motion-surface",
      begin: ({ rtl }) => {
        const nav = navRef.current;
        if (!nav) return null;
        nav.setAttribute("data-swiping", "true");
        const offset = (travel: number): number => -travel * (rtl ? -1 : 1);
        const clear = (): void => {
          nav.removeAttribute("data-swiping");
          nav.style.removeProperty("transform");
        };
        return {
          paint(travel) {
            nav.style.transform = `translate3d(${offset(travel)}px, 0, 0)`;
          },
          cancel() {
            clear();
            // Sprang home: keep the entrance animation from replaying.
            nav.setAttribute("data-swipe-handoff", "rest");
          },
          commit({ travel, settleMs }) {
            if (settleMs > 0) {
              holdHandoff(nav, {
                from: { "--nav-swipe-from": `${offset(travel)}px` },
                pacing: { "--nav-swipe-settle": `${settleMs}ms` },
                attrs: { "data-swipe-handoff": "close" },
                animations: ["mobile-navigator-swipe-out"],
                fallbackMs: motionDurationMs("--motion-surface") + 320,
              });
            }
            flushSync(() => setSidebarOpen(false));
            clear();
            if (settleMs <= 0) parkLeavingLayer(nav, `translate3d(${rtl ? "" : "-"}100%, 0, 0)`);
          },
        };
      },
    });
  }, [closeSwipeOn]);

  useModalSurface({
    enabled: true,
    // Keep focus/background scroll ownership through the visual exit; the
    // canonical store is already closed and pointer input is disabled.
    // A peek is not open: it stays inert until the swipe commits.
    open: drawerOpen || drawerMounted,
    onClose: () => setSidebarOpen(false),
    containerRef: navRef,
    // The drawer itself takes focus: it must open silently, without raising
    // the keyboard through an autofocused search input (same contract as
    // Sheet's data-sheet-focus).
    initialFocus: "[data-drawer-focus]",
  });

  // Remembered across drawer remounts, reloads and, in the mobile app, launches.
  useEffect(() => {
    writeNavigatorState(EXPANDED_PROJECTS_KEY, JSON.stringify([...expandedProjects]));
  }, [expandedProjects]);

  useEffect(() => {
    writeNavigatorState(SHOW_ALL_PROJECTS_KEY, JSON.stringify([...showAllProjects]));
  }, [showAllProjects]);

  useEffect(() => {
    if (!drawerOpen || !activeProjectId) return;
    void refreshSessions(activeProjectId);
  }, [drawerOpen, activeProjectId]);

  useEffect(() => {
    if (!drawerOpen) return;
    const hasWorking = sessions.some((session) => session.status === "working");
    if (!hasWorking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [drawerOpen, sessions]);

  useEffect(() => {
    if (drawerOpen) setNow(Date.now());
    else {
      setQuery("");
      setSearchMode(false);
    }
  }, [drawerOpen]);

  // Keep the selected delegated session reachable in the collapsed tree. This
  // mirrors the isolated-section behavior: navigation should not activate a
  // child that is hidden behind each of its ancestor disclosures.
  useEffect(() => {
    if (!activeSessionId) return;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const ancestors = new Set<string>();
    const seen = new Set<string>();
    let parentId = byId.get(activeSessionId)?.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    if (ancestors.size === 0) return;
    setExpandedSubagents((current) => {
      const next = new Set(current);
      let changed = false;
      for (const ancestor of ancestors) {
        if (next.has(ancestor)) continue;
        next.add(ancestor);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [activeSessionId, sessions]);

  // The chat on screen belongs to the project it was created in. Each time the
  // navigator comes up (tap or swipe peek), and when the chat changes while it
  // is up, that project unfolds and is scrolled into view, so the chat is found
  // where it lives. A fold or scroll the user makes afterwards stands.
  const shown = drawerOpen || peeking;
  const currentProjectId = (activeSessionId
    ? sessions.find((session) => session.id === activeSessionId)?.projectId
    : undefined) ?? activeProjectId;
  const revealRef = useRef<{ projectId: string; sessionId: string | null; until: number } | null>(null);
  useEffect(() => {
    if (!shown || !currentProjectId) {
      revealRef.current = null;
      return;
    }
    setExpandedProjects((current) => current.has(currentProjectId) ? current : new Set(current).add(currentProjectId));
    // Rows arrive with the session lists; keep placing the project while they
    // do, but only briefly, so late loads never yank a list being read.
    revealRef.current = { projectId: currentProjectId, sessionId: activeSessionId, until: Date.now() + REVEAL_WINDOW_MS };
  }, [shown, currentProjectId, activeSessionId]);
  useLayoutEffect(() => {
    const reveal = revealRef.current;
    const scroller = navScrollRef.current;
    if (!reveal || !scroller) return;
    if (Date.now() > reveal.until) {
      revealRef.current = null;
      return;
    }
    const section = [...scroller.querySelectorAll<HTMLElement>("[data-project-id]")]
      .find((element) => element.dataset.projectId === reveal.projectId);
    if (!section) return;
    const row = reveal.sessionId
      ? section.querySelector<HTMLElement>(".mobile-nav-session-row.is-active")
      : null;
    revealProjectInList(scroller, section, row);
  });
  // The user's own touch, wheel or key in the list ends the placement.
  const endReveal = () => { revealRef.current = null; };

  const projectSessions = useMemo(() => {
    const result = new Map<string, SessionProjection[]>();
    for (const session of sessions) {
      if (session.status === "archived") continue;
      const list = result.get(session.projectId) ?? [];
      list.push(session);
      result.set(session.projectId, list);
    }
    for (const list of result.values()) list.sort(compareSessionNavigation);
    return result;
  }, [sessions]);
  // Delegated children ride inside their parent; a child whose parent has not
  // loaded yet is withheld while that parent is read.
  const delegatedChildren = useMemo(
    () => sessions.filter((session) => session.status !== "archived" && !!session.parentId),
    [sessions],
  );
  const parentPending = useSessionParentPending(delegatedChildren);

  // Every project in the chosen sort. The list on screen is a filtered view of
  // it, and a move saves it whole, so projects a filter hides keep their slots.
  //
  // This keeps its own "recent" rule on purpose: the phone puts projects that
  // need attention first, which permanent tests guard (mobileNavigator,
  // projectArrange). Manual and name order are the sidebar's, so a drag lands
  // in the same list the sidebar saves.
  const orderedProjects = useMemo(() => {
    if (sort === "manual") return applyManualProjectOrder(projects, projectOrder);
    const score = (id: string) => {
      const list = (projectSessions.get(id) ?? []).filter((session) => sessionMatchesDateFilter(session, dateFilter));
      const bestPriority = list.reduce((best, session) => Math.min(best, statusPriority(session)), 4);
      const latest = list.reduce((value, session) => Math.max(value, session.lastTurnAt ?? session.updatedAt ?? session.createdAt), 0);
      return { bestPriority, latest };
    };
    return [...projects].sort((a, b) => {
      if (sort === "name") return (a.name || a.path).localeCompare(b.name || b.path);
      const left = score(a.id);
      const right = score(b.id);
      return left.bestPriority - right.bestPriority || right.latest - left.latest;
    });
  }, [dateFilter, projectOrder, projectSessions, projects, sort]);

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return orderedProjects.filter((project) => {
      const list = projectSessions.get(project.id) ?? [];
      const dated = list.filter((session) => sessionMatchesDateFilter(session, dateFilter));
      if (sessionDateFilterActive(dateFilter) && dated.length === 0) return false;
      const hasAttention = dated.some((session) => statusPriority(session) <= 1 || (session.attention?.unread ?? 0) > 0);
      if (attentionOnly && !hasAttention) return false;
      if (!needle) return true;
      if (`${project.name} ${project.path}`.toLocaleLowerCase().includes(needle)) return true;
      return dated.some((session) => `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLocaleLowerCase().includes(needle));
    });
  }, [attentionOnly, dateFilter, orderedProjects, projectSessions, query]);

  // Projects move by direct manipulation (workspaceArrange.ts, the engine the
  // Workspace editor uses): a still press lifts a project's row, the copy
  // follows the finger while the other projects glide aside, the list scrolls
  // near its edges, and the order is saved once, on landing. Any sort allows
  // it: moving a project is choosing the custom order, so a move made under
  // "Recent activity" or "Project name" keeps that order and switches to it.
  const reorderable = !searchMode && query.trim() === "";
  const saveProjectMove = (shown: readonly string[]) => {
    const custom = sort === "manual";
    setProjectOrder(permuteManualProjects(orderedProjects.map((project) => project.id), shown));
    if (!custom) setProjectSortMode("manual");
    announce(tr(custom ? "sidebar.projectsReordered" : "sidebar.projectsReorderedCustom"));
  };
  const arrangeItems = useMemo<ArrangeItem[]>(
    () => visibleProjects.map((project) => ({ id: project.id, shape: "row" })),
    [visibleProjects],
  );
  const arrange = useArrange({
    items: arrangeItems,
    enabled: reorderable && drawerOpen,
    touchLiftMs: ARRANGE_LIST_LIFT_MS,
    scroller: () => navScrollRef.current,
    ghostHost: () => navRef.current,
    // Only the row is lifted; the held project folds its chats while it is up.
    ghostSource: (item) => item.querySelector<HTMLElement>(":scope > .mobile-nav-project-head"),
    onCommit: (next) => saveProjectMove(next),
  });
  const scrollRef = useCallback((element: HTMLDivElement | null) => {
    navScrollRef.current = element;
    arrange.engine.listRef(element);
  }, [arrange.engine]);
  const shownProjects = useMemo(() => {
    if (!arrange.draggingId) return visibleProjects;
    const byId = new Map(visibleProjects.map((project) => [project.id, project]));
    return arrange.order.flatMap((id) => byId.get(id) ?? []);
  }, [arrange.draggingId, arrange.order, visibleProjects]);
  const moveProjectBy = (id: string, delta: -1 | 1) => {
    const shown = visibleProjects.map((project) => project.id);
    const index = shown.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= shown.length) return;
    [shown[index], shown[target]] = [shown[target]!, shown[index]!];
    arrange.engine.animateNextLayout();
    saveProjectMove(shown);
  };

  // The field grows out of the search tool. Its input takes focus inside the
  // tap itself (flushSync lifts the field's inert first): iOS raises the
  // keyboard only for focus a gesture asked for.
  const openSearch = () => {
    flushSync(() => setSearchMode(true));
    searchRef.current?.focus({ preventScroll: true });
  };
  // Closing hands focus back to the tool the field came from. Escape and
  // Android Back close the field before the drawer. A tap on Back hands it
  // back quietly: focus leaving a text field reads as keyboard focus, so the
  // tool would otherwise light its ring after every touch close.
  const closeSearch = (quiet = false) => {
    flushSync(() => {
      setSearchMode(false);
      setQuery("");
    });
    searchToggleRef.current?.focus({ preventScroll: true, focusVisible: !quiet } as FocusOptions);
  };
  useEscape(searchMode, () => closeSearch());

  if (!drawerOpen && !drawerMounted && !peeking) return null;

  const toggleProject = (projectId: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    void refreshSessions(projectId);
  };

  const refreshProject = (projectId: string) => {
    void refreshSessions(projectId).catch((error) => setUiError(friendlyError(tr("common.error"), error)));
  };

  const toggleSubagents = (sessionId: string) => {
    setExpandedSubagents((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const saveProjectName = async (projectId: string) => {
    const next = projectName.trim();
    const current = projects.find((project) => project.id === projectId);
    setRenamingProjectId(null);
    if (!current || !next || next === current.name) return;
    try {
      await renameProject(projectId, next);
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const filterEntries: MenuEntry[] = [
    { heading: tr("sidebar.sortProjects") },
    {
      id: "recent",
      label: tr("sidebar.recentActivity"),
      kind: "radio",
      checked: sort === "recent",
      onSelect: () => setSort("recent"),
    },
    {
      id: "name",
      label: tr("sidebar.projectName"),
      kind: "radio",
      checked: sort === "name",
      onSelect: () => setSort("name"),
    },
    {
      id: "manual",
      label: tr("sidebar.manualOrder"),
      kind: "radio",
      checked: sort === "manual",
      onSelect: () => setSort("manual"),
    },
    "separator",
    { heading: tr("sidebarprefs.sessions") },
    {
      id: "attention",
      label: tr("sidebar.needsAttention"),
      kind: "checkbox",
      checked: attentionOnly,
      onSelect: () => setAttentionOnly((value) => !value),
    },
    ...arrangementEntries,
  ];

  // Sort and filters live in the search field; a choice away from the default
  // also marks the search tool, so it shows while the field is closed.
  const listFiltered = attentionOnly || sort !== "recent" || sessionDateFilterActive(dateFilter);

  // Remote paging continues the session lists the user has opened. With every
  // project collapsed there is no list to continue, so a footer link would read
  // as loading more projects; hide it until a session list is on screen.
  const showRemotePages = searchMode
    || visibleProjects.some((project) => expandedProjects.has(project.id));

  return (
    <>
      <div className={`mobile-nav-backdrop${drawerOpen ? "" : peeking ? " is-peeking" : " is-closing"}`} aria-hidden="true" />
      <nav
        ref={navRef}
        id="polyth-session-drawer"
        className={`mobile-navigator${drawerOpen ? "" : peeking ? " is-peeking" : " is-closing"}`}
        data-drawer-state={drawerOpen ? "open" : peeking ? "peek" : "closing"}
        data-drawer-exit={!drawerOpen && !peeking && drawerExit === "covered" ? "covered" : undefined}
        // A peek is a picture following the finger until the swipe opens it.
        inert={peeking}
        aria-hidden={peeking || undefined}
        role="dialog"
        aria-modal="true"
        aria-label={tr("sidebar.projectsAndSessions")}
        tabIndex={-1}
        data-drawer-focus=""
      >
        <h2 className="sr-only">{tr("sidebar.projectsAndSessions")}</h2>
        {/* One bar, two faces in the same place: the title and its tools, or
            the search field that grows out of the search tool. The face not
            in use is inert, so neither focus nor a tap can reach it. */}
        <div className={`mobile-nav-toolbar${searchMode ? " is-searching" : ""}`}>
          <div className="mobile-nav-toolbar-row" inert={searchMode}>
            <NavigatorPlace />
            <div className="mobile-nav-tools">
              <button
                ref={searchToggleRef}
                type="button"
                className="mobile-nav-tool mobile-nav-search-toggle"
                aria-label={tr("sidebar.searchProjectsWorktreesAndSessions")}
                aria-expanded={searchMode}
                aria-controls="mobile-nav-search"
                onClick={openSearch}
              >
                <Icon.search />
                {listFiltered && <span className="mobile-nav-filter-dot" />}
              </button>
              <button
                type="button"
                className={`mobile-nav-tool mobile-nav-select-toggle${selectMode ? " is-active" : ""}`}
                aria-label={selectMode ? tr("sidebar.cancelSessionSelection") : tr("sidebar.selectSessions")}
                aria-pressed={selectMode}
                onClick={() => (selectMode ? endSelection() : setSelectMode(true))}
              >
                <UiIcon icon={SelectIcon} size="lg" />
              </button>
              <button
                type="button"
                className="mobile-nav-tool"
                aria-label={tr("common.settings")}
                onClick={() => {
                  // Settings takes the drawer's place: in from the same side,
                  // and closed by the same swipe toward it.
                  presentSettingsFrom("start");
                  setDrawerExit("covered");
                  setSidebarOpen(false);
                  setOverlay("settings");
                }}
              >
                <Icon.gear />
              </button>
              <button
                type="button"
                className="mobile-nav-tool"
                aria-label={tr("sidebar.closeProjectsAndSessions")}
                onClick={() => setSidebarOpen(false)}
              >
                <Icon.close />
              </button>
            </div>
          </div>
          <div className="mobile-nav-search-bar" id="mobile-nav-search" inert={!searchMode}>
            <button
              type="button"
              className="mobile-nav-tool mobile-nav-search-back"
              aria-label={tr("common.back")}
              onClick={(event) => closeSearch(event.detail > 0)}
            >
              <Icon.back />
            </button>
            <div className="mobile-nav-search">
              <Icon.search />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={tr("sidebar.searchSessions")}
                aria-label={tr("sidebar.searchProjectsWorktreesAndSessions")}
                onFocus={() => setSearchMode(true)}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="mobile-nav-search-clear"
                  aria-label={tr("sidebar.clearSearch")}
                  onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                >
                  <Icon.close />
                </button>
              )}
              <Menu
                label={tr("sidebar.listOptions")}
                title={tr("sidebar.listOptions")}
                align="end"
                entries={filterEntries}
                className="session-filter-menu"
                footer={<SessionDateFilterControls value={dateFilter} onChange={setDateFilter} />}
              >
                {(trigger) => (
                  <button
                    type="button"
                    className={`mobile-nav-filter${listFiltered ? " is-active" : ""}`}
                    aria-label={tr("sidebar.listOptions")}
                    {...trigger}
                  >
                    <Icon.sliders />
                    {listFiltered && <span className="mobile-nav-filter-dot" />}
                  </button>
                )}
              </Menu>
            </div>
          </div>
        </div>

        {laneProfile && (
          <div className="mobile-nav-lanes" role="group" aria-label={tr("header.workspaceView")}>
            <button type="button" className="mobile-nav-lane" aria-pressed={false} onClick={() => switchWorkbenchNavigation("chat")}>
              {tr("header.chat")}
            </button>
            <button type="button" className="mobile-nav-lane is-active" aria-pressed={true}>
              {laneProfile.label}
            </button>
          </div>
        )}

        {selectMode && <SessionSelectionBar selectedIds={selectedIds} onDone={endSelection} />}

        <RowSelection.Provider value={rowSelection}>
        <div
          ref={scrollRef}
          className="mobile-nav-scroll"
          data-arranging={arrange.draggingId ? "" : undefined}
          onPointerDownCapture={endReveal}
          onTouchStartCapture={endReveal}
          onWheelCapture={endReveal}
          onKeyDownCapture={endReveal}
        >
          {visibleProjects.length === 0 && (
            <div className="mobile-nav-empty">{tr("sidebar.noMatchingSessions")}</div>
          )}
          {shownProjects.map((project) => {
            const all = projectSessions.get(project.id) ?? [];
            const needle = query.trim().toLocaleLowerCase();
            const dated = all.filter((session) => sessionMatchesDateFilter(session, dateFilter));
            const projectMatches = `${project.name} ${project.path}`.toLocaleLowerCase().includes(needle);
            const matching = needle && !projectMatches
              ? dated.filter((session) => `${session.title} ${session.branch ?? ""} ${session.worktreePath ?? ""}`.toLocaleLowerCase().includes(needle))
              : dated;
            const pinned = matching.filter((session) => session.pinned !== undefined);
            const normal = matching.filter((session) => session.pinned === undefined);
            const expanded = searchMode || soloPersonal !== null || expandedProjects.has(project.id);
            const showAll = searchMode || showAllProjects.has(project.id);
            // Search/filter context can omit a parent while retaining its
            // child. Build the tree from the dated project set, then seed it
            // with matching/paged rows so the parent is rendered as context
            // without turning a search into the whole project list.
            const normalTreeItems = dated.filter((session) => session.pinned === undefined);
            // Only rows of their own take page slots: a delegated child rides
            // with its listed parent, pinned or not.
            const listedIds = new Set(matching.map((session) => session.id));
            const normalRoots = arrangeSessions(
              normal.filter((session) => isNavigatorRoot(session, listedIds, parentPending)),
              grouping,
              sessionSort,
            );
            const visibleNormal = includeSessionTreeContext(
              normalTreeItems,
              showAll
                ? normalRoots
                : normalRoots.slice(0, Math.max(0, defaultVisibleSessionCount - pinned.length)),
            );
            const visibleNormalIds = new Set(visibleNormal.map((session) => session.id));
            const hiddenCount = normalRoots.filter((session) => !visibleNormalIds.has(session.id)).length;
            const pinnedTrees = buildSessionTree(includeSessionTreeContext(
              [...pinned, ...normalTreeItems],
              pinned,
              { ancestors: false },
            ));
            const { active: activeCount, waiting: waitingCount, unread: completedCount, failed: failedCount, limited: limitedCount } =
              projectSessionStatusCounts(matching, now);
            // Counts are shown as status pills, never as concatenated words:
            // "3 active" only reads correctly in English.
            const statusLabel = [
              activeCount > 0 ? `${activeCount} ${tr("common.running")}` : "",
              waitingCount > 0 ? `${waitingCount} ${tr("sidebar.needsAttention")}` : "",
              failedCount > 0 ? `${failedCount} ${tr("common.error")}` : "",
              limitedCount > 0 ? `${limitedCount} ${tr("sessionStatus.resumesAfterLimit")}` : "",
              completedCount > 0 ? `${completedCount} ${tr("sidebar.sessionlist.unreadActivity")}` : "",
            ].filter(Boolean).join(", ");
            const pinnedSessions = all.filter((session) => !!session.pinned);

            const renderNode = (node: SessionTreeNode<SessionProjection>, depth: number): ReactNode => {
              const expandedChildren = expandedSubagents.has(node.item.id);
              return (
                <div
                  className="mobile-nav-subagent-parent"
                  key={node.item.id}
                  style={{
                    "--mobile-nav-tree-depth": depth,
                    // Thread guide drops from this row's state mark.
                    "--mobile-nav-tree-line-left": `calc(${Math.min(depth, 3)} * var(--nav-tree-indent) + var(--nav-row-inset) + var(--nav-lead-col) / 2)`,
                  } as CSSProperties}
                >
                  <SessionRow
                    session={node.item}
                    active={node.item.id === activeSessionId}
                    now={now}
                    pinnedSessions={pinnedSessions}
                    onChanged={() => refreshProject(project.id)}
                    treeDepth={depth}
                    childActivity={subagentActivity(node.children, {
                      idOf: (child) => child.item.id,
                      childrenOf: (child) => child.children,
                      stateOf: (child) => sessionActivityState(child.item),
                    })}
                    childrenExpanded={expandedChildren}
                    onToggleChildren={() => toggleSubagents(node.item.id)}
                  />
                  {expandedChildren && node.children.length > 0 && (
                    <div className="mobile-nav-subagent-children">
                      {node.children.map((child) => renderNode(child, depth + 1))}
                    </div>
                  )}
                </div>
              );
            };
            const renderTreeGroups = (items: readonly SessionProjection[]): ReactNode => {
              const roots = buildSessionTree(items);
              const rootById = new Map(roots.map((node) => [node.item.id, node]));
              const arranged = arrangeSessions(roots.map((node) => node.item), grouping, sessionSort);
              return sessionGroupsOf(arranged, grouping, { relativeTime, locale: getLocale(), now }).map((group) => {
                const label = group.label;
                return (
                  <div className="mobile-nav-date-group" key={group.key}>
                    {label && (
                      <div className="mobile-nav-date-divider" role="separator" aria-label={label}><span>{label}</span></div>
                    )}
                    {group.sessions.map((session) => {
                      const node = rootById.get(session.id);
                      return node ? renderNode(node, 0) : null;
                    })}
                  </div>
                );
              });
            };

            const projectEntries: MenuEntry[] = [
              {
                id: "conversation",
                label: tr("conversation.new"),
                onSelect: () => setConversationProjectId(project.id),
              },
              {
                id: "rename",
                label: tr("common.rename"),
                onSelect: () => { setProjectName(project.name || project.path); setRenamingProjectId(project.id); },
              },
              {
                id: "copy-path",
                label: tr("editor.filepane.copyPath"),
                onSelect: () => { void navigator.clipboard?.writeText(project.path); },
              },
              ...(projectIsolationLevel(project.defaults) !== "off" ? [{
                id: "isolate",
                label: tr("sidebar.newSessionInWorktree"),
                onSelect: () => openWorktreeSessionDialog(project.id),
              }] : []),
              {
                id: "appearance",
                label: tr("sidebar.projectSettings"),
                onSelect: () => setAppearanceProjectId(project.id),
              },
              {
                id: "archived",
                label: tr("archivedsessions.title"),
                onSelect: () => { openArchivedSessions(project.id); setSidebarOpen(false); },
              },
              "separator",
              {
                id: "remove",
                label: tr("sidebar.closeProject"),
                danger: true,
                onSelect: () => {
                  void confirmAlert(tr("sidebar.closeValueThisRemovesItFrom", { name: project.name || project.path }), {
                    title: tr("sidebar.closeProject"),
                    confirmLabel: tr("sidebar.closeProject"),
                  }).then((ok) => { if (ok) void removeProject(project.id).catch((e) => setUiError(friendlyError(tr("common.error"), e))); });
                },
              },
            ];

            return (
              <section
                className={`mobile-nav-project${project.id === activeProjectId ? " is-current" : ""}${expanded ? " is-expanded" : ""}${reorderable ? " is-reorderable" : ""}${arrange.draggingId === project.id ? " is-arrange-held" : ""}`}
                data-project-id={project.id}
                data-arrange-id={reorderable ? project.id : undefined}
                key={project.id}
              >
                {!soloPersonal && <div
                  className="mobile-nav-project-head"
                  onPointerDown={reorderable ? arrange.engine.itemProps(project.id).onPointerDown : undefined}
                >
                  {/* Same project mark as the desktop navigator: the chosen
                      icon and colour are project identity, not decoration. */}
                  <ProjectGlyph project={project} />
                  {renamingProjectId === project.id ? (
                    <input
                      className="mobile-nav-project-rename"
                      autoFocus
                      value={projectName}
                      onChange={(event) => setProjectName(event.target.value)}
                      onBlur={() => void saveProjectName(project.id)}
                      onKeyDown={(event) => {
                        if (isImeComposing(event)) return;
                        if (event.key === "Enter") void saveProjectName(project.id);
                        if (event.key === "Escape") setRenamingProjectId(null);
                      }}
                    />
                  ) : (
                    <button
                      className="mobile-nav-project-main"
                      aria-expanded={expanded}
                      aria-keyshortcuts={reorderable ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
                      onClick={() => toggleProject(project.id)}
                      onKeyDown={(event) => {
                        if (!reorderable || !event.altKey || !event.shiftKey) return;
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          moveProjectBy(project.id, -1);
                        } else if (event.key === "ArrowDown") {
                          event.preventDefault();
                          moveProjectBy(project.id, 1);
                        }
                      }}
                    >
                      <span className="mobile-nav-project-name" dir="auto">{project.name || project.path}</span>
                      {/* One line in both states: the pills sit beside the
                          name instead of under it, so expanding never moves
                          the name and the row stays vertically centred.
                          Most urgent first: on a narrow phone the pills that
                          do not fit drop from the end. */}
                      {statusLabel && (
                        <span className="mobile-nav-project-statuses" aria-label={statusLabel}>
                          {activeCount > 0 && (
                            <span className="mobile-nav-project-status is-running" title={`${activeCount} ${tr("common.running")}`}>
                              {statusIcon("working")}
                              <span>{activeCount}</span>
                            </span>
                          )}
                          {waitingCount > 0 && (
                            <span className="mobile-nav-project-status is-waiting" title={`${waitingCount} ${tr("sidebar.needsAttention")}`}>
                              {statusIcon("waiting")}
                              <span>{waitingCount}</span>
                            </span>
                          )}
                          {failedCount > 0 && (
                            <span className="mobile-nav-project-status is-failed" title={`${failedCount} ${tr("common.error")}`}>
                              {statusIcon("failed")}
                              <span>{failedCount}</span>
                            </span>
                          )}
                          {limitedCount > 0 && (
                            <span className="mobile-nav-project-status is-limited" title={`${limitedCount} ${tr("sessionStatus.resumesAfterLimit")}`}>
                              {statusIcon("rate-limited")}
                              <span>{limitedCount}</span>
                            </span>
                          )}
                          {completedCount > 0 && (
                            <span className="mobile-nav-project-status is-complete" title={`${completedCount} ${tr("sidebar.sessionlist.unreadActivity")}`}>
                              {statusIcon("complete")}
                              <span>{completedCount}</span>
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  )}
                  <div className="mobile-nav-project-actions" data-arrange-control="">
                    <button
                      className="mobile-nav-project-action"
                      aria-label={tr("sidebar.newChatInValue", { value: project.name || project.path })}
                      onClick={() => { startFreshSession(project.id); setSidebarOpen(false); }}
                    >
                      <UiIcon icon={NewChatIcon} size="lg" />
                    </button>
                    <Menu label={tr("sidebar.actionsForValue", { value: project.name || project.path })} align="end" entries={projectEntries}>
                      {(trigger) => (
                        <button className="mobile-nav-project-action" aria-label={tr("common.more")} {...trigger}>
                          <Icon.more />
                        </button>
                      )}
                    </Menu>
                  </div>
                </div>}

                {expanded && (
                  <div className="mobile-nav-project-body">
                    {!searchMode && (
                      <SlotHost
                        slot="sidebar.project.leading"
                        context={{ projectId: project.id, activeSessionId, surface: "phone", onNavigate: () => setSidebarOpen(false) }}
                      />
                    )}
                    {pinned.length > 0 && (
                      <div className="mobile-nav-pinned" aria-label={tr("sidebar.sessionlist.pinnedChats")}>
                        <div className="mobile-nav-date-divider is-pinned" role="separator">
                          <span><Icon.pin />{tr("sidebar.sessionlist.pinnedChats")}</span>
                        </div>
                        {pinnedTrees.map((node) => node.children.length > 0 ? renderNode(node, 0) : (
                          <SessionRow
                            key={node.item.id}
                            session={node.item}
                            active={node.item.id === activeSessionId}
                            now={now}
                            pinnedSessions={pinnedSessions}
                            onChanged={() => refreshProject(project.id)}
                          />
                        ))}
                      </div>
                    )}
                    {renderTreeGroups(visibleNormal)}
                    {pinned.length === 0 && visibleNormal.length === 0 && hiddenCount === 0 && (
                      <p className="mobile-nav-project-empty">
                        {tr(soloPersonal ? "sidebar.sessionlist.noChatsYet" : "sidebar.sessionlist.noSessions")}
                      </p>
                    )}
                    {(hiddenCount > 0 || !searchMode) && (
                      <div className="mobile-nav-pagination">
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            className="mobile-nav-more-sessions"
                            onClick={() => setShowAllProjects((current) => new Set(current).add(project.id))}
                          >
                            {tr("sidebar.sessionlist.showMoreSessions")}
                            <Icon.chevronDown />
                          </button>
                        )}
                        {!searchMode && showAll && normal.length > 0 && (
                          <button
                            type="button"
                            className="mobile-nav-more-sessions"
                            onClick={() => setShowAllProjects((current) => {
                              const next = new Set(current);
                              next.delete(project.id);
                              return next;
                            })}
                          >
                            {tr("sidebar.sessionlist.showLessSessions")}
                            <Icon.chevronUp />
                          </button>
                        )}
                        {!searchMode && <MobileArchiveLink projectId={project.id} />}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {showRemotePages && pages.hasMore && <button className="mobile-nav-more-sessions" disabled={pages.busy} onClick={() => void pages.more()}>{tr("mobile.island.loadMore")}</button>}
          {/* Adding a project is rare next to the tools above, so it closes
              the list instead: a quiet row in the project grid. */}
          {!searchMode && !selectMode && registry.status === "ready"
            && guardedProjectAddAllowed(guardrails) && limitedProjectAddAllowed(accountLimits) && (
            <button
              type="button"
              className="mobile-nav-add-project"
              onClick={() => { setSidebarOpen(false); setOverlay("project-picker"); }}
            >
              <span className="mobile-nav-add-project-mark" aria-hidden="true">
                <UiIcon icon={AddProjectIcon} size="sm" />
              </span>
              <span className="mobile-nav-add-project-label">{tr("sidebar.addProject")}</span>
            </button>
          )}
        </div>
        </RowSelection.Provider>
      </nav>
      {appearanceProjectId && (() => {
        const target = projects.find((project) => project.id === appearanceProjectId);
        return target ? <ProjectAppearanceDialog project={target} onClose={() => setAppearanceProjectId(null)} /> : null;
      })()}
      {conversationProjectId && (
        <ConversationCreateDialog
          open
          projectId={conversationProjectId}
          onClose={() => setConversationProjectId(null)}
        />
      )}
    </>
  );
}
