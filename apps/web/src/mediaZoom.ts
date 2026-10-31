// Zoom for the media viewer's image (AttachmentPreview.tsx): two fingers pinch
// around their midpoint, a double tap zooms into the tapped point (or back
// out), one finger or the mouse drags a zoomed image, and a trackpad pinch
// (ctrl + wheel) zooms around the pointer.
//
// The page itself never zooms (the viewport is fixed at scale 1) and the stage
// takes no native panning (`touch-action: none`), so every touch arrives here
// and in the viewer's swipe/pull controllers. While the image is zoomed, or two
// fingers are down, the viewer turns its paging and pull-to-dismiss off
// (`engaged()`), so a pan is never also a page turn.
//
// The transform sits on the image itself; the stage carries `data-zoomed`
// while it is enlarged. Geometry is pure (`clampView`, `zoomAround`).

export const MEDIA_ZOOM_MAX = 4;
/** What a double tap zooms to from rest. */
export const MEDIA_ZOOM_DOUBLE_TAP = 2.5;
/** Below this a released pinch settles back to rest. */
const REST_SNAP = 1.04;
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DISTANCE = 36;

export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export interface ZoomBox {
  /** The image's untransformed layout box, in the slide's coordinates. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The slide (the visible area the image is panned in). */
  viewWidth: number;
  viewHeight: number;
}

export const REST_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };

function clampAxis(offset: number, start: number, size: number, scaled: number, view: number): number {
  const center = start + size / 2;
  // Larger than the view: its edges stay outside it. Smaller: it stays inside.
  const a = view - center - scaled / 2;
  const b = scaled / 2 - center;
  return Math.min(Math.max(offset, Math.min(a, b)), Math.max(a, b));
}

/** Keep a zoomed image covering the view (or inside it, when it is smaller on that axis). */
export function clampView(view: ZoomView, box: ZoomBox): ZoomView {
  const scale = Math.min(MEDIA_ZOOM_MAX, Math.max(1, view.scale));
  if (scale === 1) return REST_VIEW;
  return {
    scale,
    x: clampAxis(view.x, box.left, box.width, box.width * scale, box.viewWidth),
    y: clampAxis(view.y, box.top, box.height, box.height * scale, box.viewHeight),
  };
}

/** The view at `scale` that keeps the image point under `focus` (slide coordinates) where it is. */
export function zoomAround(view: ZoomView, focus: { x: number; y: number }, scale: number, box: ZoomBox): ZoomView {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const px = (focus.x - cx - view.x) / view.scale;
  const py = (focus.y - cy - view.y) / view.scale;
  return { scale, x: focus.x - cx - px * scale, y: focus.y - cy - py * scale };
}

export interface MediaZoomOptions {
  /** Gestures start inside this element (the viewer's stage). */
  surface(): HTMLElement | null;
  /** The zoomable image right now, or null (video, documents, cards). */
  media(): HTMLElement | null;
}

export interface MediaZoom {
  /** Zoomed, or two fingers are down: other gestures must leave the touch alone. */
  engaged(): boolean;
  /** Back to rest at once (the item changed). */
  reset(): void;
  detach(): void;
}

interface Pointer {
  x: number;
  y: number;
}

