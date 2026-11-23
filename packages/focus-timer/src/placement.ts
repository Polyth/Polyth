// Where the floating window sits. Its place is kept as a fraction of the free
// room inside the chat column (0 = start edge, 1 = end edge), not as pixels,
// so it stays in the same corner of Chat when the window is resized, a side
// pane narrows Chat or the layout switches to a phone.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Margins kept between the card and the chat column's edges. */
export interface Insets {
  start: number;
  top: number;
  end: number;
  bottom: number;
}

/** Fractions of the free room; `x` follows the reading direction's start. */
export interface Anchor {
  x: number;
  y: number;
}

/** Top end corner of Chat, under its header: beside the conversation and
 *  clear of the composer. */
export const DEFAULT_ANCHOR: Readonly<Anchor> = Object.freeze({ x: 1, y: 0 });

/** A drop this close to an edge lands on it. */
export const SNAP_PX = 28;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

export function parseAnchor(raw: unknown): Anchor {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ANCHOR };
  const value = raw as Record<string, unknown>;
  return {
    x: typeof value.x === "number" ? clamp01(value.x) : DEFAULT_ANCHOR.x,
    y: typeof value.y === "number" ? clamp01(value.y) : DEFAULT_ANCHOR.y,
  };
}

interface Room {
  minLeft: number;
  minTop: number;
  spanX: number;
  spanY: number;
}

function room(frame: Rect, card: Size, inset: Insets, rtl: boolean): Room {
  const left = rtl ? inset.end : inset.start;
  const right = rtl ? inset.start : inset.end;
  const minLeft = frame.left + left;
  const minTop = frame.top + inset.top;
  const spanX = Math.max(0, frame.width - left - right - card.width);
  const spanY = Math.max(0, frame.height - inset.top - inset.bottom - card.height);
  return { minLeft, minTop, spanX, spanY };
}

/** Top-left pixel position of the card for an anchor. `rtl` mirrors `x`
 *  and the inline insets. */
export function placeCard(frame: Rect, card: Size, anchor: Anchor, inset: Insets, rtl = false): { left: number; top: number } {
  const r = room(frame, card, inset, rtl);
  const x = rtl ? 1 - anchor.x : anchor.x;
  return {
    left: Math.round(r.minLeft + r.spanX * clamp01(x)),
    top: Math.round(r.minTop + r.spanY * clamp01(anchor.y)),
  };
}

/** The anchor for a card dropped at `left`/`top`, snapped to an edge when the
 *  drop is within `SNAP_PX` of it. */
export function anchorAt(frame: Rect, card: Size, left: number, top: number, inset: Insets, rtl = false): Anchor {
  const r = room(frame, card, inset, rtl);
  const fraction = (offset: number, span: number): number => {
    if (span <= 0) return 0;
    if (offset <= SNAP_PX) return 0;
    if (offset >= span - SNAP_PX) return 1;
    return clamp01(offset / span);
  };
  const x = fraction(left - r.minLeft, r.spanX);
  const y = fraction(top - r.minTop, r.spanY);
  return { x: rtl ? 1 - x : x, y };
}

/** Keep a dragged card inside the frame while it moves. */
export function clampPosition(frame: Rect, card: Size, left: number, top: number, inset: Insets, rtl = false): { left: number; top: number } {
  const r = room(frame, card, inset, rtl);
  return {
    left: Math.round(Math.min(r.minLeft + r.spanX, Math.max(r.minLeft, left))),
    top: Math.round(Math.min(r.minTop + r.spanY, Math.max(r.minTop, top))),
  };
}
