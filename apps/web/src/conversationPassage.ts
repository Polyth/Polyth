// Landing on a passage inside a message: a saved heading or selection, found in
// the rendered text and briefly lit with the CSS Custom Highlight API, which
// paints without touching the message's DOM.
const HIGHLIGHT_NAME = "polyth-reveal";
const HIGHLIGHT_MS = 2_400;

export interface PassageLocation {
  startSegment: number;
  startOffset: number;
  endSegment: number;
  /** Exclusive. */
  endOffset: number;
}

const SPACE = /\s/;

/** Find a passage across text segments. Whitespace is ignored on both sides: a
 *  selection's line breaks never match the rendered text exactly, and two blocks'
 *  text nodes have nothing between them. */
export function locatePassage(segments: readonly string[], passage: string): PassageLocation | null {
  const needle = passage.replace(/\s+/g, "").toLocaleLowerCase();
  if (!needle) return null;
  let compact = "";
  const owners: Array<{ segment: number; offset: number }> = [];
  segments.forEach((text, segment) => {
    for (let offset = 0; offset < text.length; offset += 1) {
      const char = text[offset]!;
      if (SPACE.test(char)) continue;
      // Case folding can change a string's length, so fold one character at a
      // time and give every resulting character the same owner.
      const folded = char.toLocaleLowerCase();
      compact += folded;
      for (let index = 0; index < folded.length; index += 1) owners.push({ segment, offset });
    }
  });
  const at = compact.indexOf(needle);
  if (at < 0) return null;
  const first = owners[at]!;
  const last = owners[at + needle.length - 1]!;
  return { startSegment: first.segment, startOffset: first.offset, endSegment: last.segment, endOffset: last.offset + 1 };
}

let clearTimer: ReturnType<typeof setTimeout> | undefined;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

/** Scroll to a passage inside a row and light it for a moment. False when the
 *  passage is not in the row any more: the row itself is still on screen. */
export function landOnPassage(row: Element, passage: string): boolean {
  const root = row.querySelector(".bubble") ?? row;
  const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  const found = locatePassage(nodes.map((node) => node.data), passage);
  if (!found) return false;
  const range = document.createRange();
  range.setStart(nodes[found.startSegment]!, found.startOffset);
  range.setEnd(nodes[found.endSegment]!, found.endOffset);
  nodes[found.startSegment]!.parentElement?.scrollIntoView({ block: "center", behavior: "auto" });
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (range: Range) => unknown }).Highlight;
  if (registry && Highlight) {
    clearTimeout(clearTimer);
    registry.set(HIGHLIGHT_NAME, new Highlight(range));
    clearTimer = setTimeout(() => registry.delete(HIGHLIGHT_NAME), HIGHLIGHT_MS);
  }
  return true;
}

export interface ReadingPosition {
  eventSeq: number;
  /** The nearest heading above the reading line inside that answer. */
  heading?: string;
}

/** The answer a person is reading: the last one starting above the middle of the
 *  visible area, or the first one on screen. */
export function readingPositionIn(timeline: Element, area: { top: number; bottom: number }): ReadingPosition | null {
  const middle = (area.top + area.bottom) / 2;
  let row: HTMLElement | null = null;
  for (const candidate of timeline.querySelectorAll<HTMLElement>(".msg.assistant[data-message-seq]")) {
    const box = candidate.getBoundingClientRect();
    if (box.bottom <= area.top || box.top >= area.bottom) continue;
    if (!row || box.top <= middle) row = candidate;
  }
  const eventSeq = Number(row?.dataset.messageSeq);
  if (!row || !Number.isSafeInteger(eventSeq) || eventSeq < 1) return null;
  let heading: string | undefined;
  for (const candidate of row.querySelectorAll("h1, h2, h3, h4")) {
    if (candidate.getBoundingClientRect().top > middle) break;
    heading = candidate.textContent?.trim() || heading;
  }
  return { eventSeq, ...(heading ? { heading } : {}) };
}