export function attachMediaZoom(options: MediaZoomOptions): MediaZoom {
  const surface = options.surface();
  let el: HTMLElement | null = null;
  let view: ZoomView = REST_VIEW;
  const pointers = new Map<number, Pointer>();
  let pinch: { view: ZoomView; mid: Pointer; distance: number } | null = null;
  let pan: { id: number; view: ZoomView; from: Pointer } | null = null;
  /** The current gesture moved or pinched: the click it ends with is not a tap. */
  let moved = false;
  let downAt: { x: number; y: number; t: number; onMedia: boolean } | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;
  let settleTimer = 0;
  let lastPointerType = "";

  const box = (): ZoomBox | null => {
    const media = el;
    const slide = media?.offsetParent as HTMLElement | null | undefined;
    if (!media || !slide || media.offsetWidth <= 0 || media.offsetHeight <= 0) return null;
    return {
      left: media.offsetLeft,
      top: media.offsetTop,
      width: media.offsetWidth,
      height: media.offsetHeight,
      viewWidth: slide.clientWidth,
      viewHeight: slide.clientHeight,
    };
  };

  /** Slide coordinates of a client point (the slide sits at rest while zooming). */
  const local = (point: Pointer): Pointer => {
    const slide = el?.offsetParent as HTMLElement | null | undefined;
    const rect = slide?.getBoundingClientRect();
    return rect ? { x: point.x - rect.left, y: point.y - rect.top } : point;
  };

  const paint = (next: ZoomView, animate = false): void => {
    view = next;
    const media = el;
    if (!media) return;
    const win = media.ownerDocument.defaultView ?? window;
    win.clearTimeout(settleTimer);
    if (animate) {
      media.setAttribute("data-zoom-settling", "");
      settleTimer = win.setTimeout(() => media.removeAttribute("data-zoom-settling"), 400);
    } else media.removeAttribute("data-zoom-settling");
    const atRest = next.scale === 1 && next.x === 0 && next.y === 0;
    if (atRest) media.style.removeProperty("transform");
    else media.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
    surface?.toggleAttribute("data-zoomed", next.scale > 1);
  };

  /** Follow the image the viewer shows now; a new one starts at rest. */
  const track = (): HTMLElement | null => {
    const media = options.media();
    if (media !== el) {
      el = media;
      view = REST_VIEW;
      surface?.removeAttribute("data-zoomed");
    }
    return el;
  };

  const settle = (): void => {
    const b = box();
    if (!b) return;
    paint(view.scale < REST_SNAP ? REST_VIEW : clampView(view, b), true);
  };

  const beginPinch = (): void => {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    pan = null;
    moved = true;
    pinch = {
      view,
      mid: local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  };

  const onPointerDown = (event: PointerEvent): void => {
    lastPointerType = event.pointerType;
    if (pointers.size === 0) moved = false;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as Element | null;
    if (!target?.closest || target.closest("button, a, input, textarea, select, video, audio, iframe")) return;
    if (!track()) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      downAt = { x: event.clientX, y: event.clientY, t: event.timeStamp, onMedia: Boolean(el?.contains(target)) };
      if (view.scale > 1) {
        pan = { id: event.pointerId, view, from: { x: event.clientX, y: event.clientY } };
        // Grab the image where it is, even mid-settle.
        el?.removeAttribute("data-zoom-settling");
      }
    } else if (pointers.size === 2 && event.pointerType === "touch") {
      downAt = null;
      el?.removeAttribute("data-zoom-settling");
      beginPinch();
    }
    if (pan || pinch) surface?.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > TAP_SLOP) {
      downAt = null;
      if (pan) moved = true;
    }
    const b = box();
    if (!b) return;
    if (pinch && pointers.size >= 2) {
      const [p, q] = [...pointers.values()];
      const mid = local({ x: (p!.x + q!.x) / 2, y: (p!.y + q!.y) / 2 });
      const scale = Math.min(MEDIA_ZOOM_MAX, Math.max(1, pinch.view.scale * Math.hypot(p!.x - q!.x, p!.y - q!.y) / pinch.distance));
      // The image point that was under the fingers' midpoint stays under it as they move.
      const anchored = zoomAround(pinch.view, pinch.mid, scale, b);
      paint(clampView({ scale, x: anchored.x + mid.x - pinch.mid.x, y: anchored.y + mid.y - pinch.mid.y }, b));
      return;
    }
    if (pan && pan.id === event.pointerId && moved) {
      paint(clampView({
        scale: pan.view.scale,
        x: pan.view.x + event.clientX - pan.from.x,
        y: pan.view.y + event.clientY - pan.from.y,
      }, b));
    }
  };

  const onTap = (event: PointerEvent, onMedia: boolean): void => {
    const now = event.timeStamp;
    const previous = lastTap;
    lastTap = { x: event.clientX, y: event.clientY, t: now };
    if (!previous || now - previous.t > DOUBLE_TAP_MS
      || Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > DOUBLE_TAP_DISTANCE) return;
    lastTap = null;
    const b = box();
    if (!b) return;
    if (view.scale > 1) paint(REST_VIEW, true);
    else if (onMedia) paint(clampView(zoomAround(view, local({ x: event.clientX, y: event.clientY }), MEDIA_ZOOM_DOUBLE_TAP, b), b), true);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (!pointers.delete(event.pointerId)) return;
    const tap = event.type === "pointerup" && downAt && pointers.size === 0 ? downAt : null;
    downAt = null;
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        settle();
        // The finger still down carries on as a pan from here.
        const [rest] = [...pointers.entries()];
        if (rest && view.scale > 1) pan = { id: rest[0], view, from: { ...rest[1] } };
      }
      return;
    }
    if (pan?.id === event.pointerId) pan = null;
    if (tap && event.timeStamp - tap.t < DOUBLE_TAP_MS) onTap(event, tap.onMedia);
  };

  // A drag or pinch that ends over the dim is not a tap on it (which closes the viewer).
  const onClick = (event: MouseEvent): void => {
    if (!moved) return;
    moved = false;
    event.stopPropagation();
    event.preventDefault();
  };

  // Trackpad pinches arrive as ctrl + wheel; a plain wheel is left alone.
  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey || !track()) return;
    const b = box();
    if (!b) return;
    event.preventDefault();
    const scale = Math.min(MEDIA_ZOOM_MAX, Math.max(1, view.scale * Math.exp(-event.deltaY * 0.01)));
    const next = scale < REST_SNAP ? REST_VIEW : clampView(zoomAround(view, local({ x: event.clientX, y: event.clientY }), scale, b), b);
    paint(next);
  };

  const onDoubleClick = (event: MouseEvent): void => {
    // Touch double taps are handled from their pointers; this is the mouse's.
    if (lastPointerType !== "mouse" || !track()) return;
    const b = box();
    if (!b) return;
    if (view.scale > 1) paint(REST_VIEW, true);
    else if (el?.contains(event.target as Node | null)) {
      paint(clampView(zoomAround(view, local({ x: event.clientX, y: event.clientY }), MEDIA_ZOOM_DOUBLE_TAP, b), b), true);
    }
  };

  const passive = { passive: true } as const;
  surface?.addEventListener("pointerdown", onPointerDown, passive);
  surface?.addEventListener("pointermove", onPointerMove, passive);
  surface?.addEventListener("pointerup", onPointerEnd, passive);
  surface?.addEventListener("pointercancel", onPointerEnd, passive);
  surface?.addEventListener("click", onClick, { capture: true });
  surface?.addEventListener("wheel", onWheel, { passive: false });
  surface?.addEventListener("dblclick", onDoubleClick);

  return {
    engaged: () => view.scale > 1 || pointers.size >= 2 || pinch !== null,
    reset() {
      pointers.clear();
      pinch = null;
      pan = null;
      downAt = null;
      lastTap = null;
      moved = false;
      if (el) paint(REST_VIEW);
      el = null;
      surface?.removeAttribute("data-zoomed");
    },
    detach() {
      surface?.removeEventListener("pointerdown", onPointerDown);
      surface?.removeEventListener("pointermove", onPointerMove);
      surface?.removeEventListener("pointerup", onPointerEnd);
      surface?.removeEventListener("pointercancel", onPointerEnd);
      surface?.removeEventListener("click", onClick, { capture: true });
      surface?.removeEventListener("wheel", onWheel);
      surface?.removeEventListener("dblclick", onDoubleClick);
      if (el) (el.ownerDocument.defaultView ?? window).clearTimeout(settleTimer);
    },
  };
}
