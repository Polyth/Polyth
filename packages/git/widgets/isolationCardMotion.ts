/**
 * Isolation card motion.
 *
 * The card is a direct `.timeline` child below the last transcript row, so
 * every pixel of its box is transcript geometry: the timeline follows the
 * tail (or holds a detached reader's row) from its ResizeObserver in the frame
 * the layout changed. A card that changed height in one commit therefore moved
 * the whole conversation in one frame — up when a step appeared, down when the
 * card vanished after the merge — and a card that appeared at once sat at its
 * final place while the rows above were still lifting past it.
 *
 * Here the card animates its own box instead. Each state change becomes a run
 * of small per-frame layout steps, which the timeline's follow already renders
 * as a glide (below its discrete-lift threshold), so the rows never jump and
 * never cross the card. Entering and leaving also animate the card's share of
 * the flex gap: a fully collapsed card occupies exactly zero pixels, so the
 * commit that finally unmounts it moves nothing.
 */

/** The box properties that make up the card's share of the timeline. */
export interface CardBox {
  height: number;
  paddingTop: number;
  paddingBottom: number;
  marginTop: number;
  opacity: number;
}

/** Morph and exit pace: long enough to read as one calm movement. */
export const CARD_MORPH_MIN_MS = 260;
export const CARD_MORPH_MAX_MS = 460;
export const CARD_ENTER_MS = 440;
export const CARD_EXIT_MS = 460;
/** How long the merged state is shown before the card hands over to the
 *  transcript notice. Long enough to read "Merged into main" once. */
export const CARD_DONE_BEAT_MS = 1_350;

// A soft deceleration for geometry, and a symmetric curve for collapse so the
// transcript eases into its new rest instead of dropping at the start.
const MORPH_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const EXIT_EASE = "cubic-bezier(0.65, 0, 0.35, 1)";
const FADE_EASE = "cubic-bezier(0.2, 0, 0, 1)";

// Peak travel speed in px/ms. The ease's steepest slope is about 2.25× its
// average, so pacing the duration by distance keeps every frame's step well
// below the timeline's 24 px lift threshold, even for a tall conflict card.
const MAX_AVERAGE_SPEED = 0.42;

/** Reduced motion, the in-app reduce-animations setting, the desktop
 *  low-resource profile and a hidden tab all switch card motion off, the same
 *  switches the timeline's own motion honours. */
