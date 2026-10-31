// Direct manipulation for ordered lists: the phone Workspace editor
// (WorkspaceEditor.tsx), a grid that mixes launcher tiles, which flow several to
// a line, with full-width rows (widgets, headings, dividers), and the project
// lists of both navigators (MobileNavigator.tsx, Sidebar.tsx). Reordering lifts
// a copy of the item that follows the finger; the item's own slot stays behind
// as a hole that travels through the list while the neighbours glide aside.
//
// Smoothness is the contract, so each of these is deliberate:
//   * a pointer move never renders React: it moves the copy (one transform) and
//     re-aims. React renders only when the hole changes place;
//   * aiming reads the resting geometry measured right after that render (glides
//     in flight excluded), in the scroller's content coordinates, so scrolling
//     never invalidates it. A hysteresis margin stops a finger resting on a
//     boundary from flicking the hole back and forth;
//   * neighbours move by FLIP — composited transforms through Web Animations —
//     restarted from where they are on screen, so re-aiming mid-glide never jumps;
//   * the list scrolls by itself while the finger rests near an edge, and only
//     then: a lifted item's touch can never scroll it, select text, open the
//     system menu or start the browser's own drag;
//   * a held item may fold (a navigator project hides its chats); the list keeps
//     its scroll room meanwhile, so folding never slides it under the finger;
//   * the order is saved once, when the item lands, never per move.
// The engine never writes the order itself: `onCommit` persists.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { hapticFeedback, selectionFeedback } from "./haptics.ts";
import { motionDurationMs, motionIsReduced } from "./motionPresence.ts";
import { sortKeyTarget } from "./components/mobile/useSortable.ts";

export type ArrangeShape = "tile" | "row";

export interface ArrangeItem {
  id: string;
  /** A tile shares its line with other tiles; a row always fills a line. */
  shape: ArrangeShape;
}

export interface ArrangeRect extends ArrangeItem {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ArrangePoint {
  x: number;
  y: number;
}

/** A touch press lifts an item after this long without moving; a swipe still scrolls. */
export const ARRANGE_TOUCH_LIFT_MS = 220;
/** The same for a list whose rows are mostly tapped and scrolled past (the
 *  navigators' projects): a tap still opens the row, and a pause before a
 *  scroll does not pick it up. */
export const ARRANGE_LIST_LIFT_MS = 340;
/** How far past a neighbour's midpoint the finger travels before it passes it. */
export const ARRANGE_HYSTERESIS_PX = 10;
/** Finger travel that turns a pending long press into a scroll. */
const TOUCH_SLOP_PX = 8;
/** Mouse, pen, or a touch on a grip: travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;
const FLIP_ANIMATION_ID = "workspace-arrange-flip";
const SETTLE_EASE = "cubic-bezier(0.2, 0.9, 0.25, 1)";
const GHOST_STRIPPED_ATTRIBUTES = ["data-arrange-id", "data-arrange-grip", "id", "tabindex", "for", "name"];

// ---------------------------------------------------------------- pure model

/** The order on screen while `id` waits at insertion `index` among the others. */
export function arrangePreviewOrder(ids: readonly string[], id: string, index: number): string[] {
  const others = ids.filter((entry) => entry !== id);
  if (others.length === ids.length) return [...ids];
  others.splice(Math.max(0, Math.min(index, others.length)), 0, id);
  return others;
}

/**
 * Where the held item belongs when it is held at `point`: the number of the
 * other items that come before it in reading order. `others` are those items in
 * list order with their resting boxes. An item entirely above the point's line
 * comes before it; on the point's own line a tile counts once the point is past
 * its middle (inline direction) and a row once the point is below its middle.
 * `current` (the hole's present index) adds `margin` of stickiness, so the item
 * only crosses a neighbour once it is clearly past that midpoint. A positive
 * margin can never oscillate: crossing a neighbour moves it away from the point.
 */
export function arrangeInsertionIndex(
  others: readonly ArrangeRect[],
  point: ArrangePoint,
  { current = -1, margin = 0, rtl = false }: { current?: number; margin?: number; rtl?: boolean } = {},
): number {
  let index = 0;
  others.forEach((rect, position) => {
    if (point.y >= rect.top + rect.height) {
      index += 1;
      return;
    }
    if (point.y < rect.top) return;
    const centreX = rect.left + rect.width / 2;
    const past = rect.shape === "tile"
      ? (rtl ? centreX - point.x : point.x - centreX)
      : point.y - (rect.top + rect.height / 2);
    if (past > (position < current ? -margin : margin)) index += 1;
  });
  return index;
}

/**
 * Auto-scroll speed in px per frame (negative scrolls up) for a finger at `y`
 * inside a scroller whose visible band is [top, bottom]. It eases in across an
 * edge band, so a finger just inside the band creeps and one at the edge (or
 * past it, over the header) runs at `max`.
 */
export function arrangeAutoScrollSpeed(y: number, top: number, bottom: number, edge = 64, max = 18): number {
  const band = Math.min(edge, Math.max(0, (bottom - top) / 4));
  if (band <= 0) return 0;
  if (y < top + band) return -max * Math.min(1, (top + band - y) / band) ** 2;
  if (y > bottom - band) return max * Math.min(1, (y - (bottom - band)) / band) ** 2;
  return 0;
}

/** Where an arrow key sends the item at `index`, mirrored for right-to-left. */
export function arrangeKeyTarget(key: string, index: number, count: number, rtl = false): number | null {
  const mirrored = !rtl ? key : key === "ArrowLeft" ? "ArrowRight" : key === "ArrowRight" ? "ArrowLeft" : key;
  return sortKeyTarget(mirrored, index, count);
}

// ---------------------------------------------------------------- DOM helpers

function arrangeElements(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>("[data-arrange-id]")];
}

