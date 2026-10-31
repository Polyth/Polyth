// CSV/TSV for the table preview: RFC 4180 quoting (quoted separators, quotes
// and line breaks inside a field), the separator guessed from the first line
// unless the extension says TSV. Bounded: a huge file previews its head.

export interface CsvTable {
  delimiter: string;
  /** First row; the preview reads it as the header. */
  header: string[];
  rows: string[][];
  /** Widest row (cells), header included. */
  columns: number;
  /** Rows were cut at the bound (the editor still has the whole file). */
  truncated: boolean;
}

export const CSV_MAX_ROWS = 5_000;
const CANDIDATES = [",", ";", "\t", "|"];

export const isCsvPath = (path: string): boolean => /\.(csv|tsv|tab)$/i.test(path);

/** The separator that splits the first line into the most fields. */
export function guessDelimiter(text: string, path = ""): string {
  if (/\.(tsv|tab)$/i.test(path)) return "\t";
  const firstLine = text.slice(0, 4096).split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const candidate of CANDIDATES) {
    let count = 0;
    let quoted = false;
    for (const char of firstLine) {
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === candidate) count += 1;
    }
    if (count > bestCount) { best = candidate; bestCount = count; }
  }
  return best;
}

export function parseCsv(text: string, path = "", maxRows = CSV_MAX_ROWS): CsvTable {
  const delimiter = guessDelimiter(text, path);
  const all: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; // byte-order mark
  const endRow = () => {
    row.push(field);
    field = "";
    // A trailing newline leaves one empty row behind; drop blank lines.
    if (row.length > 1 || row[0] !== "") all.push(row);
    row = [];
  };
  for (; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRow();
      if (all.length > maxRows + 1) break; // header + maxRows, plus one to know
    } else field += char;
  }
  if (!truncated && (field !== "" || row.length > 0)) endRow();
  if (all.length > maxRows + 1) { all.length = maxRows + 1; truncated = true; }
  const [header = [], ...rows] = all;
  const columns = all.reduce((widest, cells) => Math.max(widest, cells.length), 0);
  return { delimiter, header, rows, columns, truncated };
}

const NUMERIC = /^[-+]?[$€£¥₴]?[-+]?(\d[\d\s,_]*)?(\.\d+)?([eE][-+]?\d+)?%?$/;

/** Number-looking cells (a leading currency sign, thousands separators and a
 *  trailing % allowed). */
export function numericValue(cell: string): number | null {
  const trimmed = cell.trim();
  if (!trimmed || !/\d/.test(trimmed) || !NUMERIC.test(trimmed)) return null;
  const value = Number(trimmed.replace(/[\s,_%$€£¥₴]/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** A column is numeric when every non-empty cell is. */
export function numericColumns(table: CsvTable): boolean[] {
  return Array.from({ length: table.columns }, (_, column) => {
    let seen = false;
    for (const row of table.rows) {
      const cell = row[column]?.trim() ?? "";
      if (!cell) continue;
      if (numericValue(cell) === null) return false;
      seen = true;
    }
    return seen;
  });
}

/** Cell order for a column sort: numbers numerically, text by locale. */
export function compareCells(a: string, b: string, numeric: boolean): number {
  if (numeric) {
    const left = numericValue(a);
    const right = numericValue(b);
    if (left !== null && right !== null && left !== right) return left - right;
    if ((left === null) !== (right === null)) return left === null ? -1 : 1;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

export function sortRows(rows: readonly string[][], column: number, direction: 1 | -1, numeric: boolean): string[][] {
  return [...rows].sort((left, right) => compareCells(left[column] ?? "", right[column] ?? "", numeric) * direction);
}
