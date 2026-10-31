// Selection quick actions: pure text helpers behind the
// transcript-selection surfaces. All DOM stays in SelectionMenu.tsx and
// SelectionDock.tsx — these are the testable bits: markdown quoting for the
// composer, a session title derived from the selection, viewport clamping for
// the floating menu, and the touch dock's surface choice and drag physics.

import { tr } from "./i18n/index.ts";

const MAX_QUOTE_CHARS = 4000;

/** Markdown-quote a transcript selection for the composer: every line gets a
 *  "> " prefix (bare ">" for blank lines so the quote stays one block), output
 *  is capped so a select-all cannot flood the draft, and a trailing blank line
 *  leaves the caret ready for the reply. Empty selections quote to "". */
export function quoteForReply(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  const clipped = text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}…` : text;
  return `${clipped.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n")}\n\n`;
}

/** Session title for "new session from selection": first non-empty line, clipped. */
export function selectionTitle(raw: string, cap = 60): string {
  const first = raw.replace(/\r\n?/g, "\n").split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!first) return tr("selectionActions.fromSelection");
  return first.length > cap ? `${first.slice(0, cap - 1)}…` : first;
}

/** Keep the floating menu fully inside the viewport (8px margin). */
export function clampMenuPosition(
  x: number, y: number, menuW: number, menuH: number, vw: number, vh: number,
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, vw - menuW - 8)),
    y: Math.max(8, Math.min(y, vh - menuH - 8)),
  };
}

/** Which selection surface a transcript selection gets. Touch and pen
 *  selections get the bottom dock: the OS draws its own callout beside the
 *  selection, and a floating toolbar there would fight it and the handles.
 *  Without a pointer signal yet, the phone shell decides. */
export type SelectionSurface = "dock" | "float";

export function selectionSurface(
  shellMode: "wide" | "compact" | "phone",
  pointerType: string | null,
): SelectionSurface {
  if (pointerType === "touch" || pointerType === "pen") return "dock";
  if (pointerType) return "float";
  return shellMode === "phone" ? "dock" : "float";
}

/** Drag offset for the selection dock: downward follows the finger, upward
 *  resists (rubber band) so the dock never detaches from the bottom edge. */
export function dockDragOffset(dy: number): number {
  if (dy >= 0) return dy;
  return -Math.min(18, Math.sqrt(-dy) * 2);
}

/** A released drag dismisses past ~40% of the dock height or on a downward
 *  flick (px/ms); otherwise the dock settles back. */
export function dockDragDismisses(offset: number, velocity: number, height: number): boolean {
  if (offset <= 0) return false;
  return offset > Math.max(48, height * 0.4) || (velocity > 0.45 && offset > 12);
}