function arrangeElement(list: HTMLElement, id: string): HTMLElement | null {
  return arrangeElements(list).find((element) => element.dataset.arrangeId === id) ?? null;
}

/** `point` (viewport) in the scroller's content coordinates; `frame` is the scroller's box. */
function contentPoint(scroller: HTMLElement, frame: DOMRect, point: ArrangePoint): ArrangePoint {
  return { x: point.x - frame.left + scroller.scrollLeft, y: point.y - frame.top + scroller.scrollTop };
}

function othersGeometry(
  elements: readonly HTMLElement[],
  rects: readonly DOMRect[],
  scroller: HTMLElement,
  held: string,
  shapes: ReadonlyMap<string, ArrangeShape>,
): ArrangeRect[] {
  const frame = scroller.getBoundingClientRect();
  return elements.flatMap((element, index) => {
    const id = element.dataset.arrangeId ?? "";
    const rect = rects[index];
    if (id === held || !rect) return [];
    return [{
      id,
      shape: shapes.get(id) ?? "row",
      left: rect.left - frame.left + scroller.scrollLeft,
      top: rect.top - frame.top + scroller.scrollTop,
      width: rect.width,
      height: rect.height,
    }];
  });
}

/** Glide each element from where it was (`before`) to its resting box (`rects`)
 *  and return the glides. Every box is read before this runs: starting an
 *  animation invalidates style, so this only ever writes. */
function playFlip(elements: readonly HTMLElement[], rects: readonly DOMRect[], before: ReadonlyMap<string, DOMRect>): Animation[] {
  if (motionIsReduced()) return [];
  const duration = motionDurationMs("--motion-normal");
  if (duration <= 0) return [];
  return elements.flatMap((element, index) => {
    const to = rects[index];
    if (typeof element.animate !== "function" || !to) return [];
    const from = before.get(element.dataset.arrangeId ?? "");
    if (!from) {
      // A newcomer (an undone removal) grows in where it now sits.
      return [element.animate([{ opacity: 0, transform: "scale(0.92)" }, { opacity: 1, transform: "none" }],
        { duration, easing: SETTLE_EASE, id: FLIP_ANIMATION_ID })];
    }
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return [];
    return [element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
      { duration, easing: SETTLE_EASE, id: FLIP_ANIMATION_ID })];
  });
}

