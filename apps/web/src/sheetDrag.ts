// Drag-to-dismiss for phone sheets: a bottom sheet follows a finger pulling it
// down (a top sheet, one pushing it up), and a release either hands its
// position and speed to the sheet's exit or springs it back. The same grammar
// as the horizontal shell swipes (swipeSurface.ts): the layer tracks the
// finger 1:1 once the gesture is recognised, closes the recognition gap
// without a jump, leaves at the finger's speed and springs home on the stack
// curve.
//
// Where a drag may start:
//   * the grabber and the title row: at once, in the dismissing direction;
//   * the body: only while every scroller between the finger and the sheet is
//     already at its start (a list scrolled to the top pulls the sheet down
//     instead of bouncing), never in editable content, a horizontal owner or a
//     subtree with its own touch handling (`touch-action: none`).
//
// Input cost: the touchstart listener is passive; the non-passive touchmove /
// touchend listeners exist only for a touch that may become a drag.
import {
  caughtUpTravel,
  releaseVelocity,
  settleDurationMs,
  stackEase,
  type TravelSample,
} from "./mobileGestures.ts";
import { motionDurationMs } from "./motionPresence.ts";
import { selectionFeedback } from "./haptics.ts";

/** Drag distance (CSS px) past which a slow release dismisses. */
export const SHEET_DISMISS_DISTANCE = 88;
/** …or this share of the sheet's height, whichever is smaller. */
export const SHEET_DISMISS_SHARE = 0.32;
/** A flick this fast (px/ms toward dismissal) dismisses from anywhere past the minimum travel. */
export const SHEET_FLICK_VELOCITY = 0.5;
export const SHEET_FLICK_MIN_TRAVEL = 24;
/** Movement before a touch is recognised as a drag (below it, a tap or scroll is still possible). */
export const SHEET_DRAG_SLOP = 8;

const SAMPLE_LIMIT = 16;
/** Starts that are always the sheet's own handle. */
const HANDLE = ".sheet-grabber, .sheet-head";
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"]';

export interface SheetDragOptions {
  /** The panel that moves. */
  sheet(): HTMLElement | null;
  /** Bottom sheets are dragged down, top sheets up. */
  origin(): "bottom" | "top";
  /** Whether a drag may start right now. */
  enabled(): boolean;
  /** Dismiss: `--sheet-from` / `--sheet-settle` are already on the sheet for its exit. */
  onDismiss(): void;
  /** Each painted frame's share of the way out (0 at rest, 1 off-screen), e.g. to fade what is behind. */
  onProgress?(progress: number): void;
}

/** Whether the release dismisses (true) or springs the sheet back (false). */
export function sheetDragDismisses(input: { travel: number; height: number; velocity: number }): boolean {
  if (input.velocity <= -SHEET_FLICK_VELOCITY) return false;
  if (input.velocity >= SHEET_FLICK_VELOCITY && input.travel >= SHEET_FLICK_MIN_TRAVEL) return true;
  const threshold = Math.min(SHEET_DISMISS_DISTANCE, Math.max(SHEET_FLICK_MIN_TRAVEL, input.height * SHEET_DISMISS_SHARE));
  return input.travel >= threshold;
}

/** Whether a scroller between `target` and `sheet` can still move content the way a drag would. */
function scrollerKeepsDrag(target: Element, sheet: Element, origin: "bottom" | "top", win: Window): boolean {
  for (let node: Element | null = target; node && node !== sheet; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.touchAction === "none") return true;
    const overflow = style.overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const box = node as HTMLElement;
    if (box.scrollHeight - box.clientHeight <= 1) continue;
    // Pulling a bottom sheet down scrolls its content toward the top; that
    // belongs to the scroller until the top is reached (and the reverse for a top sheet).
    if (origin === "bottom" ? box.scrollTop > 0 : box.scrollTop + box.clientHeight < box.scrollHeight - 1) return true;
  }
  return false;
}

