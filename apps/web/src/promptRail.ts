// Pure geometry for the prompt navigator tick tape (Timeline right rail).
// Implements a bounded tape of at most MAX_TICKS thin ticks at a fixed pitch,
// widths that grow for the active turn and swell in a proximity wave around
// the cursor, plus a window that keeps the active tick visible when there are
// more prompts than ticks. Its slots and supplied mark widths are scaled by
// 15%; CSS keeps those larger hit slots while painting the marks at their
// original compact proportions.

export const RAIL_MAX_TICKS = 30;
export const RAIL_VISUAL_SCALE = 1.15;
const scaledRailPx = (value: number): number => Number((value * RAIL_VISUAL_SCALE).toFixed(2));
export const RAIL_TICK_PITCH = scaledRailPx(8);
export const RAIL_BASE_WIDTH = scaledRailPx(7);
export const RAIL_ACTIVE_WIDTH = scaledRailPx(14);
export const RAIL_CURSOR_WIDTH = scaledRailPx(20);
export const RAIL_CURSOR_NEAR_WIDTH = scaledRailPx(12);
export const RAIL_PANEL_ROWS = 8;
/** Clearance between the tape and the nearest edge or shell chrome. */
export const RAIL_EDGE_GAP = 4;

export type PromptRailSide = "left" | "right";

/** Horizontal extent of a box, in viewport px (a DOMRect satisfies it). */
export interface RailBox { left: number; right: number; top: number; bottom: number }

/** Distance from the chosen edge of the chat viewport at which the tape sits.
 *  Shell chrome that overlays that edge (the floating launcher strip, a
 *  slide-over pane, a collapsed navigator drawn over the workspace) pushes it
 *  inward; chrome beside the viewport (an in-flow sidebar or pinned pane)
 *  costs nothing, so the tape always hugs the visible edge of the chat. */
export function promptRailInset(viewport: RailBox, obstacles: readonly RailBox[], side: PromptRailSide): number {
  const width = viewport.right - viewport.left;
  let covered = 0;
  for (const box of obstacles) {
    if (box.right <= box.left || box.bottom <= box.top) continue;
    if (box.bottom <= viewport.top || box.top >= viewport.bottom) continue;
    if (box.right <= viewport.left || box.left >= viewport.right) continue;
    const depth = side === "right" ? viewport.right - box.left : box.right - viewport.left;
    // Chrome that covers most of the chat (a fullscreen package) is not an
    // edge strip; the tape is hidden beneath it anyway.
    if (depth > 0 && depth < width / 2) covered = Math.max(covered, depth);
  }
  return Math.round(covered) + RAIL_EDGE_GAP;
}

/** Slice of prompt indexes shown as ticks: the whole list when it fits,
 *  otherwise a MAX_TICKS window centered on the active prompt. */
export function railWindow(
  total: number,
  activeIndex: number,
  maxTicks: number = RAIL_MAX_TICKS,
): { start: number; end: number } {
  if (total <= maxTicks) return { start: 0, end: total };
  const centered = (activeIndex >= 0 ? activeIndex : total - 1) - Math.floor(maxTicks / 2);
  const start = Math.max(0, Math.min(centered, total - maxTicks));
  return { start, end: start + maxTicks };
}

/** Visual width of one tick. While navigating, the cursor owns the emphasis:
 *  the hovered tick is largest, its immediate neighbour is smaller, and all
 *  remaining ticks use the compact base level. */
export function tickWidth(index: number, activeIndex: number, cursorIndex: number): number {
  if (cursorIndex >= 0) {
    const distance = Math.abs(index - cursorIndex);
    return distance === 0 ? RAIL_CURSOR_WIDTH
      : distance === 1 ? RAIL_CURSOR_NEAR_WIDTH : RAIL_BASE_WIDTH;
  }
  return index === activeIndex ? RAIL_ACTIVE_WIDTH : RAIL_BASE_WIDTH;
}

/** Map a pointer offset (px from the top of the tape) to a tick index within
 *  the visible window; -1 when outside the tape. */
export function cursorTickIndex(offsetY: number, visibleCount: number, pitch: number = RAIL_TICK_PITCH): number {
  if (visibleCount <= 0 || offsetY < 0) return -1;
  const index = Math.floor(offsetY / pitch);
  return index >= visibleCount ? -1 : index;
}

/** Leading block markup that reads as noise in a one-line label: heading
 *  hashes, quote marks, list bullets and ordered-list numbers. */
const ROW_LEADING_MARKUP = /^(?:#{1,6}\s+|>\s+|[-*+•]\s+|\d{1,3}[.)]\s+)+/u;
/** A first word that is plain prose: lowercase letters, optionally joined by an
 *  apostrophe or hyphen. Commands, mentions, paths, identifiers and camelCase
 *  ("iPhone", "/review", "src/app.ts", "npm_run", "http://…") keep their spelling. */
const ROW_PROSE_WORD = /^\p{Ll}+(?:['’-]\p{Ll}+)*(?=$|[\s,;!?…)]|[.:](?:\s|$))/u;

/** Display label of one prompt row: whitespace collapsed, leading markdown
 *  markers dropped and an ordinary first word capitalized, so the list reads as
 *  sentences rather than raw input. Presentation-only; the stored prompt and
 *  its jump target are unchanged. */
export function promptRowLabel(preview: string): string {
  const text = preview.replace(/\s+/gu, " ").trim().replace(ROW_LEADING_MARKUP, "");
  if (!ROW_PROSE_WORD.test(text)) return text;
  const [first = "", ...rest] = Array.from(text);
  return first.toUpperCase() + rest.join("");
}

/** Viewport tops of the rendered prompt rows, in `ids` order (null = not
 *  rendered). One subtree walk per call: the scroll-spy runs every scroll
 *  frame, and a per-prompt `querySelector` walked the whole transcript once
 *  for each prompt — mostly to find rows windowed out of the DOM. The first
 *  match in document order wins, as `querySelector` did. */
export function promptRowTops(
  timeline: { querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null; getBoundingClientRect(): { top: number } }> },
  ids: readonly string[],
): Array<number | null> {
  const wanted = new Set(ids);
  const tops = new Map<string, number>();
  for (const node of timeline.querySelectorAll("[data-msg-id]")) {
    const id = node.getAttribute("data-msg-id");
    if (id === null || !wanted.has(id) || tops.has(id)) continue;
    tops.set(id, node.getBoundingClientRect().top);
  }
  return ids.map((id) => tops.get(id) ?? null);
}

/** Scroll-spy: which prompt is the "current turn" given each prompt row's top
 *  offset relative to the scroll container (null = row not rendered, i.e.
 *  windowed out above) and a reading line offset. The active prompt is the
 *  last one at or above the line; when every rendered prompt sits below it,
 *  the newest windowed-out prompt (just above the first rendered one) wins. */
export function activePromptIndex(tops: Array<number | null>, readingLine: number): number {
  let active = -1;
  let firstRendered = -1;
  for (let i = 0; i < tops.length; i += 1) {
    const top = tops[i];
    if (top === null || top === undefined) continue;
    if (firstRendered < 0) firstRendered = i;
    if (top <= readingLine) active = i;
  }
  if (active >= 0) return active;
  if (firstRendered > 0) return firstRendered - 1;
  return tops.length > 0 ? 0 : -1;
}
