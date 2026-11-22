/** Whether the header's session overview shows. The status line above the
 *  composer opens the agent activity panel instead (SessionActivityPanel.tsx),
 *  so a popover opened from that line closes the header overview. The
 *  presentation depends on the semantic opener, never the anchor's CSS. */
export function sessionOverviewMode(
  headerOpen: boolean,
  popover: { open: boolean; source: "header" | "dock" | null },
): "closed" | "full" {
  if (popover.open) return popover.source === "dock" ? "closed" : "full";
  return headerOpen ? "full" : "closed";
}
