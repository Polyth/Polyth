// Fixed-position anchoring for popovers, menus, and tooltips.
// Improvements over the legacy usePopoverPlacement:
//   * both axes: vertical flip AND horizontal clamping inside the viewport;
//   * keyboard-aware: the available band is the visual viewport, so a summoned
//     software keyboard can never hide an open popover (Mobile audit #3);
//   * returns a maxHeight so long surfaces scroll internally instead of
//     overflowing the screen.
import { useLayoutEffect, useState, type RefObject } from "react";

export type AnchoredAlign = "start" | "center" | "end";
export type AnchoredSide = "down" | "up";

export interface AnchoredPositionOptions {
  /** Horizontal alignment against the anchor (default start = left edges). */
  align?: AnchoredAlign;
  /** Gap between anchor and surface in px (default 6). */
  gap?: number;
  /** Safety margin against the viewport edges in px (default 8). */
  margin?: number;
  /** Preferred vertical side (default down). */
  side?: AnchoredSide;
  /** Keep the opening anchor rectangle during content-driven layout changes. */
  stableAnchor?: boolean;
}

export interface AnchoredPosition {
  top: number;
  left: number;
  side: AnchoredSide;
  maxHeight: number;
  maxWidth: number;
  /** False until the first measurement (render the surface invisible). */
  ready: boolean;
}

const INITIAL: AnchoredPosition = { top: 0, left: 0, side: "down", maxHeight: 0, maxWidth: 0, ready: false };

/** The band the user can actually see: honors the software keyboard. */
function visibleBand(): { top: number; bottom: number; left: number; right: number } {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (vv) {
    return {
      top: vv.offsetTop,
      bottom: vv.offsetTop + vv.height,
      left: vv.offsetLeft,
      right: vv.offsetLeft + vv.width,
    };
  }
  return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
}

export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  surfaceRef: RefObject<HTMLElement | null>,
  { align = "start", gap = 6, margin = 8, side = "down", stableAnchor = false }: AnchoredPositionOptions = {},
): AnchoredPosition {
  const [position, setPosition] = useState<AnchoredPosition>(INITIAL);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(INITIAL);
      return;
    }

    let openingAnchor: DOMRect | undefined;
    const update = () => {
      const anchor = anchorRef.current;
      const surface = surfaceRef.current;
      if (!anchor || !surface) return;
      const band = visibleBand();
      const anchorRect = stableAnchor
        ? (openingAnchor ??= anchor.getBoundingClientRect())
        : anchor.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();

      const below = band.bottom - anchorRect.bottom - gap - margin;
      const above = anchorRect.top - band.top - gap - margin;
      const fits = (space: number) => surfaceRect.height <= space;
      const resolvedSide: AnchoredSide =
        side === "down"
          ? (fits(below) || below >= above ? "down" : "up")
          : (fits(above) || above >= below ? "up" : "down");
      const space = resolvedSide === "down" ? below : above;
      const maxHeight = Math.max(0, Math.min(space, band.bottom - band.top - 2 * margin));
      const height = Math.min(surfaceRect.height, maxHeight);
      const preferredTop = resolvedSide === "down"
        ? anchorRect.bottom + gap
        : anchorRect.top - gap - height;
      const top = Math.max(band.top + margin, Math.min(preferredTop, band.bottom - margin - height));

      const maxWidth = Math.max(0, band.right - band.left - 2 * margin);
      const width = Math.min(surfaceRect.width, maxWidth);
      let left =
        align === "start" ? anchorRect.left
        : align === "end" ? anchorRect.right - width
        : anchorRect.left + (anchorRect.width - width) / 2;
      left = Math.min(Math.max(left, band.left + margin), band.right - margin - width);

      setPosition((previous) => {
        const next: AnchoredPosition = { top, left, side: resolvedSide, maxHeight, maxWidth, ready: true };
        return previous.ready
          && previous.top === next.top
          && previous.left === next.left
          && previous.side === next.side
          && previous.maxHeight === next.maxHeight
          && previous.maxWidth === next.maxWidth
          ? previous
          : next;
      });
    };

    update();
    const frame = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [open, anchorRef, surfaceRef, align, gap, margin, side, stableAnchor]);

  return position;
}
