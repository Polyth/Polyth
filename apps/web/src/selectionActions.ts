// F3 selection quick actions (OC#283, OC#1501): pure text helpers behind the
// floating transcript-selection menu. All DOM stays in SelectionMenu.tsx —
// these are the testable bits: markdown quoting for the composer, a session
// title derived from the selection, and viewport clamping for the menu.

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
