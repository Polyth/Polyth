import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { motionDurationMs } from "../../../apps/web/src/motionPresence.ts";

/** A fold of the conversation: a part of an entry that opens in place under
 *  what opened it. Its content is in the page from the moment it starts to
 *  open until it has closed, and its height glides between nothing and the
 *  content's own, so nothing below it jumps.
 *
 *  Placement goes with the motion. A fold closing above the link that closed
 *  it (the "Show less" under a long report) keeps that link where it was on
 *  screen: the feed scrolls with the fold, so the reader stays at the entry
 *  instead of landing somewhere later in the page. A fold opening near the
 *  feed's end lifts into view as it grows, stopping before what opened it
 *  leaves the upper part of the view. */
export interface Fold {
  open: boolean;
  /** Its content is in the page: open, or still closing. */
  present: boolean;
  region: RefObject<HTMLDivElement | null>;
  /** `anchor`: what must keep its place on screen while the fold changes. */
  toggle(next: boolean, anchor?: HTMLElement | null): void;
}

interface Pending {
  from: number;
  anchor: HTMLElement | null;
  top: number;
  animated: boolean;
}

/** Room kept at the feed's lower edge, where its lines fade out. */
const EDGE = 32;
/** An opening fold lifts until its top reaches this share of the view. */
const REVEAL_TOP = 0.28;

const EASE_FALLBACK = "cubic-bezier(0.2, 0.8, 0.3, 1)";

function easing(element: Element): string {
  if (typeof getComputedStyle !== "function") return EASE_FALLBACK;
  return getComputedStyle(element).getPropertyValue("--motion-ease").trim() || EASE_FALLBACK;
}

/** The nearest ancestor that scrolls. */
function scrollerOf(node: Element | null | undefined): HTMLElement | null {
  if (typeof getComputedStyle !== "function") return null;
  for (let at = node?.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return null;
}

/** `step` once now and then on every frame until stopped. A frame callback
 *  that runs at once (a test's stub) ends the loop instead of recursing. */
function everyFrame(step: () => void): () => void {
  let live = true;
  let frame = 0;
  const tick = () => {
    if (!live) return;
    step();
    let now = true;
    frame = requestAnimationFrame(() => { if (!now) tick(); });
    now = false;
  };
  tick();
  return () => {
    live = false;
    cancelAnimationFrame(frame);
  };
}

/** Keep `anchor` at `top` on screen by scrolling `scroller`. */
function hold(scroller: HTMLElement, anchor: HTMLElement, top: number): void {
  const drift = anchor.getBoundingClientRect().top - top;
  if (Math.abs(drift) >= 0.5) scroller.scrollTop += drift;
}

/** Lift an opening fold's entry into view, its top never above REVEAL_TOP. */
function reveal(scroller: HTMLElement, region: HTMLElement): void {
  const view = scroller.getBoundingClientRect();
  const entry = (region.parentElement ?? region).getBoundingClientRect();
  const over = entry.bottom - (view.bottom - EDGE);
  if (over <= 0.5) return;
  const room = region.getBoundingClientRect().top - (view.top + view.height * REVEAL_TOP);
  const lift = Math.min(over, room);
  if (lift >= 0.5) scroller.scrollTop += lift;
}

export function useFold(initial = false): Fold {
  const [open, setOpen] = useState(initial);
  const [present, setPresent] = useState(initial);
  const region = useRef<HTMLDivElement>(null);
  const pending = useRef<Pending | null>(null);

  const toggle = (next: boolean, anchor?: HTMLElement | null) => {
    if (next === open) return;
    const current = region.current;
    const animated = motionDurationMs("--motion-normal") > 0
      && typeof (current ?? document.body).animate === "function";
    pending.current = {
      from: current?.getBoundingClientRect().height ?? 0,
      anchor: anchor ?? null,
      top: anchor?.getBoundingClientRect().top ?? 0,
      animated,
    };
    setOpen(next);
    // Without motion a closing fold leaves with the same render.
    if (next || !animated) setPresent(next);
  };

  useLayoutEffect(() => {
    const motion = pending.current;
    pending.current = null;
    if (!motion) return;
    const element = region.current;
    const scroller = scrollerOf(element ?? motion.anchor);
    const place = () => {
      if (!scroller) return;
      if (motion.anchor?.isConnected) hold(scroller, motion.anchor, motion.top);
      else if (open && element) reveal(scroller, element);
    };
    if (!motion.animated || !element) {
      place();
      if (!open) setPresent(false);
      return;
    }

    element.style.height = "";
    // Its laid-out height, not scrollHeight: a link's touch target reaching
    // past the fold's edge would make it overshoot, then snap back.
    const to = open ? element.getBoundingClientRect().height : 0;
    const distance = Math.abs(to - motion.from);
    const duration = motionDurationMs(distance > 240 ? "--motion-surface" : "--motion-normal");
    // Clipped while it moves; never a scroll container, never an anchor the
    // browser's own scroll anchoring would chase.
    element.style.overflow = "clip";
    element.style.overflowAnchor = "none";
    const animation = element.animate(
      [{ height: `${motion.from}px` }, { height: `${to}px` }],
      { duration, easing: easing(element) },
    );
    const stop = scroller ? everyFrame(place) : () => {};
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      stop();
      element.style.overflow = "";
      element.style.overflowAnchor = "";
      if (!open) {
        // Closed until React takes the content away: no frame at full height.
        element.style.height = "0px";
        setPresent(false);
      } else {
        place();
      }
    };
    void (animation.finished as Promise<Animation> | undefined)?.then(settle, () => {});
    // A finish that never comes (a background tab, a test's DOM) still ends it.
    const timer = setTimeout(settle, duration + 120);
    return () => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        stop();
        element.style.overflow = "";
        element.style.overflowAnchor = "";
      }
      animation.cancel?.();
    };
    // `pending` carries the rest; only a change of `open` moves the fold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { open, present, region, toggle };
}
