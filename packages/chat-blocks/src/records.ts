// Records for a block's `from=` file. Pure and DOM-free: the renderer reads
// the file through the Files API and hands its text here. JSON (an array, or
// the first array inside an object), JSON Lines and CSV/TSV are accepted.
import { CHAT_BLOCK_MAX_RECORDS, type DataRecord } from "./parse.ts";

export type RecordsResult =
  | { ok: true; records: DataRecord[]; total: number; truncated: boolean }
  | { ok: false; reason: "empty" | "format" | "too-large" };

const formatOf = (path: string): "json" | "jsonl" | "csv" | "tsv" => {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  if (ext === "csv") return "csv";
  if (ext === "tsv") return "tsv";
  return "json";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Arrays of arrays become records keyed by their first row. */
function fromRows(rows: unknown[][]): DataRecord[] {
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((cell, i) => (typeof cell === "string" && cell.trim() ? cell.trim() : `#${i + 1}`));
  return body.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]])));
}

function fromJsonValue(value: unknown): DataRecord[] | null {
  let list: unknown = value;
  if (isRecord(value)) {
    // `{ "items": [...] }` and similar wrappers: the first array wins.
    list = Object.values(value).find(Array.isArray);
  }
  if (!Array.isArray(list)) return null;
  if (list.every(Array.isArray)) return fromRows(list as unknown[][]);
  if (list.every(isRecord)) return list as DataRecord[];
  // A list of primitives is one column.
  if (list.every((entry) => !isRecord(entry) && !Array.isArray(entry))) return list.map((entry) => ({ value: entry }));
  return null;
}

/** RFC 4180-style fields: quotes, doubled quotes, delimiters and newlines
 *  inside quotes. A trailing unterminated row (a cut file) is dropped. */
export function parseDelimited(text: string, delimiter: string, complete: boolean): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 1; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === "\"" && field === "") quoted = true;
    else if (ch === delimiter) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (complete && !quoted && (field !== "" || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const guessDelimiter = (firstLine: string): string => {
  const [best] = [",", ";", "\t"]
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
    .sort((a, b) => b.count - a.count);
  return best && best.count > 0 ? best.delimiter : ",";
};

/**
 * Parse a data file. `truncated` means the server returned only the first
 * part of the file: line formats keep their complete lines, whole-document
 * JSON cannot be read and reports `too-large`.
 */
export function parseRecords(path: string, text: string, truncated = false, limit = CHAT_BLOCK_MAX_RECORDS): RecordsResult {
  const body = text.replace(/^﻿/, "");
  if (!body.trim()) return { ok: false, reason: "empty" };
  const format = formatOf(path);
  let records: DataRecord[] | null = null;
  let cut = truncated;

  if (format === "json") {
    if (truncated) return { ok: false, reason: "too-large" };
    try {
      records = fromJsonValue(JSON.parse(body));
    } catch {
      records = null;
    }
  } else if (format === "jsonl") {
    const lines = body.split(/\r?\n/);
    if (truncated) lines.pop();
    records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (isRecord(value)) records.push(value);
      } catch {
        // A malformed line is skipped, not fatal.
      }
    }
  } else {
    const newline = body.indexOf("\n");
    const firstLine = newline < 0 ? body : body.slice(0, newline);
    const delimiter = format === "tsv" ? "\t" : guessDelimiter(firstLine);
    records = fromRows(parseDelimited(body, delimiter, !truncated));
  }

  if (!records) return { ok: false, reason: "format" };
  if (records.length === 0) return { ok: false, reason: "empty" };
  const total = records.length;
  if (records.length > limit) {
    records = records.slice(0, limit);
    cut = true;
  }
  return { ok: true, records, total, truncated: cut };
}
