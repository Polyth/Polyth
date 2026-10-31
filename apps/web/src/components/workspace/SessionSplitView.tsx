// Split sessions view (sessionSplit.ts owns the state). The host always wraps
// the one live chat surface in the same pane element, so opening, closing or
// swapping the split never remounts the composer or its transcript; places
// are CSS `order`, not React positions. The companion pane renders a
// background chat through the same Timeline (timelineSession.ts) and becomes
// the focused chat on a click — its controls never act on another chat.
//
// Motion stays on the compositor: the focused chat glides (FLIP translate) to
// its new place while the companion slides in; closing leaves an exit ghost
// of the companion; a focus change lifts the composer into its new pane.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { SessionProjection } from "@polyth/contracts";
import Timeline from "../Timeline.tsx";
import { focusComposer, pinSessionCache, setUiError, useSessionModel, useStore } from "../../store.ts";
import { openSession, refreshBackgroundSession } from "../../init.ts";
import {
  closeSessionSplit,
  companionSessionId,
  dropSplitSession,
  fitSplitRatio,
  getSessionSplit,
  openSessionInSplit,
  otherSide,
  setSessionSplitRatio,
  splitFits,
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  splitTransition,
  swapSessionSplit,
  useSessionSplit,
  type SplitSide,
  type SplitSnapshot,
  type SplitTransition,
} from "../../sessionSplit.ts";
import { TimelineSessionProvider } from "../../timelineSession.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { useElementWidth } from "../../useElementWidth.ts";
import { resolveSessionStatus, type SessionStatusKind } from "../../sessionStatus.ts";
import { displaySessionTitle } from "../../format.ts";
import { tr } from "../../i18n/index.ts";
import { motionIsReduced } from "../../motionPresence.ts";
import { useExitGhost } from "../../exitGhost.ts";
import { friendlyError } from "../../settings.ts";
import { getDragSession, hasDragSession } from "../../dnd.ts";
import { CloseIcon, HandoffIcon, Icon as UiIcon, IconButton, ReplyIcon } from "../ui/index.ts";
import "./SessionSplitView.css";

/** The window glide (tokens.css --motion-window*): one clock for the panes. */
const GLIDE_MS = 340;
const GLIDE_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const LIFT_MS = 260;
/** A pane is focused by a click, not by the end of a text-selection drag. */
const CLICK_SLOP_PX = 6;
/** Live polling cadence while the companion's agent works (socket follows only the focused chat). */
const LIVE_REFRESH_MS = 1200;

function isLiveStatus(session: SessionProjection | undefined): boolean {
  return session?.status === "working" || session?.status === "waiting";
}

function statusTone(kind: SessionStatusKind): "working" | "attention" | "failed" | "idle" {
  if (kind === "working" || kind === "reconciling" || kind === "epoch-pending") return "working";
  if (kind === "needs-approval" || kind === "needs-reply" || kind === "rate-limited" || kind === "resume-ready") return "attention";
  if (kind === "failed") return "failed";
  return "idle";
}

function sessionTitleOf(session: SessionProjection | undefined, sessionId: string | null): string {
  if (!sessionId) return tr("split.newChat");
  return displaySessionTitle(session?.title ?? "", sessionId);
}

/** Focus a chat shown in split view: it becomes the active chat in place. */
function focusSplitSession(sessionId: string): void {
  void openSession(sessionId)
    .then(() => {
      // A pointer user meets a ready composer; touch keeps its keyboard down.
      if (typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches) focusComposer();
    })
    .catch((error: unknown) => setUiError(friendlyError(tr("common.error"), error)));
}

/** Keep the companion's history cached and current. The socket follows only
 *  the active chat, so the pane reads the suffix whenever its projection
 *  moves, and on a short cadence while its agent works. */
function useCompanionFeed(sessionId: string, session: SessionProjection | undefined): "ready" | "loading" | "failed" {
  const cached = useStore((state) => state.events[sessionId] !== undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => pinSessionCache(sessionId), [sessionId]);
  const inFlight = useRef(false);
  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    refreshBackgroundSession(sessionId)
      .then(() => setFailed(false))
      .catch((error: unknown) => {
        if ((error as { status?: number }).status === 404) dropSplitSession(sessionId);
        else setFailed(true);
      })
      .finally(() => { inFlight.current = false; });
  }, [sessionId]);
  const stamp = session ? `${session.updatedAt}:${session.status}:${session.lastTurnAt ?? ""}` : "";
  useEffect(() => { refresh(); }, [refresh, stamp]);
  const live = isLiveStatus(session);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") refresh();
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);
  return cached ? "ready" : failed ? "failed" : "loading";
}