/** The lifted copy: the item's own markup, drawn in `host` exactly over it. */
function makeGhost(source: HTMLElement, origin: DOMRect, host: HTMLElement): { ghost: HTMLDivElement; body: HTMLDivElement } {
  const frame = host.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "workspace-arrange-ghost";
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    left: `${origin.left - frame.left - host.clientLeft}px`,
    top: `${origin.top - frame.top - host.clientTop}px`,
    width: `${origin.width}px`,
    height: `${origin.height}px`,
  });
  const body = document.createElement("div");
  body.className = "workspace-arrange-ghost-body";
  const clone = source.cloneNode(true) as HTMLElement;
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    for (const attribute of GHOST_STRIPPED_ATTRIBUTES) node.removeAttribute(attribute);
  }
  // Controlled fields keep their typed value only as a property.
  const sourceFields = source.querySelectorAll<HTMLInputElement>("input");
  clone.querySelectorAll<HTMLInputElement>("input").forEach((field, index) => {
    field.value = sourceFields[index]?.value ?? field.value;
    field.disabled = true;
  });
  body.append(clone);
  ghost.append(body);
  host.append(ghost);
  return { ghost, body };
}

function suppressNextClick(): void {
  const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** Does nothing. WebKit and Chromium decide when a touch begins whether its
 *  moves may still be cancelled: only if a non-passive touchmove listener
 *  covers the point. The lifted item's block is added mid-touch, so without
 *  this listener on the list a finger that lifted an item would scroll it. */
function keepTouchMovesCancelable(): void {}

// ---------------------------------------------------------------- the gesture

export interface UseArrangeOptions {
  /** The arrangeable items in their committed order. */
  items: readonly ArrangeItem[];
  enabled: boolean;
  /** The element that scrolls the list. */
  scroller(): HTMLElement | null;
  /** A positioned element covering the list whose styles reach the copied item. */
  ghostHost(): HTMLElement | null;
  /** Persist a new order of `items`; `id` is the item that moved. */
  onCommit(order: string[], id: string): void;
  /** The held item's hole moved (live, mid-drag); rendered with that move. */
  onMove?(id: string, index: number, count: number): void;
  /** How long a still touch press waits before it lifts (default `ARRANGE_TOUCH_LIFT_MS`). */
  touchLiftMs?: number;
  /** The part of an item the lifted copy shows (default: the whole item). A
   *  list whose held item folds while it is up (the navigator's project, which
   *  hides its chats) lifts only its header. */
  ghostSource?(item: HTMLElement): HTMLElement | null;
}

/** Handlers with a stable identity for the life of the list, so memoized items keep skipping renders mid-drag. */
export interface ArrangeEngine {
  /** Ref for the element whose descendants carry `data-arrange-id`. */
  listRef(element: HTMLElement | null): void;
  /** Spread on each item element. */
  itemProps(id: string): {
    "data-arrange-id": string;
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  };
  /** Spread on an item's grip: a touch drags at once, arrow keys move it. */
  gripProps(id: string): {
    "data-arrange-grip": "";
    onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
  };
  /** Arrow keys move the item one place, Home/End to an end. */
  onArrangeKey(id: string, event: ReactKeyboardEvent<HTMLElement>): void;
  /** Call just before any other change to the list so that change glides too. */
  animateNextLayout(): void;
}

export interface ArrangeController {
  engine: ArrangeEngine;
  /** Ids as drawn: the held item at its hole. */
  order: string[];
  /** The held item while a drag is on. */
  draggingId: string | null;
}

interface Session {
  id: string;
  shape: ArrangeShape;
  pointerId: number;
  touch: boolean;
  rtl: boolean;
  host: HTMLElement;
  /** The scroller's box, measured at lift: it does not move during a drag (only its content scrolls). */
  frame: DOMRect;
  ghost: HTMLDivElement;
  body: HTMLDivElement;
  origin: DOMRect;
  grabX: number;
  grabY: number;
  pointer: ArrangePoint;
  startIndex: number;
  index: number;
  /** Resting boxes of the other items; null until measured after a render. */
  others: ArrangeRect[] | null;
  moveFrame: number;
  scrollFrame: number;
  lastX: number;
  tilt: number;
  landing: boolean;
  /** The scroller's own inline `padding-block-end` while the engine holds room there. */
  heldPadding: string | null;
  detach(): void;
}

type DragState = { id: string; index: number } | null;

interface EngineInternals extends ArrangeEngine {
  /** After every render: re-measure for a drag, then glide what moved. */
  afterRender(): void;
  /** End a drag that lost its item or its editing mode. */
  reconcile(enabled: boolean, ids: readonly string[]): void;
  dispose(): void;
}

function createArrangeEngine(
  latest: { readonly current: UseArrangeOptions },
  setDrag: (drag: DragState) => void,
): EngineInternals {
  let list: HTMLElement | null = null;
  let session: Session | null = null;
  let pendingPress: (() => void) | null = null;
  let flipFrom: Map<string, DOMRect> | null = null;
  // Where the list was scrolled when the item went up, until the lift has
  // rendered (see `keepScrollRoom`).
  let liftScrollTop: number | null = null;
  // The glides this engine started. Cancelled by reference: asking the
  // document for its animations would flush style on every move.
  let flips: Animation[] = [];
  const cancelFlips = (target?: Element): void => {
    flips = flips.filter((animation) => {
      if (target && (animation.effect as KeyframeEffect | null)?.target !== target) return true;
      animation.cancel();
      return false;
    });
  };

  const snapshot = (): void => {
    if (!list) return;
    flipFrom = new Map(arrangeElements(list).map((item) => [item.dataset.arrangeId ?? "", item.getBoundingClientRect()]));
  };

  /** A held item that folds (see `ghostSource`) shortens the list. Scrolled to
   *  its end, the shorter list would slide down under the finger, so it keeps
   *  the room it had, as end padding, until the item is set down. */
  const keepScrollRoom = (live: Session, scroller: HTMLElement, scrollTop: number): void => {
    const short = scrollTop + scroller.clientHeight - scroller.scrollHeight;
    if (short < 0.5) return;
    live.heldPadding = scroller.style.paddingBlockEnd;
    const own = getComputedStyle(scroller).paddingBlockEnd || "0px";
    scroller.style.paddingBlockEnd = `calc(${own} + ${short}px)`;
    scroller.scrollTop = scrollTop;
  };

  const paint = (live: Session): void => {
    const { x, y } = live.pointer;
    // A full-width row only travels up and down, like a list row; the finger's
    // inline position still aims (it picks where a row splits a line of tiles).
    const dx = live.shape === "tile" ? x - live.grabX - live.origin.left : 0;
    if (live.shape === "tile") {
      // A tile leans into a sideways flick like a picked-up card, then settles.
      const velocity = x - live.lastX;
      live.lastX = x;
      live.tilt = live.tilt * 0.7 + Math.max(-5, Math.min(5, velocity * 0.6)) * 0.3;
    }
    live.ghost.style.transform = `translate3d(${dx}px, ${y - live.grabY - live.origin.top}px, 0) rotate(${live.tilt.toFixed(2)}deg)`;
  };

  const moveHole = (live: Session, index: number): void => {
    if (index === live.index) return;
    live.index = index;
    live.others = null;
    snapshot();
    // One render for the new hole and whatever the move announces.
    flushSync(() => {
      setDrag({ id: live.id, index });
      latest.current.onMove?.(live.id, index, latest.current.items.length);
    });
    if (live.touch) selectionFeedback();
  };

  const aim = (live: Session): void => {
    const scroller = latest.current.scroller();
    if (!scroller || !live.others || live.landing) return;
    // Aim with the lifted item's centre, wherever on it the finger holds it; a
    // row (which only travels vertically) takes the finger's inline position.
    const centre = {
      x: live.shape === "tile" ? live.pointer.x - live.grabX + live.origin.width / 2 : live.pointer.x,
      y: live.pointer.y - live.grabY + live.origin.height / 2,
    };
    moveHole(live, arrangeInsertionIndex(live.others, contentPoint(scroller, live.frame, centre), {
      current: live.index,
      margin: ARRANGE_HYSTERESIS_PX,
      rtl: live.rtl,
    }));
  };

  const track = (x: number, y: number): void => {
    const live = session;
    if (!live || live.landing) return;
    live.pointer = { x, y };
    if (live.moveFrame) return;
    live.moveFrame = requestAnimationFrame(() => {
      live.moveFrame = 0;
      if (session !== live || live.landing) return;
      paint(live);
      aim(live);
    });
  };

  const autoScroll = (live: Session): void => {
    const step = (): void => {
      if (session !== live || live.landing) return;
      const scroller = latest.current.scroller();
      if (scroller) {
        const speed = arrangeAutoScrollSpeed(live.pointer.y, live.frame.top, live.frame.bottom);
        if (Math.abs(speed) >= 0.5) {
          const before = scroller.scrollTop;
          scroller.scrollTop = before + speed;
          if (scroller.scrollTop !== before) aim(live);
        }
      }
      live.scrollFrame = requestAnimationFrame(step);
    };
    live.scrollFrame = requestAnimationFrame(step);
  };

  const stopFrames = (live: Session): void => {
    if (live.moveFrame) cancelAnimationFrame(live.moveFrame);
    if (live.scrollFrame) cancelAnimationFrame(live.scrollFrame);
    live.moveFrame = 0;
    live.scrollFrame = 0;
  };

  const release = (live: Session): void => {
    live.ghost.remove();
    if (session === live) session = null;
    delete live.host.dataset.arrangeDragging;
    const scroller = latest.current.scroller();
    scroller?.style.removeProperty("scroll-behavior");
    scroller?.style.removeProperty("overflow-anchor");
    // The held item has unfolded again, so the room it kept is its own once more.
    if (scroller && live.heldPadding !== null) scroller.style.paddingBlockEnd = live.heldPadding;
  };

  const finish = (drop: boolean): void => {
    const live = session;
    if (!live || live.landing) return;
    stopFrames(live);
    live.detach();
    if (drop) {
      // A move still waiting for its frame decides where the item lands.
      paint(live);
      aim(live);
    } else if (live.index !== live.startIndex) {
      live.others = null;
      live.index = live.startIndex;
      snapshot();
      flushSync(() => setDrag({ id: live.id, index: live.startIndex }));
    }
    live.landing = true;
    const hole = list ? arrangeElement(list, live.id) : null;

    const settle = (): void => {
      if (session !== live) return;
      const committed = latest.current.items.map((item) => item.id);
      const next = arrangePreviewOrder(committed, live.id, live.index);
      const moved = committed.includes(live.id) && next.some((id, index) => id !== committed[index]);
      // ...and opens again by gliding when it is set down.
      snapshot();
      flushSync(() => {
        setDrag(null);
        if (drop && moved) latest.current.onCommit(next, live.id);
      });
      release(live);
      // A move that was kept lands with a tap, as it was picked up with one.
      if (drop && moved && live.touch) hapticFeedback("tap");
    };

    const duration = motionDurationMs("--motion-surface");
    if (!hole || duration <= 0 || typeof live.ghost.animate !== "function") {
      settle();
      return;
    }
    // The copy flies home to the hole's resting place while it lowers.
    cancelFlips(hole);
    const to = hole.getBoundingClientRect();
    live.body.classList.remove("is-lifted");
    const animation = live.ghost.animate([
      { transform: live.ghost.style.transform || "none" },
      { transform: `translate3d(${to.left - live.origin.left}px, ${to.top - live.origin.top}px, 0) rotate(0deg)` },
    ], { duration, easing: SETTLE_EASE, fill: "forwards" });
    let settled = false;
    const once = (): void => {
      if (settled) return;
      settled = true;
      settle();
    };
    animation.addEventListener("finish", once);
    animation.addEventListener("cancel", once);
    window.setTimeout(once, duration + 120);
  };

  const lift = (source: HTMLElement, id: string, pointerId: number, x: number, y: number, touch: boolean): void => {
    const scroller = latest.current.scroller();
    const host = latest.current.ghostHost();
    const items = latest.current.items;
    const startIndex = items.findIndex((item) => item.id === id);
    if (!list || !scroller || !host || startIndex < 0 || session) return;
    const shown = latest.current.ghostSource?.(source) ?? source;
    const origin = shown.getBoundingClientRect();
    const { ghost, body } = makeGhost(shown, origin, host);
    const onMove = (event: PointerEvent) => { if (event.pointerId === pointerId) track(event.clientX, event.clientY); };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      suppressNextClick();
      finish(true);
    };
    const onCancel = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };
    // Once an item is up the page must not scroll under the finger, nor may a
    // long press open the system menu, start a text selection or hand an
    // image or link inside the item to the browser's own drag and drop.
    const block = (event: Event) => { if (event.cancelable) event.preventDefault(); };
    const onBlur = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("contextmenu", block);
    window.addEventListener("selectstart", block);
    window.addEventListener("dragstart", block);
    window.addEventListener("blur", onBlur);
    // A press that began on text may already have selected some of it.
    window.getSelection?.()?.removeAllRanges();
    const live: Session = {
      id,
      shape: items[startIndex]!.shape,
      pointerId,
      touch,
      rtl: getComputedStyle(scroller).direction === "rtl",
      host,
      frame: scroller.getBoundingClientRect(),
      ghost,
      body,
      origin,
      grabX: x - origin.left,
      grabY: y - origin.top,
      pointer: { x, y },
      startIndex,
      index: startIndex,
      others: null,
      moveFrame: 0,
      scrollFrame: 0,
      lastX: x,
      tilt: 0,
      landing: false,
      heldPadding: null,
      detach: () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, { capture: true });
        window.removeEventListener("touchmove", block);
        window.removeEventListener("contextmenu", block);
        window.removeEventListener("selectstart", block);
        window.removeEventListener("dragstart", block);
        window.removeEventListener("blur", onBlur);
      },
    };
    session = live;
    host.dataset.arrangeDragging = "true";
    // Auto-scroll sets scrollTop every frame; a smooth-scrolling page would fight
    // it. Scroll anchoring would shift the list each time the hole passes the
    // row it anchors to, away from the finger.
    scroller.style.scrollBehavior = "auto";
    scroller.style.overflowAnchor = "none";
    // A held item that folds (see `ghostSource`) lets the list close up by gliding.
    snapshot();
    liftScrollTop = scroller.scrollTop;
    flushSync(() => setDrag({ id, index: startIndex }));
    liftScrollTop = null;
    if (touch) hapticFeedback("tap");
    // Next frame: the copy rises (scale and shadow) from exactly where it sat.
    requestAnimationFrame(() => { if (session === live) body.classList.add("is-lifted"); });
    autoScroll(live);
  };

  const press = (event: ReactPointerEvent<HTMLElement>, id: string, grip: boolean): void => {
    if (!latest.current.enabled || session || pendingPress) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as Element;
    if (!grip && target.closest("[data-arrange-control], input, textarea, select, [contenteditable]")) return;
    const source = event.currentTarget.closest<HTMLElement>("[data-arrange-id]");
    if (!source) return;
    const pointerId = event.pointerId;
    const touch = event.pointerType === "touch";
    const startX = event.clientX;
    const startY = event.clientY;
    let lastX = startX;
    let lastY = startY;
    let timer = 0;
    // An image or link in the item would otherwise start the browser's own
    // drag on the first move, before this press can become one.
    const noNativeDrag = (drag: Event): void => { drag.preventDefault(); };
    const cancel = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("dragstart", noNativeDrag);
      if (pendingPress === cancel) pendingPress = null;
    };
    const begin = (): void => {
      cancel();
      if (!source.isConnected || session || !latest.current.enabled) return;
      lift(source, id, pointerId, startX, startY, touch);
      track(lastX, lastY);
    };
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      lastX = move.clientX;
      lastY = move.clientY;
      const distance = Math.hypot(lastX - startX, lastY - startY);
      // Away from a grip a moving finger is scrolling the page.
      if (touch && !grip) {
        if (distance > TOUCH_SLOP_PX) cancel();
        return;
      }
      if (distance >= DRAG_THRESHOLD_PX) begin();
    };
    const onEnd = (end: PointerEvent): void => { if (end.pointerId === pointerId) cancel(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("dragstart", noNativeDrag);
    if (touch) timer = window.setTimeout(begin, latest.current.touchLiftMs ?? ARRANGE_TOUCH_LIFT_MS);
    pendingPress = cancel;
  };

  const onArrangeKey = (id: string, event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || session) return;
    const current = latest.current.items.map((item) => item.id);
    const at = current.indexOf(id);
    const rtl = event.currentTarget.ownerDocument.documentElement.dir === "rtl";
    const to = arrangeKeyTarget(event.key, at, current.length, rtl);
    if (to === null || at < 0) return;
    event.preventDefault();
    if (to === at) return;
    const next = [...current];
    next.splice(at, 1);
    next.splice(to, 0, id);
    snapshot();
    latest.current.onCommit(next, id);
  };

  const abandon = (live: Session): void => {
    stopFrames(live);
    live.detach();
    release(live);
  };

  return {
    listRef: (element) => {
      if (element === list) return;
      list?.removeEventListener("touchmove", keepTouchMovesCancelable);
      list = element;
      list?.addEventListener("touchmove", keepTouchMovesCancelable, { passive: false });
    },
    itemProps: (id) => ({
      "data-arrange-id": id,
      onPointerDown: (event) => press(event, id, false),
    }),
    gripProps: (id) => ({
      "data-arrange-grip": "",
      onPointerDown: (event) => {
        event.stopPropagation();
        press(event, id, true);
      },
      onKeyDown: (event) => onArrangeKey(id, event),
    }),
    onArrangeKey,
    animateNextLayout: snapshot,
    afterRender: () => {
      const before = flipFrom;
      const lifted = liftScrollTop;
      flipFrom = null;
      liftScrollTop = null;
      const live = session;
      if (!list || (!before && !(live && live.others === null))) return;
      const elements = arrangeElements(list);
      // Strictly stop, read, then write: one style and layout flush per change.
      if (before) cancelFlips();
      const scroller = latest.current.scroller();
      if (live && scroller && lifted !== null) keepScrollRoom(live, scroller, lifted);
      const rects = elements.map((element) => element.getBoundingClientRect());
      if (live && scroller) {
        const shapes = new Map(latest.current.items.map((item) => [item.id, item.shape]));
        live.others = othersGeometry(elements, rects, scroller, live.id, shapes);
      }
      if (before) flips = playFlip(elements, rects, before);
    },
    reconcile: (enabled, ids) => {
      const live = session;
      if (!live || (enabled && ids.includes(live.id))) return;
      abandon(live);
      setDrag(null);
    },
    dispose: () => {
      pendingPress?.();
      if (session) abandon(session);
      cancelFlips();
    },
  };
}

export function useArrange(options: UseArrangeOptions): ArrangeController {
  const latest = useRef(options);
  latest.current = options;
  const [drag, setDrag] = useState<DragState>(null);
  const [engine] = useState(() => createArrangeEngine(latest, setDrag));
  const ids = options.items.map((item) => item.id);
  const held = drag && ids.includes(drag.id) ? drag : null;

  useLayoutEffect(() => { engine.afterRender(); });
  useEffect(() => { engine.reconcile(options.enabled, ids); });
  useEffect(() => () => engine.dispose(), [engine]);

  return {
    engine,
    order: held ? arrangePreviewOrder(ids, held.id, held.index) : ids,
    draggingId: held?.id ?? null,
  };
}
