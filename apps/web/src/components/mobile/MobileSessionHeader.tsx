import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { draftTitleSource } from "../../sessionDraft.ts";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { resolveModelContextLimit } from "@polyth/contracts/model-context";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { displaySessionTitle, fmtDuration, fmtTokens, formatDate, isPlaceholderTitle } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { formatNumber, getLocaleSnapshot, subscribeLocale, tr } from "../../i18n/index.ts";
import {
  activeSessionsForIsland,
  buildIslandItems,
  eventsHaveCodeChanges,
  groupRecentSessionsByDay,
  hasWorktreeSession,
  ISLAND_RECENT_LIMIT,
  isIsolatedSession,
  notablePeers,
  recentSessionTimestamp,
  recentSessionsForIsland,
  sessionTitleOf,
  tasksForIsland,
  type IslandItem,
  type IslandTask,
} from "../../mobileIsland.ts";
import {
  deriveTaskProgressEvent,
  taskProgressSnapshot,
  taskProgressSnapshotKey,
  type TaskProgressEvent,
} from "../../mobileTaskProgress.ts";
import { useAttentionCue } from "../../mobileAttentionCue.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../../sessionStatus.ts";
import { sessionOverviewMode } from "../../sessionOverviewMode.ts";
import {
  deleteSession,
  openSession,
  pollSessionTail,
  prefetchSessionTail,
  refreshSessions,
} from "../../init.ts";
import { openSessionSharing, setRailPlugin, setSidebarOpen, setUiError, startFreshSession, useActiveModel, useStore, workspaceProjectId } from "../../store.ts";
import { canManageSession, ownerName } from "../../sessionSharing.ts";
import { SessionSharingLine } from "../ShareSessionDialog.tsx";
import { useResolvedCapabilities } from "../../capabilities.ts";
import {
  hideMobileWorkspaceHome,
  showMobileWorkspaceHome,
  useMobileWorkspaceNavigation,
} from "../../mobileWorkspaceNavigation.ts";
import { copyText, firstUserTextCached, lastUserTextCached } from "../../utils.ts";
import { scheduleSurfaceExit } from "../../motionPresence.ts";
import { Button, ComposeIcon, GlassIsland, IconButton, LayersIcon, Menu, MenuIcon, type MenuEntry } from "../ui/index.ts";
import { setHeroEditing, useHeroEditing } from "../../heroEditing.ts";
import SlotHost from "../slots/SlotHost.ts";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";
import { isImeComposing } from "../input/editorCore.ts";
import { archiveSessionWithPolicy, renameSessionTitle, toggleSessionPin } from "../../sessionActions.ts";
import { confirmAlert } from "../../alerts.ts";
import { friendlyError } from "../../settings.ts";
import { useSessionSummaryPages } from "../../useSessionSummaryPages.ts";
import { errorFeedback, successFeedback, tapFeedback } from "../../haptics.ts";
import { announce } from "../a11y/live.tsx";
import {
  contextGaugeForTelemetry,
  contextHasSample,
  contextTelemetryNotice,
  contextTelemetryStatus,
  formatContextPercent,
  type RenderModel,
} from "../../reduce.ts";
import SessionActivityDetails from "../SessionActivityDetails.tsx";
import { useUiSettings } from "../../uiPrefs.ts";
import { POLYTH_MARK_SRC } from "../../brandAsset.ts";
import { MobileStatusIcon } from "./MobileStatusIcon.tsx";
import {
  closeSessionStatusPopover,
  useSessionStatusPopover,
} from "../../sessionStatusPopover.ts";
import "./MobileSessionHeader.css";

const SESSION_TITLE_POLL_MS = 2_000;
/** Rows whose tails the island warms for code-change marks. Warms share the
 *  12-session event LRU with opened sessions, and Active can list hundreds of
 *  runtime-changed sessions — each an extra request on a phone link. */
const ISLAND_WARM_LIMIT = 10;
const TASK_ACTIVE_TITLE_MS = 1_600;
const TASK_COMPLETED_TITLE_MS = 950;
const TASK_ALL_COMPLETE_TITLE_MS = 1_200;
// Matches MobileNavigator's row long-press: same gesture opens the same kind
// of session submenu everywhere sessions are listed on phone.
const LONG_PRESS_MS = 550;

type TaskTitleTone = TaskProgressEvent["kind"];

interface TaskTitleCue {
  sessionId: string | undefined;
  key: string;
  text: string;
  tone: TaskTitleTone;
}

/**
 * Borrow the compact session title for task transitions that happen while the
 * reader is already in this session. The source is the normalized task
 * snapshot, not provider-specific task events, so TodoWrite-only harnesses get
 * the same behavior. Switching sessions seeds the baseline and never replays
 * an old task cue.
 */
