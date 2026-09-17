// Fixed-position anchoring for popovers, menus, and tooltips.
// Improvements over the legacy usePopoverPlacement:
//   * both axes: vertical flip AND horizontal clamping inside the viewport;
//   * keyboard-aware: the available band is the visual viewport, so a summoned
//     software keyboard can never hide an open popover (Mobile audit #3);
//   * safe-area aware: honors `--safe-*` / env(safe-area-inset-*);
//   * compact phone pickers: capped width/height, finger-zone horizontal overlap;
//   * returns a maxHeight so long surfaces scroll internally instead of
//     overflowing the screen.
import { useLayoutEffect, useState, type RefObject } from "react";

export type AnchoredAlign = "start" | "center" | "end";
export type AnchoredSide = "down" | "up" | "left" | "right";

export interface AnchoredPositionOptions {
  /** Alignment on the axis perpendicular to the side (default start). */
  align?: AnchoredAlign;
  /** Gap between anchor and surface in px (default 6). */
  gap?: number;
  /** Safety margin against the viewport edges in px (default 8). */
  margin?: number;
  /** Preferred side (default down). */
  side?: AnchoredSide;
  /** Keep the opening anchor rectangle during content-driven layout changes. */
  stableAnchor?: boolean;
  /** Compact phone picker caps: ~360px width, ~52% visual viewport height. */
  compact?: boolean;
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

const COMPACT_MAX_WIDTH = 360;
const COMPACT_MAX_VH = 0.52;

function readPx(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeInsets(): { top: number; right: number; bottom: number; left: number } {
  if (typeof document === "undefined") {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const styles = getComputedStyle(document.documentElement);
  return {
    top: readPx(styles.getPropertyValue("--safe-top")),
    right: readPx(styles.getPropertyValue("--safe-right")),
    bottom: readPx(styles.getPropertyValue("--safe-bottom")),
    left: readPx(styles.getPropertyValue("--safe-left")),
  };
}

function screenGutter(): number {
  if (typeof document === "undefined") return 8;
  const styles = getComputedStyle(document.documentElement);
  return readPx(styles.getPropertyValue("--screen-gutter")) || 8;
}

function visualViewportHeight(): number {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  return vv?.height ?? window.innerHeight;
}

/** The band the user can actually see: honors the software keyboard. */
function visibleBand(): { top: number; bottom: number; left: number; right: number } {
  const safe = safeInsets();
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (vv) {
    return {
      top: vv.offsetTop + safe.top,
      bottom: vv.offsetTop + vv.height - safe.bottom,
      left: vv.offsetLeft + safe.left,
      right: vv.offsetLeft + vv.width - safe.right,
    };
  }
  return {
    top: safe.top,
    bottom: window.innerHeight - safe.bottom,
    left: safe.left,
    right: window.innerWidth - safe.right,
  };
}

function overlapLeft(
  left: number,
  width: number,
  anchorRect: DOMRect,
  bandLeft: number,
  bandRight: number,
): number {
  const anchorLeft = anchorRect.left;
  const anchorRight = anchorRect.right;
  if (left + width < anchorLeft) left = anchorLeft;
  if (left > anchorRight) left = Math.max(anchorLeft, anchorRight - width);
  return Math.max(bandLeft, Math.min(left, bandRight - width));
}

export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  surfaceRef: RefObject<HTMLElement | null>,
  { align = "start", gap = 6, margin = 8, side = "down", stableAnchor = false, compact = false }: AnchoredPositionOptions = {},
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
      const edgeMargin = compact ? Math.max(margin, screenGutter()) : margin;
      const anchorRect = stableAnchor
        ? (openingAnchor ??= anchor.getBoundingClientRect())
        : anchor.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();

      const horizontal = side === "left" || side === "right";
      let resolvedSide: AnchoredSide;
      let maxHeight: number;
      let maxWidth: number;
      let height: number;
      let width: number;
      let top: number;
      let left: number;

      if (horizontal) {
        const after = band.right - anchorRect.right - gap - edgeMargin;
        const before = anchorRect.left - band.left - gap - edgeMargin;
        const fits = (space: number) => surfaceRect.width <= space;
        resolvedSide = side === "right"
          ? (fits(after) || after >= before ? "right" : "left")
          : (fits(before) || before >= after ? "left" : "right");
        const space = resolvedSide === "right" ? after : before;
        maxWidth = Math.max(0, Math.min(space, band.right - band.left - 2 * edgeMargin));
        width = Math.min(surfaceRect.width, maxWidth);
        const preferredLeft = resolvedSide === "right"
          ? anchorRect.right + gap
          : anchorRect.left - gap - width;
        left = Math.max(band.left + edgeMargin, Math.min(preferredLeft, band.right - edgeMargin - width));

        maxHeight = Math.max(0, band.bottom - band.top - 2 * edgeMargin);
        if (compact) {
          maxHeight = Math.min(maxHeight, visualViewportHeight() * COMPACT_MAX_VH);
        }
        height = Math.min(surfaceRect.height, maxHeight);
        const preferredTop =
          align === "start" ? anchorRect.top
          : align === "end" ? anchorRect.bottom - height
          : anchorRect.top + (anchorRect.height - height) / 2;
        top = Math.max(band.top + edgeMargin, Math.min(preferredTop, band.bottom - edgeMargin - height));
      } else {
        const below = band.bottom - anchorRect.bottom - gap - edgeMargin;
        const above = anchorRect.top - band.top - gap - edgeMargin;
        const fits = (space: number) => surfaceRect.height <= space;
        resolvedSide = side === "down"
          ? (fits(below) || below >= above ? "down" : "up")
          : (fits(above) || above >= below ? "up" : "down");
        const space = resolvedSide === "down" ? below : above;
        maxHeight = Math.max(0, Math.min(space, band.bottom - band.top - 2 * edgeMargin));
        if (compact) {
          maxHeight = Math.min(maxHeight, visualViewportHeight() * COMPACT_MAX_VH);
        }
        height = Math.min(surfaceRect.height, maxHeight);
        const preferredTop = resolvedSide === "down"
          ? anchorRect.bottom + gap
          : anchorRect.top - gap - height;
        top = Math.max(band.top + edgeMargin, Math.min(preferredTop, band.bottom - edgeMargin - height));

        const bandWidth = band.right - band.left - 2 * edgeMargin;
        maxWidth = Math.max(0, compact
          ? Math.min(bandWidth, COMPACT_MAX_WIDTH)
          : bandWidth);
        width = Math.min(surfaceRect.width, maxWidth);
        const preferredLeft =
          align === "start" ? anchorRect.left
          : align === "end" ? anchorRect.right - width
          : anchorRect.left + (anchorRect.width - width) / 2;
        left = compact
          ? overlapLeft(preferredLeft, width, anchorRect, band.left + edgeMargin, band.right - edgeMargin)
          : Math.min(Math.max(preferredLeft, band.left + edgeMargin), band.right - edgeMargin - width);
      }

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
  }, [open, anchorRef, surfaceRef, align, gap, margin, side, stableAnchor, compact]);

  return position;
}
