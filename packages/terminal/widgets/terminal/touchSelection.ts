// Touch selection over the terminal's own cell grid (Termux style): a long
// press selects the word under the finger, moving the still-held finger
// extends it, and two handles adjust either end afterwards. Pure geometry;
// TermPane owns the gestures and rendering.
//
// The browser's own selection cannot serve the phone terminal: WebKit on iOS
// refuses a text-selection gesture outside the focused editable element, and
// the hidden input that holds the software keyboard is that element while
// the user types.
import type { TermPoint } from "./emulator.ts";

export interface TermSelection { anchor: TermPoint; focus: TermPoint }

export interface OrderedSelection { start: TermPoint; end: TermPoint }

/** A still finger turns into a selection after this long (the platforms use ~0.5 s). */
export const LONG_PRESS_MS = 450;
/** Travel that makes a press a scroll or drag instead of a long press. */
export const PRESS_SLOP_PX = 10;

export function comparePoints(a: TermPoint, b: TermPoint): number {
  return a.row - b.row || a.col - b.col;
}

export function orderedSelection(selection: TermSelection): OrderedSelection {
  return comparePoints(selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

/**
 * Extend a long-pressed word toward the finger. The word itself always stays
 * selected, so moving back over it shrinks the selection to the word rather
 * than to nothing.
 */
export function extendFromWord(word: OrderedSelection, point: TermPoint): TermSelection {
  if (comparePoints(point, word.start) < 0) return { anchor: word.end, focus: point };
  if (comparePoints(point, word.end) > 0) return { anchor: word.start, focus: point };
  return { anchor: word.start, focus: word.end };
}

/** The cell boundary one cell before `point`, wrapping to the previous row's end. */
function stepBack(point: TermPoint, cols: number): TermPoint {
  if (point.col > 0) return { row: point.row, col: point.col - 1 };
  return point.row > 0 ? { row: point.row - 1, col: Math.max(0, cols - 1) } : point;
}

/** The cell boundary one cell after `point`, wrapping to the next row's start. */
function stepForward(point: TermPoint, cols: number): TermPoint {
  return point.col < cols ? { row: point.row, col: point.col + 1 } : { row: point.row + 1, col: 1 };
}

/**
 * Move one handle to `point`. Handles never cross: like the platform handles
 * they stop one cell short of each other, so a selection never collapses.
 */
export function moveSelectionEdge(
  selection: OrderedSelection,
  edge: "start" | "end",
  point: TermPoint,
  cols: number,
): OrderedSelection {
  if (edge === "start") {
    const limit = stepBack(selection.end, cols);
    return { start: comparePoints(point, limit) > 0 ? limit : point, end: selection.end };
  }
  const limit = stepForward(selection.start, cols);
  return { start: selection.start, end: comparePoints(point, limit) < 0 ? limit : point };
}