function useTaskProgressTitle(sessionId: string | undefined, tasks: readonly IslandTask[]): TaskTitleCue | null {
  const snapshot = taskProgressSnapshot(tasks);
  const snapshotKey = taskProgressSnapshotKey(snapshot);
  const sessionRef = useRef(sessionId);
  const previousRef = useRef(snapshot);
  const [visible, setVisible] = useState<TaskTitleCue | null>(null);

  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      previousRef.current = snapshot;
      setVisible(null);
      return;
    }

    const previous = previousRef.current;
    previousRef.current = snapshot;
    const event = deriveTaskProgressEvent(previous, snapshot);
    if (!event) {
      setVisible(null);
      return;
    }

    const text = event.kind === "all-complete"
      ? `✓ ${tr("timeline.valueCompleteOfValue", { completed: event.completed, total: event.total })}`
      : event.kind === "completed"
        ? `✓ ${event.text}`
        : event.kind === "failed"
          ? `× ${event.text}`
          : `● ${event.text}`;
    const cue: TaskTitleCue = {
      sessionId,
      key: `${sessionId ?? "new"}:${event.key}:${snapshotKey}`,
      text,
      tone: event.kind,
    };
    setVisible(cue);

    if (event.kind === "failed") return;
    const duration = event.kind === "active"
      ? TASK_ACTIVE_TITLE_MS
      : event.kind === "all-complete"
        ? TASK_ALL_COMPLETE_TITLE_MS
        : TASK_COMPLETED_TITLE_MS;
    const timer = window.setTimeout(() => {
      setVisible((current) => current?.key === cue.key ? null : current);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [sessionId, snapshotKey]);

  return visible?.sessionId === sessionId ? visible : null;
}

function SessionLiveIcon({ status }: { status: SessionRowStatus }) {
  const label = statusLabel(status);
  return (
    <span className={`mobile-island-live ${status.kind}`} title={label} aria-label={label}>
      <MobileStatusIcon kind={status.kind} />
    </span>
  );
}

function progressStep(tasks: IslandTask[]): number {
  const active = tasks.findIndex((task) => task.status === "active");
  if (active >= 0) return active + 1;
  const pending = tasks.findIndex((task) => task.status === "pending");
  if (pending >= 0) return pending + 1;
  return tasks.length;
}

function statusLabel(status: SessionRowStatus): string {
  switch (status.kind) {
    case "working": return tr("mobile.island.working");
    case "needs-approval": return tr("sidebar.sessionlist.approvalRequired");
    case "needs-reply": return tr("sidebar.sessionlist.replyNeeded");
    case "failed": return tr("common.error");
    case "rate-limited": return tr("sessionStatus.resumesAfterLimit");
    case "epoch-pending": return tr("sessionStatus.runtimeChanged");
    case "resume-ready": return tr("sessionStatus.reconnectOnUse");
    case "reconciling": return tr("header.reconnecting");
    case "unknown": return tr("composer.unknown");
    case "unread": return tr("sidebar.sessionlist.unreadActivity");
    case "regular": return tr("sidebarprefs.idle");
  }
}

function locationMeta(session: SessionProjection): string {
  const worktree = hasWorktreeSession(session)
    ? session.branch?.trim() || tr("mobile.island.worktree")
    : "";
  const isolated = isIsolatedSession(session) ? tr("mobile.island.isolated") : "";
  return [worktree, isolated].filter(Boolean).join(" · ");
}

function contextMeta(
  gauge: ReturnType<typeof contextGaugeForTelemetry> | null | undefined,
  contextPercent: string | null | undefined,
): string {
  if (!gauge || (!gauge.known && !contextPercent && !contextHasSample(gauge))) return "";
  const prefix = gauge.quality === "estimated" ? "~" : "";
  const tokens = gauge.known && gauge.contextTokens !== null
    ? `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)}`
    : contextHasSample(gauge)
      ? tr("context.tokens", { tokens: `${prefix}${fmtTokens(gauge.inputTokens)}` })
      : "";
  return [tr("capabilities.context"), tokens, contextPercent ?? ""].filter(Boolean).join(" · ");
}

/** One row of the "Recent" list. Long-press mirrors MobileNavigator's session
 *  row exactly: same 550ms hold, same entries (rename/copy id/pin/archive/
 *  delete), so both phone session lists behave the same way. */
