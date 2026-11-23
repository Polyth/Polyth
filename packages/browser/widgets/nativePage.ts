// The live page in Polyth Desktop. A browser session the Desktop app hosts
// (`nativeViewId`) is a real Chromium page; this window shows it in place of
// frames by giving it the rectangle of the browser stage. The page is drawn
// by the app above this document, so anything of ours over the stage (a
// menu, a dialog, a toast) would vanish behind it: whenever the stage is not
// what the window shows at its edges and centre, the page steps back and the
// frame picture under it shows instead.
import { useEffect, useRef, useState, type RefObject } from "react";

interface WebViewRect { x: number; y: number; width: number; height: number }

interface DesktopWebViews {
  place(id: string, rect: WebViewRect | null): Promise<void>;
}

/** The Desktop bridge, only in a window showing this computer's own server. */
export function nativeWebViewsBridge(scope: unknown = globalThis): DesktopWebViews | null {
  const desktop = (scope as { polythDesktop?: { surface?: unknown; webViews?: unknown } }).polythDesktop;
  if (!desktop || desktop.surface !== "local") return null;
  const webViews = desktop.webViews as Partial<DesktopWebViews> | undefined;
  return webViews && typeof webViews.place === "function" ? webViews as DesktopWebViews : null;
}

/** Points that must all land on the stage for the page to be shown: a 6×6
 * grid from edge to edge, so a menu or toast over any part is seen. */
export function probePoints(rect: WebViewRect): Array<{ x: number; y: number }> {
  const inset = 2;
  const steps = 5;
  const left = rect.x + inset;
  const top = rect.y + inset;
  const spanX = rect.width - 1 - 2 * inset;
  const spanY = rect.height - 1 - 2 * inset;
  const points: Array<{ x: number; y: number }> = [];
  for (let row = 0; row <= steps; row++) {
    for (let col = 0; col <= steps; col++) points.push({ x: left + spanX * col / steps, y: top + spanY * row / steps });
  }
  return points;
}

/** Our floating layers. Any of them open over the stage steps the page back,
 * however little of the stage it covers. Mark another layer with
 * `data-native-page-over` to get the same. */
export const OVERLAY_SELECTOR = [
  '[role="menu"]', '[role="listbox"]', '[role="dialog"]', '[role="alertdialog"]', '[role="tooltip"]',
  "dialog[open]", ".ui-popover-backdrop", "[data-native-page-over]",
].join(", ");

const intersects = (a: { left: number; top: number; right: number; bottom: number }, rect: WebViewRect) =>
  a.right > rect.x && a.left < rect.x + rect.width && a.bottom > rect.y && a.top < rect.y + rect.height;

/** Whether one of our floating layers lies over `rect`. */
export function overlayOver(stage: Element, rect: WebViewRect, doc: Pick<Document, "querySelectorAll"> = document): boolean {
  let open: Element[];
  try {
    open = [...doc.querySelectorAll(`${OVERLAY_SELECTOR}, :popover-open`)];
  } catch {
    open = [...doc.querySelectorAll(OVERLAY_SELECTOR)];
  }
  return open.some((layer) => {
    // The window or pane the browser itself lives in (a package window is a
    // dialog) holds the stage; it is not over it.
    if (layer === stage || layer.contains(stage)) return false;
    // A layer inside what the page covers is the page's picture, not ours.
    const under = layer.closest(`[${NATIVE_PAGE_UNDER}]`);
    if (under && stage.contains(under)) return false;
    const box = layer.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && intersects(box, rect);
  });
}

/** Marks what the live page may cover inside the stage: the frame picture and
 * its placeholder. Anything else there (an approval card, a notice) is ours
 * and must stay in sight. */
export const NATIVE_PAGE_UNDER = "data-native-page-under";

/** Whether the window shows the stage itself (or what the page may cover) at
 * every probe point. */
