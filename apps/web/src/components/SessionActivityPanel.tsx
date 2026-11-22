// The agent activity panel: what the status line above the composer opens on
// every shell (phone, tablet and desktop). It grows out of that line and folds
// back into it. It stands on the line — never over the composer, which stays
// visible and usable — spans the composer card's width and tops out under the
// conversation's own chrome (the phone's floating islands, the desktop header).
//
// The conversation owns the panel (builtinSurfaces.tsx mounts the host in the
// chat's composer dock), so it opens wherever a status line is shown, whether
// or not the header carries the session title, and it stays open when the
// line itself leaves as the turn ends. It is non-modal: a press outside (the composer
// included) closes it, the press above the line goes no further, Escape and
// Android Back close it, and focus returns to the line.
//
// Its blocks are arranged the iOS way (SessionActivityDetails.tsx): there is
// no edit button, holding a block turns editing on, and while editing the
// head's Close becomes Done.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { resolveModelContextLimit } from "@polyth/contracts/model-context";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { displayWideSessionTitle } from "../format.ts";
import { tapFeedback } from "../haptics.ts";
import { tr } from "../i18n/index.ts";
import { tasksForIsland } from "../mobileIsland.ts";
import { motionDurationMs } from "../motionPresence.ts";
import {
  contextGaugeForTelemetry,
  contextTelemetryNotice,
  contextTelemetryStatus,
  type RenderModel,
} from "../reduce.ts";
import { draftTitleSource } from "../sessionDraft.ts";
import { closeSessionStatusPopover, getSessionStatusPopover, useSessionStatusPopover } from "../sessionStatusPopover.ts";
import { overlaySessionProjection, usePendingSends, useStore } from "../store.ts";
import { useEscape } from "../useEscape.ts";
import { firstUserTextCached, lastUserTextCached } from "../utils.ts";
import SessionActivityDetails from "./SessionActivityDetails.tsx";
import { SessionSharingLine } from "./ShareSessionDialog.tsx";
import { CloseIcon, GlassDock, IconButton } from "./ui/index.ts";
import "./SessionActivityPanel.css";

// ------------------------------------------------------------------ geometry

export interface ActivityPanelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ActivityPanelGeometry {
  left: number;
  width: number;
  /** Distance from the layer's bottom edge to the panel's bottom edge. */
  bottom: number;
  maxHeight: number;
  /** The status line the panel stands on and folds into. */
  line: ActivityPanelBox;
}

/** Where the panel goes, from boxes in the layer's coordinates: on the
 *  line with `gap` between them, as wide as `frame` (the composer card),
 *  and no higher than `ceiling` plus the same gap. */
export function activityPanelGeometry({
  layerHeight,
  line,
  frame,
  ceiling,
  gap,
  minHeight = 160,
}: {
  layerHeight: number;
  line: ActivityPanelBox;
  frame: { left: number; width: number };
  ceiling: number;
  gap: number;
  minHeight?: number;
}): ActivityPanelGeometry {
  return {
    left: frame.left,
    width: frame.width,
    bottom: layerHeight - line.top + gap,
    maxHeight: Math.max(minHeight, line.top - gap - (ceiling + gap)),
    line,
  };
}

function cssPx(element: Element, property: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? value : fallback;
}

function measure(layer: HTMLElement, anchor: HTMLElement | null, conversation: HTMLElement | null): ActivityPanelGeometry | null {
  const area = layer.getBoundingClientRect();
  const composerDock = conversation?.querySelector<HTMLElement>(".conversation-composer-dock") ?? null;
  const source = anchor?.isConnected ? anchor : composerDock;
  if (!source) return null;
  const box = source.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  // The status line reaches up into the timeline for its touch target (its
  // block-start padding); the panel stands on the line itself.
  const reach = source === anchor ? Number.parseFloat(getComputedStyle(source).paddingTop) || 0 : 0;
  const line = {
    left: box.left - area.left,
    top: box.top + reach - area.top,
    right: box.right - area.left,
    bottom: box.bottom - area.top,
  };
  const card = composerDock?.querySelector<HTMLElement>(".composer-card")?.getBoundingClientRect();
  const frame = card && card.width > 0 ? card : box;
  let ceiling = Math.max(area.top, conversation?.getBoundingClientRect().top ?? area.top);
  // The phone's floating islands sit over the conversation's top edge.
  for (const chrome of document.querySelectorAll<HTMLElement>(".mobile-session-floats")) {
    const island = chrome.getBoundingClientRect();
    if (island.height > 0 && island.bottom > ceiling && island.bottom < box.top) ceiling = island.bottom;
  }
  return activityPanelGeometry({
    layerHeight: area.height,
    line,
    frame: { left: frame.left - area.left, width: frame.width },
    ceiling: ceiling - area.top,
    gap: cssPx(layer, "--space-2", 8),
  });
}