function SplitPaneHeader({ sessionId, focused, onClose }: {
  sessionId: string | null;
  focused: boolean;
  onClose: () => void;
}) {
  const session = useStore((state) => sessionId ? state.sessions.find((candidate) => candidate.id === sessionId) : undefined);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const projectName = useStore((state) => {
    if (!session || session.projectId === state.activeProjectId) return null;
    return state.projectRegistry.projects.find((project) => project.id === session.projectId)?.name ?? null;
  });
  const status = session ? resolveSessionStatus(session) : null;
  const title = sessionTitleOf(session, sessionId);
  return (
    <header className="session-split-header" data-focused={focused ? "true" : undefined}>
      <span
        className="session-split-status"
        data-tone={status ? statusTone(status.kind) : "idle"}
        role={status && status.kind !== "regular" ? "img" : undefined}
        aria-label={status && status.kind !== "regular" ? status.label : undefined}
        title={status?.label}
      />
      <span className="session-split-title" title={title}>{title}</span>
      {projectName && activeProjectId && <span className="session-split-project">{projectName}</span>}
      <span className="session-split-actions">
        <IconButton icon={HandoffIcon} size="sm" variant="ghost" label={tr("split.swapSides")} onClick={(event) => { event.stopPropagation(); swapSessionSplit(); }} />
        <IconButton
          icon={CloseIcon}
          size="sm"
          variant="ghost"
          label={focused ? tr("split.closePane") : tr("split.close")}
          onClick={(event) => { event.stopPropagation(); onClose(); }}
        />
      </span>
    </header>
  );
}

function CompanionPane({ sessionId, side, enter: arrival, paneRef }: {
  sessionId: string;
  side: SplitSide;
  enter: SplitTransition;
  paneRef: (node: HTMLDivElement | null) => void;
}) {
  // How it arrived plays once: a later render must not restart the motion.
  const [enter] = useState(arrival);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const feed = useCompanionFeed(sessionId, session);
  const model = useSessionModel(sessionId);
  const status = session ? resolveSessionStatus(session) : null;
  const tone = status ? statusTone(status.kind) : "idle";
  const title = sessionTitleOf(session, sessionId);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  // Any click inside the companion focuses it and goes no further: its rows
  // would otherwise act while another chat is still the active one. Scrolling
  // and selecting text stay free.
  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(".session-split-header .session-split-actions")) return;
    event.preventDefault();
    event.stopPropagation();
    const start = pointerStart.current;
    pointerStart.current = null;
    const moved = start !== null && event.detail > 0
      && Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX;
    const selection = typeof document.getSelection === "function" ? document.getSelection() : null;
    const selecting = selection !== null && !selection.isCollapsed
      && event.currentTarget.contains(selection.anchorNode);
    if (moved || selecting) return;
    focusSplitSession(sessionId);
  };

  return (
    <div
      ref={paneRef}
      className="session-split-pane"
      data-role="companion"
      data-side={side}
      data-enter={enter}
      style={{ order: side === 0 ? 0 : 2 }}
      role="region"
      aria-label={tr("split.companionPane", { title })}
      onPointerDownCapture={onPointerDownCapture}
      onClickCapture={onClickCapture}
    >
      <SplitPaneHeader sessionId={sessionId} focused={false} onClose={closeSessionSplit} />
      <TimelineSessionProvider sessionId={sessionId} companion>
        <div className="focus-conversation session-split-companion">
          <div className="timeline-wrap">
            {feed === "ready"
              ? <Timeline model={model} />
              : (
                <div className="session-split-placeholder" role="status">
                  {feed === "failed" ? tr("split.unavailable") : (
                    <>
                      <span className="session-split-skeleton" />
                      <span className="session-split-skeleton" />
                      <span className="session-split-skeleton short" />
                      <span className="sr-only">{tr("split.loading")}</span>
                    </>
                  )}
                </div>
              )}
          </div>
          <div className="conversation-composer-dock session-split-ghost-dock">
            <button type="button" className="session-split-ghost" data-tone={tone}>
              <span className="session-split-ghost-icon" aria-hidden="true"><UiIcon icon={ReplyIcon} size="sm" /></span>
              <span className="session-split-ghost-text">{tr("split.replyHere")}</span>
              {status && tone !== "idle"
                ? <span className="session-split-ghost-status" data-tone={tone}>{status.label}</span>
                : <span className="session-split-ghost-hint">{tr("split.clickToFocus")}</span>}
            </button>
          </div>
        </div>
      </TimelineSessionProvider>
    </div>
  );
}

