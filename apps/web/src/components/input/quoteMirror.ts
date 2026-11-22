// Quote mirror: a draft's Markdown quotes read in the composer the way they
// read in the transcript (an accent bar, a quiet fill, dim ink, no `>` marks),
// while the field stays a plain IME-safe textarea that owns every character.
//
// A text layer under the field repeats its text line by line with identical
// metrics; the field's own glyphs turn transparent (`-webkit-text-fill-color`,
// so the caret keeps the ink colour) only while the draft holds a quote. The
// draft string, sending and history never change: this is presentation only.
//
// The field's line boxes are fixed, so the band cannot get the transcript's
// vertical padding from extra space. Instead it reaches into a blank line next
// to the quote (a quote reply is followed by one): that line reads as the
// band's padding plus the gap before the reply.

import { quoteLineMask } from "../../markdown/parse.ts";

/** One textarea line as the mirror draws it. `marker` is the leading `>`
 *  run (kept as transparent text so every later glyph stays aligned). */
export interface MirrorLine {
  text: string;
  marker: string;
  /** Position inside a run of quote lines, for the band's rounded ends. */
  edge?: "first" | "last" | "only" | "middle";
  /** The band may reach into the blank line (or the field's padding) above
   *  or below this run end. */
  reach?: "start" | "end" | "both";
}

const QUOTE_MARKER_RE = /^[ \t]*>(?:[ \t]?>)*[ \t]?/;
const HAS_QUOTE_RE = /(?:^|\n)[ \t]*>/;

/** Whether any line of the draft renders as a Markdown quote. The regex
 *  keeps ordinary keystrokes in quote-free drafts cheap. */
export function hasQuote(text: string): boolean {
  return HAS_QUOTE_RE.test(text) && quoteLineMask(text).includes(true);
}

/** Split a draft into mirror lines. Quote lines are exactly the ones the
 *  transcript renders as a quote (`quoteLineMask`): a `>` inside a code fence
 *  or a math block stays plain text. */
export function mirrorLines(text: string): MirrorLine[] {
  const raw = text.split("\n");
  const mask = quoteLineMask(text);
  const lines: MirrorLine[] = raw.map((line, i) => {
    const m = mask[i] ? QUOTE_MARKER_RE.exec(line) : null;
    return m ? { text: line.slice(m[0].length), marker: m[0] } : { text: line, marker: "" };
  });
  const blank = (i: number) => i < 0 || i >= lines.length || (!lines[i]!.marker && !lines[i]!.text.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.marker) continue;
    const prev = i > 0 && lines[i - 1]!.marker !== "";
    const next = i + 1 < lines.length && lines[i + 1]!.marker !== "";
    line.edge = prev ? (next ? "middle" : "last") : (next ? "first" : "only");
    const up = !prev && blank(i - 1);
    const down = !next && blank(i + 1);
    if (up || down) line.reach = up && down ? "both" : up ? "start" : "end";
  }
  return lines;
}

/** Text metrics the layer copies so it wraps exactly like the field. */
const COPIED = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontKerning",
  "fontFeatureSettings", "fontVariationSettings", "fontVariantLigatures", "fontOpticalSizing",
  "lineHeight", "letterSpacing", "wordSpacing", "textTransform", "textIndent", "textAlign",
  "tabSize", "direction", "whiteSpace", "overflowWrap", "wordBreak", "hyphens",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "color",
] as const;

export interface QuoteMirror {
  /** Redraw after the field's value changed; cheap when nothing changed. */
  sync(): void;
  destroy(): void;
}

export const QUOTE_MIRROR_ATTR = "data-quote-mirror";

export function createQuoteMirror(field: HTMLTextAreaElement, layer: HTMLElement): QuoteMirror {
  let shownValue: string | null = null;
  let active = false;
  const doc = field.ownerDocument;

  const placeLayer = () => {
    const cs = doc.defaultView?.getComputedStyle(field);
    if (!cs) return;
    for (const key of COPIED) layer.style[key] = cs[key];
    layer.style.width = `${field.clientWidth}px`;
    layer.style.height = `${field.clientHeight}px`;
    // Place by measured rects rather than offsetTop: the field's offsetParent
    // is not always the layer's containing block (a `display: contents`
    // wrapper, a transformed ancestor on the phone rail).
    const f = field.getBoundingClientRect();
    const l = layer.getBoundingClientRect();
    const left = (parseFloat(layer.style.left) || 0) + (f.left + field.clientLeft - l.left);
    const top = (parseFloat(layer.style.top) || 0) + (f.top + field.clientTop - l.top);
    layer.style.left = `${Math.round(left * 100) / 100}px`;
    layer.style.top = `${Math.round(top * 100) / 100}px`;
    followScroll();
  };

  const followScroll = () => {
    layer.scrollTop = field.scrollTop;
    layer.scrollLeft = field.scrollLeft;
  };

  const draw = (value: string) => {
    const frag = doc.createDocumentFragment();
    for (const line of mirrorLines(value)) {
      const row = doc.createElement("div");
      row.className = line.marker ? "quote-mirror-line quote-mirror-quote" : "quote-mirror-line";
      if (line.edge) row.dataset.edge = line.edge;
      if (line.reach) row.dataset.reach = line.reach;
      if (line.marker) {
        const mark = doc.createElement("span");
        mark.className = "quote-mirror-mark";
        mark.textContent = line.marker;
        row.append(mark);
      }
      // An empty line still takes one line box, as it does in the field.
      row.append(line.text || "​");
      frag.append(row);
    }
    layer.replaceChildren(frag);
  };

  const show = (on: boolean) => {
    if (on === active) return;
    active = on;
    layer.hidden = !on;
    if (on) field.setAttribute(QUOTE_MIRROR_ATTR, "");
    else {
      field.removeAttribute(QUOTE_MIRROR_ATTR);
      layer.replaceChildren();
      shownValue = null;
    }
  };

  const sync = () => {
    const value = field.value;
    if (!hasQuote(value)) {
      show(false);
      return;
    }
    show(true);
    if (value !== shownValue) {
      shownValue = value;
      draw(value);
    }
    placeLayer();
  };

  // The field grows with its text after this sync (the host's resize effect)
  // and moves when rows open around it; follow both.
  const resize = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => { if (active) placeLayer(); })
    : null;
  resize?.observe(field);
  if (field.parentElement) resize?.observe(field.parentElement);
  const onScroll = () => { if (active) followScroll(); };
  field.addEventListener("scroll", onScroll, { passive: true });
  const onFocus = () => { if (active) placeLayer(); };
  field.addEventListener("focus", onFocus);

  return {
    sync,
    destroy() {
      resize?.disconnect();
      field.removeEventListener("scroll", onScroll);
      field.removeEventListener("focus", onFocus);
      show(false);
    },
  };
}