export function stageUnobstructed(stage: Element, rect: WebViewRect, doc: Pick<Document, "elementFromPoint"> = document): boolean {
  return probePoints(rect).every(({ x, y }) => {
    const hit = doc.elementFromPoint(x, y);
    if (!hit) return false;
    if (hit === stage) return true;
    const under = hit.closest(`[${NATIVE_PAGE_UNDER}]`);
    return under !== null && stage.contains(under);
  });
}

/** How far the page stays off an edge that something of ours overlaps. */
export const EDGE_TRIM = 8;

/**
 * The stage minus any edge strip our own chrome lies on: a window's resize
 * grip overlapping the stage must stay usable, and the page would cover it.
 * The frame picture shows in the strip, so nothing looks cut away.
 */
export function trimEdges(stage: Element, rect: WebViewRect, doc: Pick<Document, "elementFromPoint"> = document): WebViewRect {
  const shown = (x: number, y: number) => {
    const hit = doc.elementFromPoint(x, y);
    if (!hit) return false;
    if (hit === stage) return true;
    const under = hit.closest(`[${NATIVE_PAGE_UNDER}]`);
    return under !== null && stage.contains(under);
  };
  const along = (from: number, size: number) => [from + size * 0.25, from + size / 2, from + size * 0.75];
  const left = along(rect.y, rect.height).every((y) => shown(rect.x + 1, y)) ? 0 : EDGE_TRIM;
  const right = along(rect.y, rect.height).every((y) => shown(rect.x + rect.width - 2, y)) ? 0 : EDGE_TRIM;
  const top = along(rect.x, rect.width).every((x) => shown(x, rect.y + 1)) ? 0 : EDGE_TRIM;
  const bottom = along(rect.x, rect.width).every((x) => shown(x, rect.y + rect.height - 2)) ? 0 : EDGE_TRIM;
  return {
    x: rect.x + left,
    y: rect.y + top,
    width: Math.max(0, rect.width - left - right),
    height: Math.max(0, rect.height - top - bottom),
  };
}

const sameRect = (a: WebViewRect | null, b: WebViewRect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/**
 * Show the native page `viewId` over `stageRef` while `wanted`. Returns
 * whether the person sees the live page right now (false: the frames show).
 */
export function useNativePage(viewId: string | undefined, stageRef: RefObject<HTMLElement | null>, wanted: boolean): boolean {
  const [live, setLive] = useState(false);
  const placed = useRef<WebViewRect | null>(null);
  const bridge = nativeWebViewsBridge();
  const active = Boolean(bridge && viewId && wanted);

  useEffect(() => {
    if (!active || !bridge || !viewId) {
      setLive(false);
      return;
    }
    let disposed = false;
    let frame = 0;
    const apply = (rect: WebViewRect | null) => {
      if (sameRect(placed.current, rect)) return;
      placed.current = rect;
      setLive(rect !== null);
      void bridge.place(viewId, rect).catch(() => {
        // The page is gone or this window may not place it: frames it is.
        if (disposed) return;
        placed.current = null;
        setLive(false);
      });
    };
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const stage = stageRef.current;
      if (!stage || !stage.isConnected || document.visibilityState === "hidden") { apply(null); return; }
      const box = stage.getBoundingClientRect();
      const rect = { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
      if (rect.width < 2 || rect.height < 2) { apply(null); return; }
      const page = trimEdges(stage, rect);
      if (page.width < 2 * EDGE_TRIM || page.height < 2 * EDGE_TRIM) { apply(null); return; }
      apply(!overlayOver(stage, page) && stageUnobstructed(stage, page) ? page : null);
    };
    const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(measure); };
    schedule();
    const stage = stageRef.current;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (stage) resize?.observe(stage);
    // Overlays come and go as DOM: a menu or dialog that covers the stage
    // must step the page back the frame it appears.
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mutations?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "data-state"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    // Motion (a window gliding, a pane resizing) moves the stage without a
    // mutation of ours; a slow tick keeps the page on it.
    const tick = setInterval(schedule, 250);
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      clearInterval(tick);
      resize?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      if (placed.current) void bridge.place(viewId, null).catch(() => {});
      placed.current = null;
      setLive(false);
    };
  }, [active, viewId]);

  return active && live;
}