function SplitDivider({ hostRef, ratio, onResizing }: {
  hostRef: { current: HTMLDivElement | null };
  ratio: number;
  onResizing: (resizing: boolean) => void;
}) {
  const drag = useRef<{ pointerId: number; ratio: number } | null>(null);
  const ratioFromPointer = (clientX: number): number | null => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const rtl = getComputedStyle(host).direction === "rtl";
    const start = rtl ? rect.right - clientX : clientX - rect.left;
    return fitSplitRatio(start / rect.width, rect.width);
  };
  const width = () => hostRef.current?.getBoundingClientRect().width ?? 0;
  const commit = (next: number) => setSessionSplitRatio(fitSplitRatio(next, width()), { remember: true });

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, ratio };
    onResizing(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const next = ratioFromPointer(event.clientX);
    if (next === null) return;
    drag.current.ratio = next;
    // Live drag writes the variable directly: one style change per frame, no
    // React render of two transcripts per pointer move.
    hostRef.current?.style.setProperty("--split-ratio", String(next));
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const next = drag.current.ratio;
    drag.current = null;
    onResizing(false);
    commit(next);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rtl = hostRef.current ? getComputedStyle(hostRef.current).direction === "rtl" : false;
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = ratio + (rtl ? step : -step);
    else if (event.key === "ArrowRight") next = ratio + (rtl ? -step : step);
    else if (event.key === "Home") next = SPLIT_RATIO_MIN;
    else if (event.key === "End") next = SPLIT_RATIO_MAX;
    else if (event.key === "Enter") next = SPLIT_RATIO_DEFAULT;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  };

  return (
    <div
      className="session-split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={tr("split.resize")}
      aria-valuemin={Math.round(SPLIT_RATIO_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_RATIO_MAX * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      style={{ order: 1 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => commit(SPLIT_RATIO_DEFAULT)}
      onKeyDown={onKeyDown}
    >
      <span className="session-split-divider-grip" aria-hidden="true" />
    </div>
  );
}

type DropZone = "end" | "companion";

/** Center of a rect relative to the host's start edge. */
function centerOf(rect: DOMRect): number {
  return rect.left + rect.width / 2;
}

export default function SessionSplitHost({ focused }: { focused: ReactNode }) {
  const split = useSessionSplit();
  const shell = useShellMode();
  const activeSessionId = useStore((state) => state.activeSessionId);
  const hostRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(hostRef) ?? 0;
  const companion = companionSessionId(split);
  const shown = split !== null && companion !== null && shell !== "phone" && splitFits(width);
  const focusedSide: SplitSide = split?.focused ?? 0;
  const ratio = split ? fitSplitRatio(split.ratio, width) : SPLIT_RATIO_DEFAULT;
  const [resizing, setResizing] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);

  // What this render changed: the split opened or closed, focus moved to the
  // other chat in place, the chats traded places, or a new chat took the
  // companion's place.
  const previous = useRef<SplitSnapshot>({ shown: false, companion: null, focusedSide, focusedId: activeSessionId });
  const transition = splitTransition(previous.current, { shown, companion, focusedSide, focusedId: activeSessionId });
  // Read by the companion's exit ghost while React detaches it.
  const closing = useRef(false);
  closing.current = transition === "close";
  const companionRect = useRef<{ start: number; width: number } | null>(null);
  const companionRef = useExitGhost<HTMLDivElement>(() => {
    const rect = companionRect.current;
    if (!closing.current || !rect) return null;
    return {
      kind: "session-split-companion",
      vars: { "--split-ghost-start": `${rect.start}px`, "--split-ghost-width": `${rect.width}px` },
    };
  });

  // FLIP across a layout change: measure where each chat was, let the new
  // layout land, glide from there. Opening and closing move the focused chat;
  // trading places moves both.
  const lastRects = useRef<{ focused: DOMRect | null; companion: DOMRect | null }>({ focused: null, companion: null });
  useLayoutEffect(() => {
    const pane = focusedRef.current;
    const host = hostRef.current;
    if (!pane || !host) return;
    const was = previous.current;
    previous.current = { shown, companion, focusedSide, focusedId: activeSessionId };
    const companionNode = host.querySelector<HTMLElement>(":scope > .session-split-pane[data-role='companion']:not([data-exit-ghost])");
    const next = { focused: pane.getBoundingClientRect(), companion: companionNode?.getBoundingClientRect() ?? null };
    const before = lastRects.current;
    lastRects.current = next;
    if (next.companion) {
      const hostRect = host.getBoundingClientRect();
      const rtl = getComputedStyle(host).direction === "rtl";
      companionRect.current = {
        start: rtl ? hostRect.right - next.companion.right : next.companion.left - hostRect.left,
        width: next.companion.width,
      };
    }
    const kind = splitTransition(was, previous.current);
    if (kind === null || motionIsReduced()) return;
    const glide = (node: HTMLElement, from: DOMRect | null, to: DOMRect | null) => {
      if (!from || !to || typeof node.animate !== "function") return;
      const dx = centerOf(from) - centerOf(to);
      if (Math.abs(dx) < 1) return;
      node.animate(
        [{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }],
        { duration: GLIDE_MS, easing: GLIDE_EASE },
      );
    };
    if (kind === "open" || kind === "close" || kind === "sides") glide(pane, before.focused, next.focused);
    if (kind === "sides" && companionNode) glide(companionNode, before.companion, next.companion);
    if (kind === "focus") {
      // The composer lifts into the newly focused pane.
      const dock = pane.querySelector<HTMLElement>(".conversation-composer-dock, .hero-dock");
      if (dock && typeof dock.animate === "function") {
        dock.animate(
          [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "translateY(0)" }],
          { duration: LIFT_MS, easing: GLIDE_EASE },
        );
      }
    }
  });

  useEffect(() => {
    if (!resizing) return;
    document.body.dataset.splitResizing = "true";
    return () => { delete document.body.dataset.splitResizing; };
  }, [resizing]);

  // Drag a navigator chat onto the workspace: the end half opens it beside
  // the focused chat; an open split takes it into the companion's place.
  const zoneFor = (event: ReactDragEvent<HTMLDivElement>): DropZone | null => {
    const host = hostRef.current;
    if (!host || shell === "phone" || !splitFits(host.getBoundingClientRect().width)) return null;
    if (shown) {
      const target = event.target as HTMLElement;
      return target.closest(".session-split-pane[data-role='companion']") ? "companion" : null;
    }
    const rect = host.getBoundingClientRect();
    const rtl = getComputedStyle(host).direction === "rtl";
    const fromStart = rtl ? rect.right - event.clientX : event.clientX - rect.left;
    return fromStart > rect.width * 0.5 ? "end" : null;
  };
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDragSession(event.dataTransfer)) return;
    const zone = zoneFor(event);
    if (zone) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "link";
    }
    setDropZone((current) => (current === zone ? current : zone));
  };
  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropZone(null);
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const zone = dropZone;
    setDropZone(null);
    if (!zone || !hasDragSession(event.dataTransfer)) return;
    const sessionId = getDragSession(event.dataTransfer);
    if (!sessionId) return;
    event.preventDefault();
    openSessionInSplit(sessionId);
  };

  const closeFocused = () => {
    const other = companionSessionId(getSessionSplit());
    if (!other) {
      closeSessionSplit();
      return;
    }
    // The companion takes focus in its place, then the split closes around it.
    void openSession(other)
      .catch((error: unknown) => setUiError(friendlyError(tr("common.error"), error)))
      .finally(() => closeSessionSplit());
  };

  const style = shown ? { "--split-ratio": String(ratio) } as CSSProperties : undefined;
  return (
    <div
      ref={hostRef}
      className="session-split"
      data-split={shown ? "on" : "off"}
      data-resizing={resizing ? "true" : undefined}
      style={style}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        ref={focusedRef}
        className="session-split-pane"
        data-role="focused"
        data-side={shown ? focusedSide : undefined}
        style={shown ? { order: focusedSide === 0 ? 0 : 2 } : undefined}
        role={shown ? "region" : undefined}
        aria-label={shown ? tr("split.focusedPane") : undefined}
      >
        {shown ? <SplitPaneHeader sessionId={activeSessionId} focused onClose={closeFocused} /> : null}
        {focused}
      </div>
      {shown && <SplitDivider hostRef={hostRef} ratio={ratio} onResizing={setResizing} />}
      {shown && companion && (
        <CompanionPane
          key={companion}
          sessionId={companion}
          side={otherSide(focusedSide)}
          enter={transition ?? "replace"}
          paneRef={companionRef}
        />
      )}
      {dropZone && (
        <div className="session-split-drop" data-zone={dropZone} data-side={dropZone === "companion" ? otherSide(focusedSide) : 1} aria-hidden="true">
          <span className="session-split-drop-label">{dropZone === "companion" ? tr("split.dropToReplace") : tr("split.dropToOpen")}</span>
        </div>
      )}
    </div>
  );
}