// -------------------------------------------------------------------- motion

/** The clip and lift that make the panel the status line: a strip as wide and
 *  tall as the line, standing exactly on it. Open is that strip unfolding
 *  upwards into the panel; close folds the panel back into it. */
function foldFrames(panel: HTMLElement, geometry: ActivityPanelGeometry, layerHeight: number): {
  folded: Keyframe;
  open: Keyframe;
  drop: number;
} {
  const box = panel.getBoundingClientRect();
  const { line } = geometry;
  const lineHeight = Math.max(8, line.bottom - line.top);
  const top = Math.max(0, box.height - lineHeight);
  const left = Math.min(box.width / 2, Math.max(0, line.left - geometry.left));
  const right = Math.min(box.width / 2, Math.max(0, geometry.left + geometry.width - line.right));
  const drop = Math.max(0, line.bottom - (layerHeight - geometry.bottom));
  const radius = Number.parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
  // A negative inset as wide as the shadow, so the open panel keeps it.
  const reach = 48;
  return {
    folded: { clipPath: `inset(${top}px ${right}px 0px ${left}px round ${Math.min(radius, lineHeight / 2)}px)`, transform: `translateY(${drop}px)` },
    open: { clipPath: `inset(-${reach}px round ${radius + reach}px)`, transform: "none" },
    drop,
  };
}

function cssValue(property: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(property).trim() || fallback;
}

interface PanelMotion {
  opening: boolean;
  animations: Animation[];
}

// --------------------------------------------------------------------- panel

function ActivityPanel({
  open,
  anchor,
  conversation,
  labelledBy,
  onClose,
  children,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  conversation: HTMLElement | null;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  if (anchor) anchorRef.current = anchor;
  const geometryRef = useRef<ActivityPanelGeometry | null>(null);
  const motionRef = useRef<PanelMotion | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = (): ActivityPanelGeometry | null => {
    const layer = layerRef.current;
    const panel = panelRef.current;
    if (!layer || !panel) return null;
    const geometry = measure(layer, anchorRef.current, conversation);
    if (!geometry) return geometryRef.current;
    geometryRef.current = geometry;
    panel.style.left = `${geometry.left}px`;
    panel.style.width = `${geometry.width}px`;
    panel.style.bottom = `${geometry.bottom}px`;
    panel.style.maxHeight = `${geometry.maxHeight}px`;
    layer.style.setProperty("--session-activity-line-top", `${geometry.line.top}px`);
    return geometry;
  };

  // Follow the line: the keyboard, a rotation, the composer growing a line.
  useLayoutEffect(() => {
    if (!present) return;
    place();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    for (const element of [conversation, conversation?.querySelector(".conversation-composer-dock"), anchorRef.current]) {
      if (element) observer?.observe(element);
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      observer?.disconnect();
    };
  }, [present, conversation, anchor]);

  // Out of the line and back into it. A change of mind mid-flight plays the
  // running motion back from where it is, so the panel never jumps.
  useLayoutEffect(() => {
    if (!present) return;
    const layer = layerRef.current;
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!layer || !panel || !content) return;
    const running = motionRef.current;
    if (running && running.opening !== open && running.animations.some((animation) => animation.playState === "running")) {
      running.opening = open;
      for (const animation of running.animations) animation.reverse();
      return;
    }
    for (const animation of running?.animations ?? []) animation.cancel();
    motionRef.current = null;
    const settle = () => {
      if (motionRef.current?.opening === false) {
        motionRef.current = null;
        setPresent(false);
        return;
      }
      for (const animation of motionRef.current?.animations ?? []) animation.cancel();
      motionRef.current = null;
    };
    const duration = motionDurationMs(open ? "--motion-window" : "--motion-window-exit");
    const geometry = place();
    if (duration <= 0 || !geometry || typeof panel.animate !== "function") {
      if (!open) setPresent(false);
      return;
    }
    const easing = open
      ? cssValue("--motion-window-ease", "cubic-bezier(0.16, 1, 0.3, 1)")
      : cssValue("--motion-window-exit-ease", "cubic-bezier(0.4, 0, 1, 1)");
    const { folded, open: unfolded, drop } = foldFrames(panel, geometry, layer.getBoundingClientRect().height);
    const timing: KeyframeAnimationOptions = { duration, easing, fill: "both" };
    const lift = `translateY(${Math.min(24, drop + 8)}px)`;
    const animations = open
      ? [
          panel.animate([folded, unfolded], timing),
          content.animate([
            { opacity: 0, transform: lift, offset: 0 },
            { opacity: 0, offset: 0.28 },
            { opacity: 1, transform: "none", offset: 1 },
          ], timing),
        ]
      : [
          panel.animate([unfolded, folded], timing),
          content.animate([
            { opacity: 1, transform: "none", offset: 0 },
            { opacity: 0, offset: 0.55 },
            { opacity: 0, transform: lift, offset: 1 },
          ], timing),
        ];
    const scrim = scrimRef.current;
    if (scrim) animations.push(scrim.animate(open ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], timing));
    motionRef.current = { opening: open, animations };
    animations[0]!.onfinish = settle;
  }, [open, present]);

  useEffect(() => () => {
    for (const animation of motionRef.current?.animations ?? []) animation.cancel();
  }, []);

  useEscape(open, () => onCloseRef.current());

  // Focus moves into the panel; closing with focus inside gives it back to
  // the status line it came from. (A closing panel only stops taking presses,
  // CSS `data-state`, so focus is still inside when this runs.)
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });
    return () => {
      if (!panel?.contains(document.activeElement)) return;
      const line = anchorRef.current;
      if (line?.isConnected) line.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
    };
  }, [open]);

  // A press anywhere else closes it. The status line toggles it itself, and a
  // sheet or dialog opened from the panel (sharing) owns its own presses.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      if (target.closest?.(".sheet-backdrop, .ui-popover, .ui-popover-backdrop, .dialog-backdrop, .ui-dialog")) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (!present || typeof document === "undefined") return null;
  return createPortal(
    <div ref={layerRef} className="session-activity-layer" data-state={open ? "open" : "closing"}>
      <div
        ref={scrimRef}
        className="session-activity-scrim"
        aria-hidden="true"
        // The press closes the panel (the document listener); what lies under
        // the scrim never receives it.
        onClick={(event) => event.preventDefault()}
      />
      <GlassDock
        ref={panelRef}
        strength="strong"
        className="session-activity-panel"
        role="dialog"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        <div ref={contentRef} className="session-activity-panel-content">{children}</div>
      </GlassDock>
    </div>,
    document.body,
  );
}

