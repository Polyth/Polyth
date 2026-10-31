/** Presentation depends on the semantic opener, never the anchor's CSS. */
export function sessionOverviewMode(
  headerOpen: boolean,
  popover: { open: boolean; source: "header" | "dock" | null },
): "closed" | "full" | "details" {
  if (popover.open) return popover.source === "dock" ? "details" : "full";
  return headerOpen ? "full" : "closed";
}
