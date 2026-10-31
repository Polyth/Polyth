import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { tr } from "../i18n/index.ts";
import {
  promptBookmarkFromOffset,
  usePromptBookmarkPosition,
  writePromptBookmarkPosition,
  type PromptBookmarkBox,
  type PromptBookmarkPosition,
} from "../promptBookmarkPosition.ts";
import { promptRowLabel, RAIL_PANEL_ROWS } from "../promptRail.ts";
import { useSessionPrompts } from "../useSessionPrompts.ts";
import { BookmarkIcon } from "./ui/icons.ts";
import { IconButton, Popover, Spinner } from "./ui/index.ts";

export interface PromptBookmarkTarget {
  id: string;
  preview: string;
  seq?: number;
}

/** Pointer travel, in CSS px, before a press becomes a drag: a slightly
 * sloppy tap must still open the history. */
const DRAG_THRESHOLD_PX = 6;
/** Distance of one Shift+Arrow nudge, the non-drag way to move the bookmark. */
const KEY_STEP_PX = 16;
const KEY_DIRECTIONS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** One press-to-release gesture, measured once at pointer-down. */
interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  /** Where inside the control the press landed, so it does not jump under the finger. */
  grabX: number;
  grabY: number;
  area: DOMRect;
  size: PromptBookmarkBox;
  rtl: boolean;
  from: PromptBookmarkPosition;
  moved: boolean;
}

/** Prompt-only pages in the same material and rows as the desktop navigator.
 * At most eight rows render, regardless of transcript length. The toggle can be
 * dragged anywhere in the conversation viewport; its placement is remembered
 * on this device (see promptBookmarkPosition.ts). `narrow`/`wide` say which
 * side of the rail breakpoint shows it; CSS hides it on the other. */