/** Attach to the sheet's document; returns the cleanup. */
export function attachSheetDrag(options: SheetDragOptions, doc: Document = document): () => void {
  type Mode = "idle" | "tracking" | "dragging" | "settling";
  const win = doc.defaultView ?? window;
  let mode: Mode = "idle";
  let touchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let handle = false;
  let target: Element | null = null;
  let live: HTMLElement | null = null;
  let sign = 1;
  let height = 0;
  let travel = 0;
  let claimTravel = 0;
  let base = 0;
  let armed = false;
  let samples: TravelSample[] = [];
  let frame = 0;
  let lastDown: { id: number; target: EventTarget } | null = null;

  const swallow = (event: Event): void => { event.stopImmediatePropagation(); };
  const swallowing = { capture: true, once: true } as const;
  const stopSwallowing = (): void => doc.removeEventListener("pointerup", swallow, swallowing);
  const rememberPointerDown = (event: PointerEvent): void => {
    lastDown = event.pointerType === "touch" ? { id: event.pointerId, target: event.target! } : null;
  };
  /** A drag is not a press: let the control under the finger drop its pressed state. */
  const cancelPagePress = (): void => {
    const down = lastDown;
    lastDown = null;
    if (!down || typeof win.PointerEvent !== "function") return;
    down.target.dispatchEvent(new win.PointerEvent("pointercancel", {
      pointerId: down.id, pointerType: "touch", isPrimary: true, bubbles: true, composed: true,
    }));
  };

  const active = { capture: true, passive: false } as const;
  let following = false;
  const follow = (): void => {
    if (following) return;
    following = true;
    doc.addEventListener("touchmove", onTouchMove, active);
    doc.addEventListener("touchend", onTouchEnd, active);
    doc.addEventListener("touchcancel", onTouchCancel, active);
  };
  const unfollow = (): void => {
    if (!following) return;
    following = false;
    doc.removeEventListener("touchmove", onTouchMove, active);
    doc.removeEventListener("touchend", onTouchEnd, active);
    doc.removeEventListener("touchcancel", onTouchCancel, active);
  };

  const paint = (at: number): void => {
    if (!live) return;
    live.style.transform = at > 0 ? `translate3d(0, ${sign * at}px, 0)` : "";
    options.onProgress?.(height > 0 ? Math.min(1, Math.max(0, at / height)) : 0);
  };
  const release = (): void => {
    if (live) {
      live.removeAttribute("data-dragging");
      live.style.removeProperty("will-change");
    }
  };
  const reset = (): void => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    unfollow();
    mode = "idle";
    touchId = null;
    target = null;
    live = null;
    travel = 0;
    claimTravel = 0;
    base = 0;
    armed = false;
    samples = [];
  };

  const springHome = (velocity: number): void => {
    const sheet = live;
    const from = travel;
    const duration = settleDurationMs({ remaining: from, width: height, velocity: -velocity, base: motionDurationMs("--motion-stack") });
    if (!sheet || from <= 0 || duration <= 0) {
      paint(0);
      release();
      reset();
      return;
    }
    mode = "settling";
    unfollow();
    const t0 = win.performance.now();
    const tick = (now: number): void => {
      const k = Math.min(1, (now - t0) / duration);
      travel = from * (1 - stackEase(k));
      paint(travel);
      if (k < 1) {
        frame = win.requestAnimationFrame(tick);
        return;
      }
      frame = 0;
      paint(0);
      release();
      reset();
    };
    frame = win.requestAnimationFrame(tick);
  };

  const dismiss = (velocity: number): void => {
    const sheet = live;
    if (!sheet) return reset();
    const settle = settleDurationMs({ remaining: height - travel, width: height, velocity, base: motionDurationMs("--motion-stack") });
    // The exit (a closing class, or the exit ghost of a sheet its owner
    // unmounts) carries on from here at the finger's speed. The inline
    // transform stays: the exit animation outranks it, and with motion off the
    // sheet stays where the finger left it until it is gone.
    sheet.style.setProperty("--sheet-from", `${sign * travel}px`);
    if (settle > 0) sheet.style.setProperty("--sheet-settle", `${settle}ms`);
    // Exits that differ for a tap (a top sheet's short lift) select the
    // carry-on travel by this.
    sheet.setAttribute("data-drag-dismissed", "");
    release();
    reset();
    options.onDismiss();
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (mode === "settling") {
      // A finger landing on a sheet that springs back catches it where it is.
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || !live || !(event.target instanceof win.Element) || !live.contains(event.target)) return;
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      touchId = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
      base = travel;
      claimTravel = 0;
      samples = [{ t: event.timeStamp, travel: base }];
      mode = "dragging";
      live.setAttribute("data-dragging", "true");
      cancelPagePress();
      doc.addEventListener("pointerup", swallow, swallowing);
      follow();
      return;
    }
    if (mode !== "idle") {
      // A second finger ends a drag.
      if (event.touches.length > 1 && mode === "dragging") {
        stopSwallowing();
        springHome(0);
      } else if (event.touches.length > 1) reset();
      return;
    }
    if (event.touches.length !== 1 || !options.enabled()) return;
    const sheet = options.sheet();
    const node = event.target;
    if (!sheet || !(node instanceof win.Element) || !sheet.contains(node)) return;
    if (node.closest(EDITABLE) || node.closest("[data-owns-swipe], [data-no-edge-swipe]")) return;
    const touch = event.touches[0]!;
    touchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    target = node;
    handle = Boolean(node.closest(HANDLE));
    live = sheet;
    sign = options.origin() === "top" ? -1 : 1;
    height = sheet.getBoundingClientRect().height || win.innerHeight;
    travel = 0;
    claimTravel = 0;
    base = 0;
    samples = [{ t: event.timeStamp, travel: 0 }];
    mode = "tracking";
    follow();
  };

  const touchById = (list: TouchList): Touch | null => {
    for (let i = 0; i < list.length; i++) if (list[i]!.identifier === touchId) return list[i]!;
    return null;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (mode !== "tracking" && mode !== "dragging") return;
    const touch = touchById(event.touches);
    const sheet = live;
    if (!touch || !sheet) return;
    const finger = sign * (touch.clientY - startY);
    const across = Math.abs(touch.clientX - startX);
    if (mode === "tracking") {
      if (finger < -SHEET_DRAG_SLOP || across > SHEET_DRAG_SLOP + Math.max(0, finger)) {
        // Back toward rest, or sideways: not a dismissal.
        reset();
        return;
      }
      if (finger <= SHEET_DRAG_SLOP || finger <= across * 1.15) return;
      if (!handle && (!target || scrollerKeepsDrag(target, sheet, sign === 1 ? "bottom" : "top", win))) {
        reset();
        return;
      }
      if (!options.enabled()) {
        reset();
        return;
      }
      mode = "dragging";
      claimTravel = finger;
      sheet.setAttribute("data-dragging", "true");
      sheet.style.willChange = "transform";
      cancelPagePress();
      doc.addEventListener("pointerup", swallow, swallowing);
    }
    // The browser must not also scroll or bounce under a claimed drag.
    if (event.cancelable) event.preventDefault();
    travel = Math.min(height, Math.max(0, base + caughtUpTravel(finger, claimTravel)));
    samples.push({ t: event.timeStamp, travel: base + finger });
    if (samples.length > SAMPLE_LIMIT) samples.shift();
    paint(travel);
    const past = sheetDragDismisses({ travel, height, velocity: 0 });
    if (past !== armed) {
      armed = past;
      selectionFeedback();
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (mode === "tracking") {
      if (!touchById(event.touches)) reset();
      return;
    }
    if (mode !== "dragging" || touchById(event.touches)) return;
    stopSwallowing();
    // A drag is not a tap: keep the synthesized click from reaching what is underneath.
    if (event.cancelable) event.preventDefault();
    const velocity = releaseVelocity(samples);
    if (sheetDragDismisses({ travel, height, velocity })) dismiss(velocity);
    else springHome(velocity);
  };

  const onTouchCancel = (): void => {
    stopSwallowing();
    if (mode === "dragging") springHome(0);
    else if (mode === "tracking") reset();
  };

  const onVisibility = (): void => {
    if (doc.visibilityState === "hidden") onTouchCancel();
  };

  const passive = { capture: true, passive: true } as const;
  doc.addEventListener("pointerdown", rememberPointerDown, passive);
  doc.addEventListener("touchstart", onTouchStart, passive);
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    doc.removeEventListener("pointerdown", rememberPointerDown, passive);
    doc.removeEventListener("touchstart", onTouchStart, passive);
    doc.removeEventListener("visibilitychange", onVisibility);
    stopSwallowing();
    if (mode === "dragging" || mode === "settling") {
      paint(0);
      release();
    }
    reset();
  };
}