/** Measure unclamped text so the largest readable size fits in two lines. */
function SessionActivityTitle({ id, title }: { id: string; title: string }) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    let disposed = false;
    const fit = () => {
      if (disposed || element.clientWidth === 0) return;
      element.style.removeProperty("font-size");
      const preferredSize = Number.parseFloat(getComputedStyle(element).fontSize);
      // Resolve the floor through CSS, including the user's text-size setting.
      element.style.fontSize = "var(--font-label)";
      const minimumSize = Math.min(preferredSize, Number.parseFloat(getComputedStyle(element).fontSize));
      element.style.webkitLineClamp = "unset";
      const fits = (size: number) => {
        element.style.fontSize = `${size}px`;
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return element.scrollHeight <= lineHeight * 2 + 1 && element.scrollWidth <= element.clientWidth;
      };
      let lower = minimumSize;
      let upper = preferredSize;
      if (fits(upper)) lower = upper;
      else {
        // A bounded search avoids a layout pass for every pixel of text size.
        for (let step = 0; step < 8; step += 1) {
          const size = (lower + upper) / 2;
          if (fits(size)) lower = size;
          else upper = size;
        }
      }
      element.style.fontSize = `${lower}px`;
      element.style.removeProperty("-webkit-line-clamp");
    };
    fit();
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    resize?.observe(element);
    // Font swaps and preference changes can change wrapping without a resize.
    const preferences = typeof MutationObserver === "function" ? new MutationObserver(fit) : null;
    preferences?.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
    document.fonts?.addEventListener("loadingdone", fit);
    void document.fonts?.ready.then(fit);
    return () => {
      disposed = true;
      resize?.disconnect();
      preferences?.disconnect();
      document.fonts?.removeEventListener("loadingdone", fit);
    };
  }, [title]);

  return <h2 ref={titleRef} id={id} className="session-activity-title" title={title}>{title}</h2>;
}

