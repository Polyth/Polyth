// The one set of text rules every chat search follows — the server's session
// search, the command palette's chat rows and the instant list filters in the
// sidebar and phone navigator — so the same words find the same chats
// wherever they are typed. Pure and dependency-free: safe in the browser.

/** Most terms a query contributes; the rest of a pasted paragraph is noise. */
export const SEARCH_TERM_LIMIT = 12;

const COMBINING_MARKS = /[̀-ͯ]/g;
// Ukrainian writes its apostrophe four ways; each is one code unit, so mapping
// them to ASCII keeps highlight offsets aligned with the original text.
const APOSTROPHES = /[’ʼʹ`]/g;

/**
 * Case, diacritic and apostrophe fold. Unicode-aware (`toLowerCase`, never
 * SQLite's ASCII-only `lower()`), so «Пошук» finds «пошук» and "Café" finds
 * "cafe". Keeps the code-unit length for Latin and Cyrillic text.
 */
export function foldSearchText(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC").replace(APOSTROPHES, "'").toLowerCase();
}

/**
 * Folded search terms: whitespace-separated words, with a `"quoted phrase"`
 * kept as one term (it contains a space). Duplicates and quote characters are
 * dropped; at most {@link SEARCH_TERM_LIMIT} terms.
 */
export function searchTerms(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = foldSearchText((m[1] ?? m[2] ?? "").replace(/"/g, "").replace(/\s+/g, " ").trim());
    if (term && !out.includes(term)) out.push(term);
    if (out.length >= SEARCH_TERM_LIMIT) break;
  }
  return out;
}

/**
 * Prefix stem of an inflected word, so «пошуків» also finds «пошук» and
 * "messages" finds "message". Ukrainian and English endings are 1–3 letters;
 * keeping at least four (five for longer words) letters keeps a stem from
 * matching unrelated words. Numbers, paths, phrases and short words stay exact.
 */
export function searchTermStem(term: string): string | undefined {
  if (!/^\p{L}+$/u.test(term)) return undefined;
  const letters = [...term];
  if (letters.length < 4) return undefined;
  const keep = letters.length >= 6 ? Math.max(5, letters.length - 3) : 4;
  const stem = letters.slice(0, keep).join("");
  return stem === term ? undefined : stem;
}

/** Where `term` (or, failing that, its stem) first occurs in folded text. */
function termOccurrence(folded: string, term: string, from = 0): [number, number] | undefined {
  const at = folded.indexOf(term, from);
  if (at >= 0) return [at, at + term.length];
  const stem = searchTermStem(term);
  if (!stem) return undefined;
  const st = folded.indexOf(stem, from);
  return st >= 0 ? [st, st + stem.length] : undefined;
}

/** Whether one folded term occurs in text, exactly or by its stem. */
export function textHasTerm(text: string | null | undefined, term: string): boolean {
  return !!text && termOccurrence(foldSearchText(text), term) !== undefined;
}

/**
 * Every term occurs somewhere among `fields` — not necessarily in the same
 * one, so "auth fix" finds a chat titled "Auth" on branch `fix/login`.
 * An empty term list matches everything.
 */
export function matchesSearchTerms(fields: ReadonlyArray<string | null | undefined>, terms: readonly string[]): boolean {
  if (!terms.length) return true;
  const folded = fields.filter((f): f is string => !!f).map(foldSearchText);
  return terms.every((term) => folded.some((f) => termOccurrence(f, term) !== undefined));
}

/**
 * Highlight ranges for every term inside `text` (exact occurrences, or stem
 * occurrences when a term has no exact one), sorted, non-overlapping and
 * merged when adjacent. Returns no ranges rather than misaligned ones when
 * folding changes the string length.
 */
export function searchHighlightRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  if (!text) return [];
  const folded = foldSearchText(text);
  if (folded.length !== text.length) return [];
  const hits: Array<[number, number]> = [];
  for (const raw of terms) {
    const term = foldSearchText(raw);
    if (!term) continue;
    const needle = folded.includes(term) ? term : searchTermStem(term);
    if (!needle) continue;
    let from = 0;
    while (from <= folded.length - needle.length) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      hits.push([at, at + needle.length]);
      from = at + needle.length;
    }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of hits) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/**
 * A bounded excerpt of `text` around the first term occurrence, with the
 * highlight ranges inside it. Used where no full-text index made a snippet.
 */
export function searchExcerpt(text: string, terms: readonly string[], maxChars = 160): { snippet: string; ranges: Array<[number, number]> } {
  const flat = text.replace(/\s+/g, " ").trim();
  const ranges = searchHighlightRanges(flat, terms);
  if (flat.length <= maxChars) return { snippet: flat, ranges };
  const anchor = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, Math.min(anchor - Math.floor(maxChars / 2), flat.length - maxChars));
  if (start > 0) { const ws = flat.indexOf(" ", start); if (ws >= 0 && ws < anchor) start = ws + 1; }
  const end = Math.min(flat.length, start + maxChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const shift = prefix.length - start;
  return {
    snippet: `${prefix}${flat.slice(start, end)}${suffix}`,
    ranges: ranges
      .filter(([a, b]) => a >= start && b <= end)
      .map(([a, b]) => [a + shift, b + shift] as [number, number]),
  };
}