export default function PromptBookmark({ sessionId, spaceId, revision, prompt, narrow = true, wide = true, onJump, onCancelJump }: {
  sessionId: string | null;
  spaceId?: string;
  revision: string;
  prompt: PromptBookmarkTarget | null;
  narrow?: boolean;
  wide?: boolean;
  onJump: (prompt: PromptBookmarkTarget) => Promise<void>;
  onCancelJump: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const freeArea = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const jumpGeneration = useRef(0);
  const drag = useRef<Drag | null>(null);
  const dragPosition = useRef<PromptBookmarkPosition | null>(null);
  const swallowClick = useRef(false);
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [jumping, setJumping] = useState<string | null>(null);
  const [jumpError, setJumpError] = useState(false);
  const [live, setLive] = useState<PromptBookmarkPosition | null>(null);
  const saved = usePromptBookmarkPosition();
  const position = live ?? saved;
  const history = useSessionPrompts({ sessionId, spaceId, revision, open });
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setOffset(0); }, [revision]);

  const prompts = history.loaded ? history.prompts : prompt ? [prompt] : [];
  const end = Math.max(0, prompts.length - offset);
  const start = Math.max(0, end - RAIL_PANEL_ROWS);
  const rows = prompts.slice(start, end);
  const close = () => {
    jumpGeneration.current += 1;
    onCancelJump();
    setJumping(null);
    setOpen(false);
    anchor.current?.focus();
  };
  const jump = async (target: PromptBookmarkTarget) => {
    const generation = ++jumpGeneration.current;
    setJumping(target.id);
    setJumpError(false);
    try {
      await onJump(target);
      if (alive.current && generation === jumpGeneration.current) setOpen(false);
    } catch {
      if (alive.current && generation === jumpGeneration.current) setJumpError(true);
    } finally {
      if (alive.current && generation === jumpGeneration.current) setJumping(null);
    }
  };

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    swallowClick.current = false;
    const area = freeArea.current;
    if (open || !area || event.button !== 0 || !event.isPrimary) return;
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      area: area.getBoundingClientRect(),
      size: { width: rect.width, height: rect.height },
      rtl: getComputedStyle(area).direction === "rtl",
      from: position,
      moved: false,
    };
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.moved) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD_PX) return;
      current.moved = true;
      // Capture only once it is a drag, so a plain tap never depends on it.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const next = promptBookmarkFromOffset(
      { left: event.clientX - current.grabX - current.area.left, top: event.clientY - current.grabY - current.area.top },
      current.area,
      current.size,
      current.rtl,
      current.from,
    );
    dragPosition.current = next;
    setLive(next);
  };
  const endDrag = (toggle: HTMLButtonElement) => {
    const current = drag.current;
    drag.current = null;
    if (!current?.moved) return;
    if (toggle.hasPointerCapture?.(current.pointerId)) toggle.releasePointerCapture(current.pointerId);
    // The click that follows a mouse drag must not also open the history.
    swallowClick.current = true;
    const final = dragPosition.current;
    dragPosition.current = null;
    setLive(null);
    if (final) writePromptBookmarkPosition(final);
  };
  // Dragging has a pointer-free equivalent: Shift+Arrow nudges, Shift+Home resets.
  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const area = freeArea.current;
    if (open || !area || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Home") {
      event.preventDefault();
      writePromptBookmarkPosition(null);
      return;
    }
    const direction = KEY_DIRECTIONS[event.key];
    if (!direction) return;
    event.preventDefault();
    const bounds = area.getBoundingClientRect();
    const rect = event.currentTarget.getBoundingClientRect();
    writePromptBookmarkPosition(promptBookmarkFromOffset(
      { left: rect.left - bounds.left + direction.x * KEY_STEP_PX, top: rect.top - bounds.top + direction.y * KEY_STEP_PX },
      bounds,
      { width: rect.width, height: rect.height },
      getComputedStyle(area).direction === "rtl",
      position,
    ));
  };

  return (
    <div
      ref={freeArea}
      className="prompt-bookmark"
      data-open={open || undefined}
      data-dragging={live ? "true" : undefined}
      data-narrow={narrow ? undefined : "off"}
      data-wide={wide ? undefined : "off"}
      style={{ "--prompt-bookmark-x": String(position.x), "--prompt-bookmark-y": String(position.y) } as CSSProperties}
    >
      <IconButton
        ref={anchor}
        icon={BookmarkIcon}
        label={tr("messageActions.promptNavigation")}
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-describedby={hintId}
        className="prompt-bookmark-toggle"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={(event) => endDrag(event.currentTarget)}
        onPointerCancel={(event) => endDrag(event.currentTarget)}
        onLostPointerCapture={(event) => endDrag(event.currentTarget)}
        onKeyDown={moveWithKeyboard}
        onClick={(event) => {
          // Pointer clicks only: a keyboard or assistive activation (detail 0) is never swallowed.
          if (swallowClick.current && event.detail > 0) { swallowClick.current = false; return; }
          swallowClick.current = false;
          setOffset(0); setJumpError(false); if (open) close(); else setOpen(true);
        }}
      />
      <span id={hintId} className="sr-only">{tr("timeline.promptBookmarkMoveHint")}</span>
      <Popover
        open={open}
        onClose={close}
        anchorRef={anchor}
        side="left"
        align="start"
        compact
        ariaLabel={tr("messageActions.promptNavigation")}
        className="prompt-nav-panel prompt-bookmark-peek"
        initialFocus=".prompt-nav-row"
        restoreFocus={false}
      >
        <div className="prompt-bookmark-heading">{tr("messageActions.promptNavigation")}</div>
        {(start > 0 || history.hasOlder) && (
          <button type="button" className="prompt-nav-page" disabled={history.busy || jumping !== null}
            aria-label={tr("timeline.loadEarlierHistory")}
            onClick={async () => {
              if (start === 0 && !await history.loadOlder()) return;
              if (alive.current) setOffset((value) => value + rows.length);
            }}>↑</button>
        )}
        {rows.map((target) => (
          <button key={target.id} type="button" className={`prompt-nav-row prompt-bookmark-peek-button${jumping === target.id ? " current" : ""}`}
            disabled={jumping !== null}
            aria-busy={jumping === target.id || undefined}
            onClick={() => void jump(target)}>
            <span className="prompt-nav-row-text" dir="auto">{promptRowLabel(target.preview) || tr("messageActions.emptyPrompt")}</span>
            {jumping === target.id && <Spinner size="sm" />}
          </button>
        ))}
        {offset > 0 && (
          <button type="button" className="prompt-nav-page" disabled={jumping !== null}
            aria-label={tr("timeline.showLaterMessages")}
            onClick={() => setOffset((value) => Math.max(0, value - RAIL_PANEL_ROWS))}>↓</button>
        )}
        {history.busy && <div className="prompt-bookmark-status" role="status"><Spinner size="sm" />{tr("common.loading")}</div>}
        {(history.error || jumpError) && (
          <div className="prompt-bookmark-status" role="alert">
            {tr("timeline.promptHistoryFailed")}
            {history.error && <button type="button" className="prompt-nav-page" onClick={() => void history.loadOlder()}>{tr("common.retry")}</button>}
          </div>
        )}
        {history.loaded && prompts.length === 0 && <div className="prompt-bookmark-status">{tr("messageActions.emptyPrompt")}</div>}
      </Popover>
    </div>
  );
}