export function cardMotionReduced(): boolean {
  if (typeof document === "undefined") return true;
  if (document.hidden) return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  if (document.body?.dataset.desktopLowResource === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function cardCanAnimate(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && typeof element.animate === "function" && !cardMotionReduced();
}

const px = (value: string | null | undefined): number => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The card's box as currently laid out, including a running animation. */
export function readCardBox(element: HTMLElement): CardBox {
  const style = getComputedStyle(element);
  return {
    height: element.offsetHeight,
    paddingTop: px(style.paddingTop),
    paddingBottom: px(style.paddingBottom),
    marginTop: px(style.marginTop),
    opacity: Number.isFinite(Number.parseFloat(style.opacity)) ? Number.parseFloat(style.opacity) : 1,
  };
}

/**
 * The card's natural box after a content change, measured without letting the
 * box shrink in layout. A forced layout at a smaller size would clamp the
 * timeline's scrollTop on the spot, a frame before the animation restores the
 * old height, and the whole transcript would blink down and back. The box is
 * held at `floor` while measuring; a shrinking card's natural height is read
 * from its children instead (the card is their offset parent).
 */
export function measureNaturalCardBox(element: HTMLElement, floor: number): CardBox {
  const previous = element.style.minHeight;
  element.style.minHeight = `${Math.max(0, floor)}px`;
  const style = getComputedStyle(element);
  const borderTop = px(style.borderTopWidth);
  const borderBottom = px(style.borderBottomWidth);
  let contentBottom = 0;
  let measurable = true;
  for (const child of Array.from(element.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.offsetParent === null && getComputedStyle(child).display === "none") continue;
    if (child.offsetParent !== element) {
      measurable = false;
      break;
    }
    // offsetTop is from the card's padding edge; a running reveal translates
    // a child, which leaves its height alone.
    contentBottom = Math.max(contentBottom,
      child.offsetTop + child.getBoundingClientRect().height + px(getComputedStyle(child).marginBottom));
  }
  const box: CardBox = {
    height: measurable ? borderTop + contentBottom + px(style.paddingBottom) + borderBottom : element.offsetHeight,
    paddingTop: px(style.paddingTop),
    paddingBottom: px(style.paddingBottom),
    marginTop: px(style.marginTop),
    opacity: 1,
  };
  element.style.minHeight = previous;
  return box;
}

/** A box that occupies no space in the timeline: the negative margin cancels
 *  the flex gap before the card and the borders a border-box cannot shed. */
export function collapsedCardBox(element: HTMLElement): CardBox {
  const style = getComputedStyle(element);
  const parent = element.parentElement;
  const gap = parent ? px(getComputedStyle(parent).rowGap) : 0;
  const borders = px(style.borderTopWidth) + px(style.borderBottomWidth);
  return { height: borders, paddingTop: 0, paddingBottom: 0, marginTop: -(gap + borders), opacity: 0 };
}

export function cardBoxesMatch(a: CardBox, b: CardBox): boolean {
  return Math.abs(a.height - b.height) < 1
    && Math.abs(a.paddingTop - b.paddingTop) < 0.5
    && Math.abs(a.paddingBottom - b.paddingBottom) < 0.5
    && Math.abs(a.marginTop - b.marginTop) < 0.5
    && Math.abs(a.opacity - b.opacity) < 0.02;
}

function geometry(box: CardBox): Keyframe {
  return {
    height: `${box.height}px`,
    paddingTop: `${box.paddingTop}px`,
    paddingBottom: `${box.paddingBottom}px`,
    marginTop: `${box.marginTop}px`,
  };
}

function pacedDuration(from: CardBox, to: CardBox, min: number, max: number): number {
  const travel = Math.abs((from.height + from.marginTop) - (to.height + to.marginTop));
  return Math.round(Math.min(max, Math.max(min, travel / MAX_AVERAGE_SPEED)));
}

interface RunningMotion {
  animations: Animation[];
  /** Inline overflow found before any motion, restored when it settles. */
  overflow: string;
  kind: CardMotionKind;
}

export type CardMotionKind = "morph" | "enter" | "exit";

const running = new WeakMap<HTMLElement, RunningMotion>();

export function cardMotionRunning(element: HTMLElement): CardMotionKind | null {
  return running.get(element)?.kind ?? null;
}

/** Drop any running motion; the card lands on its natural layout. */
export function settleCardMotion(element: HTMLElement): void {
  const motion = running.get(element);
  if (!motion) return;
  running.delete(element);
  for (const animation of motion.animations) animation.cancel();
  element.style.overflow = motion.overflow;
}

/**
 * Animate the card between two boxes. A motion already running is superseded
 * from wherever its box is now (the caller reads it before settling), so an
 * interrupted morph, entrance or exit never snaps. An exit keeps its collapsed
 * fill until the card unmounts: releasing it first would paint the full card
 * for a frame.
 */
export function playCardMotion(
  element: HTMLElement,
  kind: CardMotionKind,
  from: CardBox,
  to: CardBox,
  onFinish?: () => void,
): boolean {
  const overflow = running.get(element)?.overflow ?? element.style.overflow;
  settleCardMotion(element);
  if (cardBoxesMatch(from, to)) {
    onFinish?.();
    return false;
  }
  const duration = kind === "enter"
    ? Math.max(CARD_ENTER_MS, pacedDuration(from, to, CARD_ENTER_MS, CARD_MORPH_MAX_MS + 120))
    : kind === "exit"
      ? Math.max(CARD_EXIT_MS, pacedDuration(from, to, CARD_EXIT_MS, CARD_MORPH_MAX_MS + 120))
      : pacedDuration(from, to, CARD_MORPH_MIN_MS, CARD_MORPH_MAX_MS);
  // The content clips to the travelling box; the card's own shadow and glass
  // edge stay outside the clip.
  element.style.overflow = "hidden";
  const animations: Animation[] = [
    element.animate([geometry(from), geometry(to)], {
      duration,
      easing: kind === "exit" ? EXIT_EASE : MORPH_EASE,
      fill: "both",
    }),
  ];
  if (Math.abs(from.opacity - to.opacity) >= 0.02) {
    // Leaving: the content fades before the box closes over it. Arriving: it
    // fades in once there is room for it, so text never squeezes into view.
    const fade = kind === "exit"
      ? { duration: Math.round(duration * 0.55), delay: 0 }
      : { duration: Math.round(duration * 0.7), delay: Math.round(duration * 0.3) };
    animations.push(element.animate([
      { opacity: from.opacity, transform: kind === "exit" ? "none" : "translate3d(0, 6px, 0) scale(0.985)" },
      { opacity: to.opacity, transform: kind === "exit" ? "translate3d(0, 4px, 0) scale(0.985)" : "none" },
    ], { ...fade, easing: FADE_EASE, fill: "both" }));
  }
  const motion: RunningMotion = { animations, overflow, kind };
  running.set(element, motion);
  void Promise.all(animations.map((animation) => animation.finished)).then(() => {
    if (running.get(element) !== motion) return;
    if (kind !== "exit") {
      running.delete(element);
      for (const animation of animations) animation.cancel();
      element.style.overflow = overflow;
    }
    onFinish?.();
  }, () => undefined);
  return true;
}
