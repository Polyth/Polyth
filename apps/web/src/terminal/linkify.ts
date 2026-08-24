// Implicit URL detection on rendered terminal rows (pure). OSC 8 hyperlinks
// come from the emulator's cell metadata; this covers plain printed URLs.

export interface LinkRange {
  /** Text index range [start, end). */
  start: number;
  end: number;
  url: string;
}

const URL_RE = /(?:https?|file):\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?'"）)>\]}]+$/;

/** Find URL ranges in one row of text; trailing punctuation is trimmed and
 *  a close-paren is kept only when the URL contains a matching open-paren. */
export function detectLinks(text: string): LinkRange[] {
  if (!text.includes("://")) return [];
  const out: LinkRange[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    let url = m[0]!;
    // trim trailing punctuation that is prose, not URL
    let trimmed = url.replace(TRAILING, "");
    // re-allow one trailing ")" for URLs like https://x/y_(z)
    if (url.length > trimmed.length && url[trimmed.length] === ")") {
      const opens = (trimmed.match(/\(/g) ?? []).length;
      const closes = (trimmed.match(/\)/g) ?? []).length;
      if (opens > closes) trimmed += ")";
    }
    url = trimmed;
    if (url.length < 10) continue;
    out.push({ start: m.index, end: m.index + url.length, url });
    if (out.length >= 32) break;
  }
  return out;
}
