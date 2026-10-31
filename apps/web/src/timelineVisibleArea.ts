/** The phone session island floats over the scrollport. CSS publishes its
 * clearance here so scroll alignment and every row animation use the same
 * reading area as the mask and the first-row spacer. */
export function timelineVisibleArea(timeline: HTMLElement): { top: number; bottom: number; height: number; inset: number } {
  const rect = timeline.getBoundingClientRect();
  // Computed custom properties may still contain calc(...). The standard
  // scroll-padding property resolves that expression to a pixel length.
  let rawInset = Number.parseFloat(getComputedStyle(timeline).scrollPaddingTop);
  if (!Number.isFinite(rawInset)) {
    // Older WebViews can return an unresolved CSS math expression here. The
    // island itself still gives us the minimum safe boundary in that case.
    const island = timeline.closest<HTMLElement>(".app")?.querySelector<HTMLElement>(".mobile-session-floats");
    rawInset = island ? island.getBoundingClientRect().bottom - rect.top : 0;
  }
  const inset = Number.isFinite(rawInset) ? Math.max(0, Math.min(rawInset, rect.height)) : 0;
  return {
    top: rect.top + inset,
    bottom: rect.bottom,
    height: Math.max(0, rect.height - inset),
    inset,
  };
}
