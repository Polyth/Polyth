// A status-bar end shows whole segments or none of them. When an end is too
// narrow for what it holds, the lowest-priority segments leave the layout (and
// the tab order) instead of being squeezed into ellipses or clipped half-visible.
//
// Priority is the user's own arrangement: the last segment goes first. A segment
// that carries `data-fit-keep` (a workflow run waiting on the user, a reconnect
// action) is only dropped after everything else has been.
import { useLayoutEffect, type RefObject } from "react";

const HIDDEN_ATTRIBUTE = "data-fit";
const TOLERANCE = 0.5;

/** Indices in the order they should be dropped: unprotected segments from the
 *  end first, then protected ones from the end. */
export function hideOrder(keep: readonly boolean[]): number[] {
  const indices = keep.map((_, index) => index);
  return [
    ...indices.filter((index) => !keep[index]).reverse(),
    ...indices.filter((index) => keep[index]).reverse(),
  ];
}

/** Drop segments in priority order until `overflows` reports that what is left
 *  fits. Pure: the caller owns how overflow is measured. */
export function chooseHidden(
  keep: readonly boolean[],
  overflows: (hidden: ReadonlySet<number>) => boolean,
): Set<number> {
  const hidden = new Set<number>();
  for (const index of hideOrder(keep)) {
    if (!overflows(hidden)) break;
    hidden.add(index);
  }
  return hidden;
}

// A placed mini-widget is a segment once it renders something; a slot
// contribution drawn straight into the end is one as it is.
const isSegment = (node: Element): node is HTMLElement =>
  node instanceof HTMLElement && (!node.classList.contains("placed-mini-widget") || node.firstElementChild !== null);

const pastEdge = (rect: DOMRect, box: DOMRect): boolean =>
  rect.width > 0 && (rect.right > box.right + TOLERANCE || rect.left < box.left - TOLERANCE);

/** Re-fit one end against its current width. Safe to call repeatedly. */
export function fitSegments(cluster: HTMLElement): void {
  const segments = Array.from(cluster.children).filter(isSegment);
  const apply = (hidden: ReadonlySet<number>) => {
    segments.forEach((segment, index) => {
      if (hidden.has(index)) segment.setAttribute(HIDDEN_ATTRIBUTE, "hidden");
      else segment.removeAttribute(HIDDEN_ATTRIBUTE);
    });
  };
  const keep = segments.map((segment) => segment.querySelector("[data-fit-keep]") !== null);
  const overflows = (hidden: ReadonlySet<number>) => {
    apply(hidden);
    const box = cluster.getBoundingClientRect();
    // Look at every descendant: a wrapper or a live-region span can be
    // `display: contents` and so has no box of its own to measure.
    return segments.some((segment, index) =>
      !hidden.has(index)
      && [segment, ...Array.from(segment.querySelectorAll("*"))].some((node) => pastEdge(node.getBoundingClientRect(), box)));
  };
  apply(chooseHidden(keep, overflows));
}

/** Keep an end fitted as its width, its widgets and their content change. */
export function useSegmentFit(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const cluster = ref.current;
    if (!cluster || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; fitSegments(cluster); });
    };
    fitSegments(cluster);
    const resize = new ResizeObserver(schedule);
    resize.observe(cluster);
    // Attributes are deliberately not observed: fitting writes one.
    const mutate = new MutationObserver(schedule);
    mutate.observe(cluster, { childList: true, subtree: true, characterData: true });
    // Web fonts that land late change every segment's width without any
    // mutation or resize of the end itself.
    document.fonts?.addEventListener?.("loadingdone", schedule);
    return () => {
      resize.disconnect();
      mutate.disconnect();
      document.fonts?.removeEventListener?.("loadingdone", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
