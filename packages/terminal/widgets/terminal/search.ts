// Search across the terminal buffer (pure). Works on RowInfo snapshots so
// wide-glyph rows map text indexes back to grid columns for highlighting.
import type { RowInfo } from "./emulator.ts";

export interface TermMatch {
  row: number;
  /** Grid column range [startCol, endCol). */
  startCol: number;
  endCol: number;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
}

const MAX_MATCHES = 5000;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compile the query; invalid regexes return null (UI shows an error state). */
export function compileQuery(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  const flags = opts.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(opts.regex ? query : escapeRe(query), flags);
  } catch {
    return null;
  }
}

/** Scan every row for matches; column ranges account for wide glyphs. */
export function searchBuffer(
  rowInfo: (index: number) => RowInfo,
  rowCount: number,
  query: string,
  opts: SearchOptions = {},
): TermMatch[] {
  const re = compileQuery(query, opts);
  if (!re) return [];
  const out: TermMatch[] = [];
  for (let row = 0; row < rowCount && out.length < MAX_MATCHES; row++) {
    const info = rowInfo(row);
    if (!info.text) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(info.text)) !== null) {
      if (m[0]!.length === 0) { re.lastIndex++; continue; }
      const start = m.index;
      const end = m.index + m[0]!.length;
      out.push({
        row,
        startCol: info.map ? info.map[start]! : start,
        endCol: info.map ? (info.map[end] ?? info.map[info.map.length - 1]!) : end,
      });
      if (out.length >= MAX_MATCHES) break;
    }
  }
  return out;
}