/** The panel's content for one chat, computed only while the panel shows. */
function ActivityPanelContent({
  sessionId,
  model,
  titleId,
  editing,
  onEditingChange,
  onClose,
}: {
  sessionId: string;
  model: RenderModel;
  titleId: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onClose: () => void;
}) {
  // What a mode switch brings into the head pops in; the first open does not.
  const [switched, setSwitched] = useState(false);
  const shownEditing = useRef(editing);
  if (shownEditing.current !== editing) {
    shownEditing.current = editing;
    if (!switched) setSwitched(true);
  }
  // Done leaves with the mode; focus moves on to the Close that replaces it.
  const actionsRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    actionsRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, [editing]);
  const sessionRecord = useStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const pendingSends = usePendingSends(sessionId);
  const session = overlaySessionProjection(sessionRecord, pendingSends) ?? null;
  const events = useStore((state) => state.events[sessionId]);
  const models = useStore((state) => state.models);
  const runtimeFeatures = useStore((state) => state.runtimeFeatures[sessionId]);
  const pendingModel = pendingSends[pendingSends.length - 1]?.model;
  const activeModel = pendingModel ?? model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = resolveModelPresentation(activeModel, models, session?.resolvedHarnessId).descriptor;
  const contextTokens = resolveModelContextLimit(activeModel, models, session?.resolvedHarnessId);
  const telemetryStatus = contextTelemetryStatus(runtimeFeatures?.telemetry);
  const occupancy = session?.contextWindow;
  const gauge = contextGaugeForTelemetry(model, contextTokens,
    occupancy && pendingModel ? { ...occupancy, model: model.turn?.model ?? sessionRecord?.model } : occupancy ?? null, telemetryStatus,
    { model: activeModel, harnessId: session?.resolvedHarnessId });
  const contextNotice = contextTelemetryNotice(telemetryStatus, gauge);
  const modelName = descriptor?.name ?? activeModel?.modelID ?? null;
  const title = session
    ? displayWideSessionTitle(session.title, session.titleSource, session.id, firstUserTextCached(events) ?? draftTitleSource(session))
    : "";
  const tasks = tasksForIsland(model.tasks, model.messages);

  return <>
    <header className="session-activity-panel-head" data-switched={switched ? "" : undefined}>
      <SessionActivityTitle id={titleId} title={title} />
      <div ref={actionsRef} className="session-activity-panel-actions">
        {editing ? (
          <button
            key="done"
            type="button"
            className="session-activity-done"
            onClick={() => {
              refocus.current = true;
              onEditingChange(false);
              tapFeedback();
            }}
          >
            {tr("common.done")}
          </button>
        ) : <IconButton key="close" icon={CloseIcon} label={tr("common.close")} onClick={onClose} />}
      </div>
      {session && <SessionSharingLine session={session} onOpen={onClose} />}
    </header>
    <div className="session-activity-panel-body">
      <SessionActivityDetails
        prompt={lastUserTextCached(events)}
        modelName={modelName}
        tasks={tasks}
        session={session}
        model={model}
        usageEvents={events}
        gauge={gauge}
        contextNotice={contextNotice}
        editing={editing}
        onEditingChange={onEditingChange}
      />
    </div>
  </>;
}

/** One per conversation, inside its composer dock: the panel for the status
 *  line of this chat. */
export default function SessionActivityPanelHost({ sessionId, model }: { sessionId: string | null; model: RenderModel }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const [conversation, setConversation] = useState<HTMLElement | null>(null);
  const popover = useSessionStatusPopover();
  const titleId = `${useId().replace(/:/g, "")}-activity-title`;
  const [editing, setEditing] = useState(false);

  useLayoutEffect(() => {
    setConversation(markerRef.current?.closest<HTMLElement>(".focus-conversation") ?? null);
  }, []);

  // The line that opened the panel is this chat's when it opens. It may then
  // leave (the turn ends, the live line hands over to another): the panel
  // stays, standing where the line was, until it is closed.
  const claimed = useRef<HTMLElement | null>(null);
  if (!popover.open || popover.source !== "dock") claimed.current = null;
  else if (popover.anchor?.isConnected && conversation?.contains(popover.anchor)) claimed.current = popover.anchor;
  const mine = popover.open && popover.source === "dock" && popover.anchor !== null && claimed.current === popover.anchor;

  // Every open starts outside the edit mode. Reset on the way in, not out:
  // a panel closed mid-arrangement folds away as it was, its size unchanged.
  const [shownOpen, setShownOpen] = useState(mine);
  if (shownOpen !== mine) {
    setShownOpen(mine);
    if (mine) setEditing(false);
  }

  // Another chat in this window closes this chat's panel.
  const shownSession = useRef(sessionId);
  useEffect(() => {
    if (shownSession.current === sessionId) return;
    shownSession.current = sessionId;
    const current = getSessionStatusPopover();
    if (current.source === "dock" && current.anchor && conversation?.contains(current.anchor)) closeSessionStatusPopover();
  }, [sessionId, conversation]);

  return <>
    <span ref={markerRef} className="session-activity-panel-marker" hidden />
    {sessionId && (
      <ActivityPanel
        open={mine}
        anchor={mine ? popover.anchor : null}
        conversation={conversation}
        labelledBy={titleId}
        onClose={closeSessionStatusPopover}
      >
        <ActivityPanelContent
          sessionId={sessionId}
          model={model}
          titleId={titleId}
          editing={editing}
          onEditingChange={setEditing}
          onClose={closeSessionStatusPopover}
        />
      </ActivityPanel>
    )}
  </>;
}