function RecentSessionRow({
  item, itemStatus, itemTitle, rowLabel, meta, selected, timeLabel, pinnedSessions, onOpen, onChanged,
}: {
  item: SessionProjection;
  itemStatus: SessionRowStatus;
  itemTitle: string;
  rowLabel: string;
  meta?: string;
  selected?: boolean;
  timeLabel?: string;
  pinnedSessions: SessionProjection[];
  onOpen: () => void;
  onChanged: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(item.title);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  // A hold opens the menu; the click that ends it must not also open the session.
  const longPressOpenedRef = useRef(false);
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setTitle(item.title), [item.title]);
  useEffect(() => () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
  }, []);

  const clearPress = () => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || renaming) return;
    pointerStart.current = { x: event.clientX, y: event.clientY };
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
    if (Math.abs(event.clientX - start.x) < 6 && Math.abs(event.clientY - start.y) < 6) return;
    clearPress();
  };
  const onPointerEnd = () => {
    clearPress();
    pointerStart.current = null;
  };

  const commitRename = async () => {
    setRenaming(false);
    try {
      const renamed = await renameSessionTitle(item.id, item.title, title);
      if (renamed) onChanged();
      else setTitle(item.title);
    } catch (error) {
      setTitle(item.title);
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const archive = async () => {
    try {
      if (await archiveSessionWithPolicy(item)) {
        successFeedback();
        onChanged();
      }
    } catch (error) {
      errorFeedback();
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const remove = async () => {
    const label = item.title || tr("sidebar.sessionlist.session");
    const activity = item.isolation
      ? ` ${tr("sidebar.sessionlist.theLocalIsolationWorkspaceAndEveryFileInItWillAlsoBePermanentlyDeleted")}`
      : "";
    if (!await confirmAlert(
      tr("sidebar.sessionlist.deleteValueValueThisPermanentlyRemovesThe", { label, activity }),
      { title: tr("sidebar.sessionlist.deleteSession"), confirmLabel: tr("common.delete") },
    )) return;
    try {
      await deleteSession(item.id);
      successFeedback();
      onChanged();
    } catch (error) {
      errorFeedback();
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const togglePin = async () => {
    try {
      await toggleSessionPin(item, pinnedSessions);
      successFeedback();
      onChanged();
    } catch (error) {
      errorFeedback();
      setUiError(friendlyError(tr("common.error"), error));
    }
  };

  const copySessionId = async () => {
    if (await copyText(item.id)) {
      successFeedback();
      announce(tr("sidebar.sessionlist.sessionIdCopied"));
    } else {
      setUiError(tr("questioncards.copyFailedClipboardUnavailable"));
    }
  };

  const manage = canManageSession(item);
  const entries: MenuEntry[] = [
    ...(manage ? [{
      id: "rename",
      label: tr("common.rename"),
      onSelect: () => { setTitle(item.title); setRenaming(true); },
    } satisfies MenuEntry] : []),
    {
      id: "copy-id",
      label: tr("sidebar.sessionlist.copySessionId"),
      onSelect: () => void copySessionId(),
    },
    {
      id: "pin",
      label: item.pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop"),
      onSelect: () => void togglePin(),
    },
    ...(item.sharing ? [{
      id: "share",
      label: manage ? tr("sharing.share") : tr("sharing.whoHasAccess"),
      onSelect: () => openSessionSharing(item.id),
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

  if (renaming) {
    return (
      <div className="sheet-row" role="presentation">
        <input
          className="mobile-island-rename-input"
          autoFocus
          value={title}
          aria-label={tr("common.rename")}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "Enter") void commitRename();
            if (event.key === "Escape") { setTitle(item.title); setRenaming(false); }
          }}
        />
      </div>
    );
  }

  const time = recentSessionTimestamp(item);
  return (
    <Menu
      label={tr("sidebar.sessionlist.actionsForValue", { value: item.title || tr("sidebar.sessionlist.session") })}
      entries={entries}
      align="end"
      phonePresentation="popover"
      open={menuOpen}
      onOpenChange={setMenuOpen}
      returnFocusRef={rowRef}
      footer={<SlotHost slot="sidebar.session.actions" context={{
        sessionId: item.id,
        status: item.status,
        closeMenu: () => setMenuOpen(false),
      }} />}
    >
      {/* The row itself anchors the menu: it opens by hold or context menu,
          never by a tap, which opens the session. */}
      {(trigger) => (
        <div
          ref={(node) => {
            rowRef.current = node;
            const ref = trigger.ref as Ref<HTMLElement | null>;
            if (typeof ref === "function") ref(node);
            else if (ref && typeof ref === "object") (ref as { current: HTMLElement | null }).current = node;
          }}
          className={`mobile-island-session-entry${meta ? " has-meta" : ""}${selected ? " is-current" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuOpen(true);
          }}
        >
          <SheetRow
            title={itemTitle}
            meta={meta}
            icon={<SessionLiveIcon status={itemStatus} />}
            selected={selected}
            trailing={timeLabel ? <time className="mobile-island-row-time" dateTime={new Date(time).toISOString()}>{timeLabel}</time> : undefined}
            ariaLabel={[rowLabel, timeLabel].filter(Boolean).join(", ")}
            onClick={() => {
              if (longPressOpenedRef.current) {
                longPressOpenedRef.current = false;
                return;
              }
              onOpen();
            }}
          />
        </div>
      )}
    </Menu>
  );
}

export function SessionQuickAccessSheet({
  activeSession,
  gauge,
  contextPercent,
  contextNotice,
  modelName,
  model,
  sessionTitle,
  prompt,
  tasks,
  requests,
  recent,
  recentTotal,
  recentTotalIncomplete = false,
  hasMoreRecent,
  isLoadingMore,
  onLoadMore,
  pinnedSessions = [],
  onSessionChanged = () => {},
  events,
  closing = false,
  onClose,
  active = [],
  activeTotal,
  fullScreen = false,
}: {
  active?: SessionProjection[];
  activeTotal?: number;
  fullScreen?: boolean;
  activeSession?: SessionProjection | null;
  gauge?: ReturnType<typeof contextGaugeForTelemetry> | null;
  contextPercent?: string | null;
  contextNotice?: string | null;
  modelName?: string | null;
  model: RenderModel;
  sessionTitle: string;
  prompt: string | undefined;
  tasks: IslandTask[];
  requests: IslandItem[];
  recent: SessionProjection[];
  recentTotal?: number;
  recentTotalIncomplete?: boolean;
  hasMoreRecent?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  pinnedSessions?: SessionProjection[];
  onSessionChanged?: () => void;
  events: Record<string, readonly SessionEvent[] | undefined>;
  closing?: boolean;
  onClose: () => void;
}) {
  const actionNeededCopy = tr("mobile.island.requests");
  const actionNeededLabel = actionNeededCopy === "Requests" ? "Action needed" : actionNeededCopy;
  const progressCopy = tr("mobile.island.tasks");
  const progressLabel = progressCopy === "Tasks" ? "Progress" : progressCopy;
  const currentStep = progressStep(tasks);
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  const recentGroups = useMemo(() => groupRecentSessionsByDay(recent, locale), [recent, locale]);
  const activeIds = useMemo(() => new Set(active.map((item) => item.id)), [active]);
  const inlineRequests = fullScreen
    ? requests.filter((request) => {
      const peerId = request.id.startsWith("peer:") ? request.id.slice(5) : null;
      return !peerId || !activeIds.has(peerId);
    })
    : requests;
  const showActiveSection = fullScreen && (active.length > 0 || inlineRequests.length > 0);
  const showRecentSection = recent.length > 0 || recentTotal === 0;

  const recentSection = (
    <SheetSection title={`${tr("mobile.island.recent")} · ${formatNumber(recentTotal ?? recent.length)}${recentTotalIncomplete ? "+" : ""}`}>
      {recent.length === 0 ? (
        <p className="mobile-island-recent-empty" role="status">{tr("mobile.island.noRecent")}</p>
      ) : (
        <div
          className={`mobile-island-recent-scroll${fullScreen ? " is-full-screen" : ""}`}
          role="region"
          aria-label={tr("mobile.island.recent")}
          tabIndex={fullScreen ? undefined : 0}
        >
          {recentGroups.map((group) => (
            <div className="mobile-island-recent-day" key={group.key}>
              <h4 className="mobile-island-recent-day-label">{group.label}</h4>
              {group.sessions.map((item) => {
                const itemStatus = resolveSessionStatus(item);
                const itemTitle = sessionTitleOf(item, events);
                const location = locationMeta(item);
                const changed = eventsHaveCodeChanges(events[item.id]) ? tr("mobile.island.codeChanged") : "";
                const rowLabel = [itemTitle, statusLabel(itemStatus), location, changed].filter(Boolean).join(", ");
                const timeLabel = formatDate(recentSessionTimestamp(item), { timeStyle: "short" });
                return (
                  <RecentSessionRow
                    key={item.id}
                    item={item}
                    itemStatus={itemStatus}
                    itemTitle={itemTitle}
                    rowLabel={rowLabel}
                    meta={[location, changed].filter(Boolean).join(" · ")}
                    timeLabel={timeLabel}
                    pinnedSessions={pinnedSessions}
                    onOpen={() => {
                      void openSession(item.id);
                      onClose();
                    }}
                    onChanged={onSessionChanged}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
      {onLoadMore && recentTotal !== undefined && (
        <div className="mobile-island-recent-more">
          {hasMoreRecent ? (
            <button
              type="button"
              className="mobile-island-load-more"
              onClick={onLoadMore}
              disabled={isLoadingMore}
              aria-busy={isLoadingMore}
            >
              {isLoadingMore ? tr("mobile.island.loadingMore") : tr("mobile.island.loadMore")}
            </button>
          ) : recentTotal > 0 ? (
            <p className="mobile-island-recent-end" role="status">{tr("mobile.island.allRecentShown")}</p>
          ) : null}
        </div>
      )}
    </SheetSection>
  );

  const activeSection = showActiveSection ? (
    <SheetSection title={`${tr("mobile.island.active")} · ${formatNumber(activeTotal ?? active.length)}`}>
      <ul className="mobile-island-session-list" aria-label={tr("mobile.island.active")}>
        {inlineRequests.map((request) => {
          const peerId = request.id.startsWith("peer:") ? request.id.slice(5) : null;
          const requestKind = request.tone === "needs-approval" ? "needs-approval" : "needs-reply";
          const requestStatus = requestKind === "needs-approval"
            ? tr("sidebar.sessionlist.approvalRequired")
            : tr("sidebar.sessionlist.replyNeeded");
          const content = (
            <>
              <span className={`mobile-island-request-icon ${requestKind}`} aria-hidden="true">
                <MobileStatusIcon kind={requestKind} />
              </span>
              <span className="mobile-island-request-copy">
                <strong>{request.text}</strong>
                <small>{requestStatus}</small>
              </span>
            </>
          );
          return (
            <li className="mobile-island-request-entry" key={request.id}>
              {peerId ? (
                <button
                  type="button"
                  className="mobile-island-request-button"
                  aria-label={`${request.text}, ${requestStatus}`}
                  onClick={() => {
                    void openSession(peerId);
                    onClose();
                  }}
                >
                  {content}
                </button>
              ) : (
                <div className="mobile-island-request-button is-static" role="status" aria-label={`${request.text}, ${requestStatus}`}>
                  {content}
                </div>
              )}
            </li>
          );
        })}
        {active.map((item) => {
          const itemStatus = resolveSessionStatus(item);
          const itemTitle = sessionTitleOf(item, events);
          const isCurrent = item.id === activeSession?.id;
          const statusParts = [statusLabel(itemStatus)];
          if (itemStatus.kind === "working") statusParts.push(fmtDuration(itemStatus.elapsedMs));
          if (isCurrent) {
            statusParts.push(tr("mobile.island.current"));
            if (tasks.length > 0) statusParts.push(`${progressLabel} ${formatNumber(currentStep)}/${formatNumber(tasks.length)}`);
            statusParts.push(contextMeta(gauge, contextPercent));
          }
          statusParts.push(locationMeta(item));
          if (eventsHaveCodeChanges(events[item.id])) statusParts.push(tr("mobile.island.codeChanged"));
          const meta = statusParts.filter(Boolean).join(" · ");
          const rowLabel = [itemTitle, ...statusParts.filter(Boolean)].join(", ");
          return (
            <li key={item.id}>
              <RecentSessionRow
                item={item}
                itemStatus={itemStatus}
                itemTitle={itemTitle}
                rowLabel={rowLabel}
                meta={meta}
                selected={isCurrent}
                pinnedSessions={pinnedSessions}
                onOpen={() => {
                  void openSession(item.id);
                  onClose();
                }}
                onChanged={onSessionChanged}
              />
            </li>
          );
        })}
      </ul>
    </SheetSection>
  ) : null;

  return (
    <Sheet
      title={fullScreen ? tr("header.polyth") : tr("mobile.island.overview")}
      headerLeading={fullScreen ? <img src={POLYTH_MARK_SRC} alt="" aria-hidden="true" /> : undefined}
      origin="top"
      closing={closing}
      className={`mobile-island-sheet${fullScreen ? " mobile-island-sheet--full-screen" : " mobile-island-sheet--details"}`}
      onClose={onClose}
    >
      {fullScreen ? (
        <>
          {activeSession && (
            <section className="mobile-island-current-session" aria-label={tr("mobile.sessionmenu.sessionTitle")}>
              <span>{tr("mobile.sessionmenu.sessionTitle")}</span>
              <h2>{sessionTitle}</h2>
              <SessionSharingLine session={activeSession} onOpen={onClose} />
            </section>
          )}
          {activeSection}
          {showRecentSection && recentSection}
        </>
      ) : (
        <>
          {activeSession && <SessionSharingLine session={activeSession} onOpen={onClose} />}
          <SessionActivityDetails
            sessionTitle={sessionTitle}
            prompt={prompt}
            modelName={modelName}
            tasks={tasks}
            session={activeSession ?? null}
            model={model}
            usageEvents={activeSession ? events[activeSession.id] : undefined}
            gauge={gauge}
            contextNotice={contextNotice}
          />

          {requests.length > 0 && (
            <SheetSection title={`${actionNeededLabel} · ${formatNumber(requests.length)}`}>
              <ul className="mobile-task-list mobile-action-needed-list">
                {requests.map((request) => {
                  const peerId = request.id.startsWith("peer:") ? request.id.slice(5) : null;
                  return (
                    <li key={request.id} className="request">
                      {peerId ? (
                        <button
                          type="button"
                          className="mobile-task-action-btn"
                          onClick={() => {
                            void openSession(peerId);
                            onClose();
                          }}
                        >
                          <span className={`mobile-island-dot ${request.tone ?? request.kind}`} aria-hidden="true" />
                          <span className="mobile-task-text">{request.text}</span>
                        </button>
                      ) : (
                        <>
                          <span className={`mobile-island-dot ${request.tone ?? request.kind}`} aria-hidden="true" />
                          <span className="mobile-task-text">{request.text}</span>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </SheetSection>
          )}

          {showRecentSection && recentSection}
        </>
      )}
    </Sheet>
  );
}

/** Phone navigation is intentionally a small overlay, not a second application header. */
export default function MobileSessionHeader() {
  const { mobileSessionTitle } = useUiSettings();
  const TitleContainer = mobileSessionTitle === "button" ? GlassIsland : "div";
  const projectId = useStore(workspaceProjectId);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const events = useStore((state) => state.events);
  const sessions = useStore((state) => state.sessions);
  const projectSessions = useMemo(
    () => projectId ? sessions.filter((candidate) => candidate.projectId === projectId) : [],
    [sessions, projectId],
  );
  const pinnedSessions = useMemo(() => projectSessions.filter((candidate) => !!candidate.pinned), [projectSessions]);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const conversation = session?.purpose === "conversation";
  const model = useActiveModel();
  const models = useStore((state) => state.models);
  const capabilities = useResolvedCapabilities();
  const workspaceNav = useMobileWorkspaceNavigation();
  // The new chat's edit mode borrows the actions island for its Done.
  const heroEditing = useHeroEditing();
  const [surface, setSurface] = useState<"island" | null>(null);
  const pages = useSessionSummaryPages({ projectId: projectId ?? undefined, archived: false }, surface === "island" && projectId !== null);
  const [recentVisibleLimit, setRecentVisibleLimit] = useState(ISLAND_RECENT_LIMIT);
  const title = session
    ? displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]) ?? draftTitleSource(session))
    : tr("mobile.island.newChat");
  const prompt = lastUserTextCached(session ? events[session.id] : undefined);

  const active = useMemo(
    () => activeSessionsForIsland(projectSessions, session?.id),
    [projectSessions, session?.id],
  );
  const recent = useMemo(
    () => recentSessionsForIsland(projectSessions, session?.id, recentVisibleLimit),
    [projectSessions, session?.id, recentVisibleLimit],
  );
  const recentTotal = useMemo(
    () => recentSessionsForIsland(projectSessions, session?.id, projectSessions.length).length,
    [projectSessions, session?.id],
  );
  const hasMoreRecent = recent.length < recentTotal || pages.hasMore;

  useEffect(() => {
    setRecentVisibleLimit(ISLAND_RECENT_LIMIT);
  }, [projectId, session?.id]);
  const unresolvedTitleIds = useMemo(
    () => [...active, ...recent]
      .filter((item) => isPlaceholderTitle(item.title, item.id)
        && (item.lastTurnAt !== undefined || item.status !== "idle"))
      .map((item) => item.id),
    [active, recent],
  );
  const unresolvedTitleIdsRef = useRef<readonly string[]>(unresolvedTitleIds);
  const peers = useMemo(
    () => notablePeers(projectSessions, session?.id, events),
    [projectSessions, session?.id, events],
  );

  useEffect(() => {
    for (const item of [...peers, ...active, ...recent].slice(0, ISLAND_WARM_LIMIT)) prefetchSessionTail(item.id);
  }, [peers, active, recent]);

  useEffect(() => {
    unresolvedTitleIdsRef.current = unresolvedTitleIds;
  }, [unresolvedTitleIds]);

  const statusPopover = useSessionStatusPopover();
  const overviewMode = sessionOverviewMode(surface === "island", statusPopover);
  const overviewOpen = overviewMode !== "closed";

  useEffect(() => {
    if (!overviewOpen || !projectId) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      // Projections carry native/generated titles; passive tails cover the
      // short interval where a new background session has a durable prompt
      // but its semantic title is still pending. Recursive scheduling avoids
      // overlapping reads on slow mobile links.
      await Promise.allSettled([
        refreshSessions(projectId),
        ...unresolvedTitleIdsRef.current.map((id) => pollSessionTail(id)),
      ]);
      if (!disposed) timer = window.setTimeout(() => void poll(), SESSION_TITLE_POLL_MS);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [overviewOpen, projectId]);

  const labels = useMemo(() => ({
    task: tr("mobile.island.kindTask"),
    request: tr("mobile.island.kindRequest"),
    session: tr("mobile.island.kindSession"),
    peer: tr("mobile.island.kindPeer"),
    working: tr("mobile.island.working"),
    newChat: tr("mobile.island.newChat"),
  }), []);

  const overviewTasks = tasksForIsland(model.tasks, model.messages);
  const taskProgressTitle = useTaskProgressTitle(session?.id, overviewTasks);
  const displayedTitle = taskProgressTitle?.text ?? title;
  const { attentionCue, dismissAttentionCue } = useAttentionCue(session?.id, sessions, events);
  const activeTitleText = attentionCue ? `${attentionCue.sessionTitle} · ${attentionCue.label}` : displayedTitle;
  const items = buildIslandItems({
    sessionTitle: title,
    hasSession: session !== null,
    tasks: overviewTasks,
    permissions: model.permissions,
    questions: model.questions,
    secrets: model.secrets,
    peers,
    labels,
  });
  const requests = items.filter((item) => item.kind === "request");
  const runtimeFeatures = useStore((state) => session?.id ? state.runtimeFeatures[session.id] : undefined);
  const activeModel = model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = resolveModelPresentation(activeModel, models, session?.resolvedHarnessId).descriptor;
  const contextTokens = resolveModelContextLimit(
    activeModel,
    models,
    session?.resolvedHarnessId,
  );
  const telemetryStatus = contextTelemetryStatus(runtimeFeatures?.telemetry);
  const gauge = contextGaugeForTelemetry(model, contextTokens, session?.contextWindow ?? null, telemetryStatus,
    { model: activeModel, harnessId: session?.resolvedHarnessId });
  const contextPercent = formatContextPercent(gauge);
  const contextNotice = contextTelemetryNotice(telemetryStatus, gauge);

  const modelName = descriptor?.name ?? activeModel?.modelID ?? null;

  useEffect(() => {
    if (statusPopover.open) setSurface(null);
  }, [statusPopover.open]);

  // Presentation-only: the overview sheet keeps its last frame mounted
  // through the exit animation for either trigger (header or dock), instead
  // of unmounting the instant the semantic state closes.
  const [overviewMounted, setOverviewMounted] = useState(overviewOpen);
  const lastOverviewModeRef = useRef<"full" | "details">(overviewMode === "closed" ? "full" : overviewMode);
  if (overviewMode !== "closed") lastOverviewModeRef.current = overviewMode;
  const renderedOverviewMode = overviewMode === "closed" ? lastOverviewModeRef.current : overviewMode;

  useEffect(() => {
    if (overviewOpen) {
      setOverviewMounted(true);
      return;
    }
    if (!overviewMounted) return;
    return scheduleSurfaceExit(() => setOverviewMounted(false));
  }, [overviewMounted, overviewOpen]);

  const handleHeaderClick = () => {
    // A conversation has no agent status or model overview to show.
    if (conversation) return;
    if (attentionCue) {
      const targetId = attentionCue.sessionId;
      dismissAttentionCue();
      void openSession(targetId);
      return;
    }
    if (statusPopover.open) {
      closeSessionStatusPopover();
      setSurface("island");
      return;
    }
    setSurface((current) => current === "island" ? null : "island");
  };

  const openWorkspaceNavigation = () => {
    setSurface(null);
    const remembered = workspaceNav.lastPackageId;
    const capability = remembered
      ? capabilities.find(({ descriptor: capabilityDescriptor }) => capabilityDescriptor.id === remembered && capabilityDescriptor.available())
      : undefined;
    if (capability) {
      hideMobileWorkspaceHome();
      capability.descriptor.open();
      return;
    }
    showMobileWorkspaceHome();
  };

  return <>
    <div className="mobile-session-floats" data-title-mode={mobileSessionTitle} aria-label={tr("mobile.island.workspaceNavigation")}>
      <GlassIsland className="mobile-float-navigation">
        <IconButton icon={MenuIcon} label={tr("mobile.island.openNavigation")} size="lg" variant="ghost" aria-expanded={sidebarOpen} onClick={() => {
          hideMobileWorkspaceHome();
          setRailPlugin(null);
          setSidebarOpen(true);
        }} />
      </GlassIsland>
      {mobileSessionTitle !== "hidden" && <TitleContainer
        className={`mobile-session-title-island${attentionCue ? ` attention-${attentionCue.kind}` : ""}`}
        data-attention={attentionCue ? attentionCue.kind : undefined}
        data-leading-indicator={attentionCue ? "true" : undefined}
      >
        <div className="mobile-session-title-row">
          <button
            type="button"
            className="mobile-session-selector"
            data-conversation={conversation ? "" : undefined}
            aria-label={
              conversation
                ? title
                : attentionCue
                  ? `${attentionCue.sessionTitle} · ${attentionCue.label}`
                  : tr("mobile.island.openOverview", { label: title })
            }
            aria-haspopup={conversation ? undefined : "dialog"}
            aria-expanded={overviewOpen}
            onClick={handleHeaderClick}
          >
            {attentionCue && <span className={`mobile-island-dot ${attentionCue.kind}`} aria-hidden="true" />}
            <span
              key={
                attentionCue
                  ? `cue:${attentionCue.key}`
                  : (taskProgressTitle?.key ?? `title:${session?.id ?? "new"}`)
              }
              className={`mobile-island-text${
                attentionCue
                  ? ` attention-${attentionCue.kind}`
                  : (taskProgressTitle ? ` task-progress ${taskProgressTitle.tone}` : "")
              }`}
            >
              <span className="mobile-island-title-text">{activeTitleText}</span>
              {!attentionCue && (
                <span className="session-header-status">
                  <SlotHost
                    slot="session.header.status"
                    context={{ projectId: projectId ?? null, sessionId: session?.id ?? null, workspaceMode: "chat" }}
                  />
                </span>
              )}
              {!attentionCue && !conversation && session?.sharing?.owner && (
                // The phone title row has room for the name only; its label says whose.
                <span className="mobile-island-owner" title={tr("sharing.sharedBy", { name: ownerName(session.sharing.owner) })}>
                  <span className="sr-only">{tr("sharing.sharedBy", { name: ownerName(session.sharing.owner) })}</span>
                  <span aria-hidden="true">{ownerName(session.sharing.owner)}</span>
                </span>
              )}
            </span>
            {!conversation && <span className="mobile-session-selector-arrow" aria-hidden="true"><Icon.chevronDown /></span>}
          </button>
        </div>
      </TitleContainer>}
      {attentionCue && <span className="sr-only" role="status" aria-live="assertive">{activeTitleText}</span>}
      {!attentionCue && taskProgressTitle && <span className="sr-only" role="status" aria-live="polite">{displayedTitle}</span>}
      {heroEditing ? <GlassIsland className="mobile-float-actions mobile-float-done">
        <Button variant="ghost" size="sm" onClick={() => setHeroEditing(false)}>{tr("common.done")}</Button>
      </GlassIsland> : <GlassIsland className="mobile-float-actions">
        <IconButton icon={ComposeIcon} label={tr("mobile.island.newSession")} size="lg" variant="ghost" disabled={!projectId} onClick={() => {
          hideMobileWorkspaceHome();
          if (projectId) startFreshSession(projectId);
        }} />
        <IconButton icon={LayersIcon} label={tr("mobile.island.openTools")} size="lg" variant="ghost" data-workspace-trigger="" aria-expanded={workspaceNav.homeOpen} onClick={openWorkspaceNavigation} />
      </GlassIsland>}
    </div>
    {(overviewOpen || overviewMounted) && (
      <SessionQuickAccessSheet
        active={active}
        activeTotal={active.length}
        fullScreen={renderedOverviewMode === "full"}
        activeSession={session}
        gauge={gauge}
        contextPercent={contextPercent}
        contextNotice={contextNotice}
        modelName={modelName}
        model={model}
        sessionTitle={title}
        prompt={prompt}
        tasks={overviewTasks}
        requests={requests}
        recent={recent}
        recentTotal={recentTotal}
        recentTotalIncomplete={pages.hasMore}
        hasMoreRecent={hasMoreRecent}
        isLoadingMore={pages.busy}
        onLoadMore={() => {
          setRecentVisibleLimit((current) => current + ISLAND_RECENT_LIMIT);
          if (recent.length >= recentTotal) void pages.more();
        }}
        pinnedSessions={pinnedSessions}
        onSessionChanged={() => { if (projectId) void refreshSessions(projectId); }}
        events={events}
        closing={!overviewOpen}
        onClose={() => {
          setSurface(null);
          closeSessionStatusPopover();
        }}
      />
    )}
  </>;
}
