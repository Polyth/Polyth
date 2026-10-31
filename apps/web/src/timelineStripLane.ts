import { useLayoutEffect, type RefObject } from "react";
import { shellBarReserves } from "./shellLayout.ts";

/** A box in viewport px (a DOMRect satisfies it). */
export interface LaneBox { left: number; right: number; top: number; bottom: number }

/** The transcript's lane on its scrollbar side (inline end: right in LTR,
 *  left in RTL): how far an overlay reaches into it, plus the shell's column
 *  gap, so the scrollbar stops that gap before the overlay instead of sitting
 *  under it at the window edge. 0 when nothing overlaps that side. */
export function timelineStripLane(timeline: LaneBox, overlays: readonly LaneBox[], gap: number, rtl: boolean): number {
  const beside = overlays.filter((o) => o.bottom > timeline.top && o.top < timeline.bottom);
  const reserve = shellBarReserves(timeline, beside, gap);
  return rtl ? reserve.left : reserve.right;
}

/** The overlay that floats over the workspace edge while no pane is open: the
 *  idle launcher strip (the wide shell's full-height column, the tablet
 *  band's cluster). An open pane sits in flow beside the workspace, or is a
 *  package window laid over Chat on purpose, so neither moves the scrollbar. */
const IDLE_RAILBAR = ":scope > .railbar:not(.railbar-open)";

/** Publish the lane as --timeline-strip-lane on the scroll root: styles.css
 *  turns it into a transparent inline-end border, inside which the scrollbar
 *  sits, and gives the same width back from the inline-end padding, so the
 *  reading column stays centred on the whole workspace. */
export function useTimelineStripLane(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const timeline = ref.current;
    const shell = timeline?.closest<HTMLElement>(".app-shell");
    if (!timeline || !shell) return;
    let last = 0;
    const publish = () => {
      const strip = shell.querySelector<HTMLElement>(IDLE_RAILBAR);
      const overlays = strip?.getClientRects().length ? [strip.getBoundingClientRect()] : [];
      const gap = Number.parseFloat(getComputedStyle(shell).columnGap) || 0;
      const rtl = getComputedStyle(timeline).direction === "rtl";
      const lane = timelineStripLane(timeline.getBoundingClientRect(), overlays, gap, rtl);
      if (lane === last) return;
      last = lane;
      if (lane) timeline.style.setProperty("--timeline-strip-lane", `${lane}px`);
      else timeline.style.removeProperty("--timeline-strip-lane");
    };
    publish();
    if (typeof ResizeObserver !== "function" || typeof MutationObserver !== "function") {
      return () => timeline.style.removeProperty("--timeline-strip-lane");
    }
    // The railbar docks and undocks by animation, which no observer reports.
    let railbar: Element | null = null;
    const settled = (event: Event) => { if (event.target === railbar) publish(); };
    const resize = new ResizeObserver(publish);
    const mutations = new MutationObserver(() => {
      watch();
      publish();
    });
    // The railbar mounts, unmounts and opens a pane (its class) without
    // always resizing what is observed.
    const watch = () => {
      resize.disconnect();
      resize.observe(timeline);
      resize.observe(shell);
      railbar?.removeEventListener("animationend", settled);
      railbar?.removeEventListener("transitionend", settled);
      railbar = shell.querySelector(":scope > .railbar");
      if (!railbar) return;
      resize.observe(railbar);
      mutations.observe(railbar, { attributes: true, attributeFilter: ["class", "data-rail-strip"] });
      railbar.addEventListener("animationend", settled);
      railbar.addEventListener("transitionend", settled);
    };
    mutations.observe(shell, { childList: true });
    // A mirrored shell or another window layout moves the strip without
    // resizing it.
    if (shell.parentElement) mutations.observe(shell.parentElement, { attributes: true, attributeFilter: ["data-shell-mirror"] });
    mutations.observe(document.body, { attributes: true, attributeFilter: ["data-shell-layout", "data-shell-floating"] });
    watch();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      railbar?.removeEventListener("animationend", settled);
      railbar?.removeEventListener("transitionend", settled);
      timeline.style.removeProperty("--timeline-strip-lane");
    };
  }, [ref]);
}
