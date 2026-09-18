// DOM-free unified-diff helpers for agent file edits and the execution UI.
import type { JsonObject } from "@polyth/contracts";

const MAX_DIFF_LINES = 1500;
const MAX_DIFF_EDITS = 2048;

export type DiffRowKind = "meta" | "hunk" | "add" | "del" | "ctx";

export interface DiffRow {
  text: string;
  kind: DiffRowKind;
  oldLine?: number;
  newLine?: number;
}

export type FileChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface FileDiff {
  path: string;
  previousPath?: string;
  diff: string;
  stats: { add: number; del: number };
  status: FileChangeStatus;
}

interface DiffOp { tag: "eq" | "del" | "ins"; line: string }

const firstPath = (input: JsonObject, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const firstRawString = (input: JsonObject, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
};

/** Split into lines, dropping the trailing empty element `String.split` adds
 *  for a trailing newline — otherwise every file would diff one line longer. */
export function toDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ tag: "eq", line: oldLines[i]! });
      i++; j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ tag: "del", line: oldLines[i]! });
      i++;
    } else {
      ops.push({ tag: "ins", line: newLines[j]! });
      j++;
    }
  }
  while (i < n) { ops.push({ tag: "del", line: oldLines[i]! }); i++; }
  while (j < m) { ops.push({ tag: "ins", line: newLines[j]! }); j++; }
  return ops;
}

function traceX(row: Int32Array, depth: number, diagonal: number): number {
  const index = diagonal + depth;
  return index >= 0 && index < row.length ? row[index]! : -1;
}

/** Myers diff with a bounded edit distance. Large source files usually differ
 * by only a handful of lines; this keeps those edits precise without paying
 * the quadratic memory cost of the small-file LCS implementation. */
function boundedDiffLines(oldLines: string[], newLines: string[]): DiffOp[] | null {
  const n = oldLines.length;
  const m = newLines.length;
  const maxDepth = Math.min(n + m, MAX_DIFF_EDITS);
  if (Math.abs(n - m) > maxDepth) return null;

  const trace: Int32Array[] = [];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const current = new Int32Array(2 * depth + 1);
    current.fill(-1);

    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      let x = 0;
      if (depth > 0) {
        const previous = trace[depth - 1]!;
        if (diagonal === -depth) {
          x = traceX(previous, depth - 1, diagonal + 1);
        } else if (diagonal === depth) {
          x = traceX(previous, depth - 1, diagonal - 1) + 1;
        } else if (
          traceX(previous, depth - 1, diagonal - 1)
          < traceX(previous, depth - 1, diagonal + 1)
        ) {
          x = traceX(previous, depth - 1, diagonal + 1);
        } else {
          x = traceX(previous, depth - 1, diagonal - 1) + 1;
        }
      }

      let y = x - diagonal;
      while (x >= 0 && y >= 0 && x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }
      current[diagonal + depth] = x;

      if (x < n || y < m) continue;
      trace.push(current);

      const reversed: DiffOp[] = [];
      let bx = n;
      let by = m;
      for (let backDepth = depth; backDepth > 0; backDepth--) {
        const previous = trace[backDepth - 1]!;
        const diagonalNow = bx - by;
        const cameFromInsertion = diagonalNow === -backDepth
          || (diagonalNow !== backDepth
            && traceX(previous, backDepth - 1, diagonalNow - 1)
              < traceX(previous, backDepth - 1, diagonalNow + 1));
        const previousDiagonal = cameFromInsertion ? diagonalNow + 1 : diagonalNow - 1;
        const previousX = traceX(previous, backDepth - 1, previousDiagonal);
        const previousY = previousX - previousDiagonal;

        while (bx > previousX && by > previousY) {
          bx--;
          by--;
          reversed.push({ tag: "eq", line: oldLines[bx]! });
        }
        if (cameFromInsertion) {
          by--;
          reversed.push({ tag: "ins", line: newLines[by]! });
        } else {
          bx--;
          reversed.push({ tag: "del", line: oldLines[bx]! });
        }
      }

      while (bx > 0 && by > 0) {
        bx--;
        by--;
        reversed.push({ tag: "eq", line: oldLines[bx]! });
      }
      while (bx > 0) {
        bx--;
        reversed.push({ tag: "del", line: oldLines[bx]! });
      }
      while (by > 0) {
        by--;
        reversed.push({ tag: "ins", line: newLines[by]! });
      }
      return reversed.reverse();
    }

    trace.push(current);
  }
  return null;
}

function largeDiffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefix = 0;
  const shared = Math.min(oldLines.length, newLines.length);
  while (prefix < shared && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle = oldMiddle.length <= MAX_DIFF_LINES && newMiddle.length <= MAX_DIFF_LINES
    ? diffLines(oldMiddle, newMiddle)
    : boundedDiffLines(oldMiddle, newMiddle)
      ?? [
        ...oldMiddle.map((line) => ({ tag: "del" as const, line })),
        ...newMiddle.map((line) => ({ tag: "ins" as const, line })),
      ];

  return [
    ...oldLines.slice(0, prefix).map((line) => ({ tag: "eq" as const, line })),
    ...middle,
    ...oldLines.slice(oldLines.length - suffix).map((line) => ({ tag: "eq" as const, line })),
  ];
}

/** [start, end) index ranges into `ops`, one per hunk, each padded with up to
 *  `context` lines of unchanged surrounding text; overlapping ranges merge. */
function hunkRanges(ops: DiffOp[], context: number): Array<[number, number]> {
  const changed: number[] = [];
  ops.forEach((op, i) => { if (op.tag !== "eq") changed.push(i); });
  if (!changed.length) return [];
  const ranges: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length, changed[0]! + 1 + context);
  for (let k = 1; k < changed.length; k++) {
    const idx = changed[k]!;
    const nextStart = Math.max(0, idx - context);
    if (nextStart <= end) {
      end = Math.min(ops.length, idx + 1 + context);
    } else {
      ranges.push([start, end]);
      start = nextStart;
      end = Math.min(ops.length, idx + 1 + context);
    }
  }
  ranges.push([start, end]);
  return ranges;
}

function fileHeaders(path: string, oldText: string, newText: string): [string, string] {
  if (!oldText) return ["--- /dev/null", `+++ b/${path}`];
  if (!newText) return [`--- a/${path}`, "+++ /dev/null"];
  return [`--- a/${path}`, `+++ b/${path}`];
}

/** Standard unified-diff text (`--- a/file`, `+++ b/file`, `@@ ... @@` hunks,
 *  3 lines of context). Large files use a bounded Myers diff so ordinary
 *  localized edits stay localized instead of appearing as whole-file rewrites. */
export function unifiedDiff(oldText: string, newText: string, path = "file"): string {
  if (oldText === newText) return "";
  const oldLines = toDiffLines(oldText);
  const newLines = toDiffLines(newText);
  const header = fileHeaders(path, oldText, newText);
  const ops = oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES
    ? largeDiffLines(oldLines, newLines)
    : diffLines(oldLines, newLines);
  const oldPrefix = new Array<number>(ops.length + 1).fill(0);
  const newPrefix = new Array<number>(ops.length + 1).fill(0);
  for (let i = 0; i < ops.length; i++) {
    oldPrefix[i + 1] = oldPrefix[i]! + (ops[i]!.tag === "ins" ? 0 : 1);
    newPrefix[i + 1] = newPrefix[i]! + (ops[i]!.tag === "del" ? 0 : 1);
  }
  const out = [...header];
  for (const [start, end] of hunkRanges(ops, 3)) {
    const oldStart = oldPrefix[start]!;
    const newStart = newPrefix[start]!;
    const oldCount = oldPrefix[end]! - oldStart;
    const newCount = newPrefix[end]! - newStart;
    out.push(`@@ -${oldCount ? oldStart + 1 : oldStart},${oldCount} +${newCount ? newStart + 1 : newStart},${newCount} @@`);
    for (let i = start; i < end; i++) {
      const op = ops[i]!;
      out.push((op.tag === "eq" ? " " : op.tag === "del" ? "-" : "+") + op.line);
    }
  }
  return out.join("\n");
}

/** Convert OpenAI/OpenCode apply_patch markers into `diff --git` file headers. */
export function normalizePatch(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (!/^\*{3} /m.test(text)) return text;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "*** Begin Patch" || line === "*** End Patch") continue;
    const update = /^\*{3} Update File:\s*(.+)$/.exec(line);
    if (update) {
      const path = update[1]!.trim();
      out.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`);
      continue;
    }
    const add = /^\*{3} Add File:\s*(.+)$/.exec(line);
    if (add) {
      const path = add[1]!.trim();
      out.push(`diff --git a/${path} b/${path}`, "--- /dev/null", `+++ b/${path}`);
      continue;
    }
    const del = /^\*{3} Delete File:\s*(.+)$/.exec(line);
    if (del) {
      const path = del[1]!.trim();
      out.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, "+++ /dev/null");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

const decodePath = (raw: string): string => {
  const value = raw.trim();
  if (!value.startsWith('"')) return value;
  try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
};

const pathAfterPrefix = (raw: string): string | null => {
  const value = decodePath(raw);
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
};

const gitHeaderPaths = (header: string): [string, string] | null => {
  const tokens = header.slice("diff --git ".length).match(/"(?:\\.|[^"])*"|\S+/g);
  return tokens?.length === 2 ? [tokens[0]!, tokens[1]!] : null;
};

function pathFromUnifiedHeaders(lines: readonly string[]): string | undefined {
  const plus = lines.find((line) => line.startsWith("+++ "));
  const minus = lines.find((line) => line.startsWith("--- "));
  return (plus ? pathAfterPrefix(plus.slice(4)) : null)
    ?? (minus ? pathAfterPrefix(minus.slice(4)) : null)
    ?? undefined;
}

function statusOf(diff: string, previousPath?: string, path?: string): FileChangeStatus {
  if (previousPath && path && previousPath !== path) return "renamed";
  if (/^--- \/dev\/null$/m.test(diff)) return "added";
  if (/^\+\+\+ \/dev\/null$/m.test(diff)) return "deleted";
  return "modified";
}

/** Added/removed content-line counts, ignoring file headers. */
export function fileDiffStat(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}

function withStats(file: Omit<FileDiff, "stats" | "status">): FileDiff {
  return {
    ...file,
    stats: fileDiffStat(file.diff),
    status: statusOf(file.diff, file.previousPath, file.path),
  };
}

/** Split a (possibly multi-file) unified or apply_patch patch into per-file diffs. */
export function splitFileDiffs(diff: string, fallbackPath = "file"): FileDiff[] {
  const normalized = normalizePatch(diff);
  if (!normalized.trim()) return [];
  const lines = normalized.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) starts.push(index);
  });
  if (starts.length === 0) {
    return [withStats({ path: pathFromUnifiedHeaders(lines) ?? fallbackPath, diff: normalized })];
  }
  return starts.map((start, index) => {
    const slice = lines.slice(start, starts[index + 1] ?? lines.length);
    const header = slice[0] ?? "";
    const paths = gitHeaderPaths(header);
    const oldHeader = slice.find((line) => line.startsWith("--- "))?.slice(4).trim();
    const newHeader = slice.find((line) => line.startsWith("+++ "))?.slice(4).trim();
    const renameFrom = slice.find((line) => line.startsWith("rename from "))?.slice("rename from ".length);
    const renameTo = slice.find((line) => line.startsWith("rename to "))?.slice("rename to ".length);
    const oldPath = renameFrom !== undefined
      ? decodePath(renameFrom)
      : oldHeader ? pathAfterPrefix(oldHeader) : paths ? pathAfterPrefix(paths[0]) : null;
    const newPath = renameTo !== undefined
      ? decodePath(renameTo)
      : newHeader ? pathAfterPrefix(newHeader) : paths ? pathAfterPrefix(paths[1]) : null;
    const path = newPath ?? oldPath ?? fallbackPath;
    return withStats({
      path,
      ...(oldPath && newPath && oldPath !== newPath ? { previousPath: oldPath } : {}),
      diff: slice.join("\n"),
    });
  });
}

function stripFileHeaders(diff: string): string[] {
  return diff.split("\n").filter((line) =>
    !line.startsWith("diff --git ")
    && !line.startsWith("--- ")
    && !line.startsWith("+++ "));
}

function editsDiff(input: JsonObject, path: string): string | undefined {
  const edits = input.edits ?? input.replacements;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const hunks: string[] = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
    const record = edit as JsonObject;
    const before = firstRawString(record, ["oldString", "old_string", "before"]);
    const after = firstRawString(record, ["newString", "new_string", "after"]);
    if (before === undefined && after === undefined) continue;
    const piece = unifiedDiff(before ?? "", after ?? "", path);
    if (piece) hunks.push(...stripFileHeaders(piece));
  }
  if (hunks.length === 0) return undefined;
  const emptyOld = !hunks.some((line) => line.startsWith("-"));
  const emptyNew = !hunks.some((line) => line.startsWith("+"));
  const headers = fileHeaders(path, emptyOld ? "" : "x", emptyNew ? "" : "x");
  return [...headers, ...hunks].join("\n");
}

export function looksLikeDiff(text: string): boolean {
  return /^(?:diff --git |--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null)|@@ |\*{3} (?:Begin Patch|Update File|Add File|Delete File):)/m
    .test(text);
}

/** Build per-file unified diffs from an edit/write/create/delete tool payload. */
export function fileDiffsFromInput(input: JsonObject, fallbackPath = "file"): FileDiff[] {
  const path = firstPath(input, ["filePath", "file_path", "path", "file", "target"]) ?? fallbackPath;
  const patch = firstRawString(input, ["patch", "patchText", "patch_text", "diff"]);
  if (patch?.trim()) return splitFileDiffs(patch, path);
  const fromEdits = editsDiff(input, path);
  if (fromEdits) return splitFileDiffs(fromEdits, path);
  const before = firstRawString(input, ["oldString", "old_string", "before"]);
  const after = firstRawString(input, ["newString", "new_string", "after", "content"]);
  if (before === undefined && after === undefined) return [];
  const diff = unifiedDiff(before ?? "", after ?? "", path);
  return diff ? splitFileDiffs(diff, path) : [];
}

/** Parse a unified diff into display rows with old/new source line numbers. */
export function parseDiffRows(diff: string): DiffRow[] {
  if (!diff) return [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return diff.replace(/\r\n/g, "\n").split("\n").map((text) => {
    const hunk = /^@@(?: -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?)?/.exec(text);
    if (hunk) {
      oldLine = hunk[1] !== undefined ? Number(hunk[1]) : 1;
      newLine = hunk[2] !== undefined ? Number(hunk[2]) : 1;
      inHunk = true;
      return { text, kind: "hunk" as const };
    }
    if (text === "\\ No newline at end of file") return { text, kind: "meta" as const };
    if (text.startsWith("+") && !text.startsWith("+++")) {
      if (!inHunk) { inHunk = true; oldLine = 1; newLine = 1; }
      return { text, kind: "add" as const, newLine: newLine++ };
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      if (!inHunk) { inHunk = true; oldLine = 1; newLine = 1; }
      return { text, kind: "del" as const, oldLine: oldLine++ };
    }
    if (!inHunk) return { text, kind: "meta" as const };
    if (text.startsWith(" ") || text === "") {
      const row = { text, kind: "ctx" as const, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return row;
    }
    return { text, kind: "meta" as const };
  });
}

/** Content rows shown in the execution-row diff (no file headers or @@ hunks). */
export function visibleDiffRows(diff: string): DiffRow[] {
  return parseDiffRows(diff).filter((row) => row.kind !== "meta" && row.kind !== "hunk");
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

const payloadLine = (text: string): string =>
  text.length > 0 && (text[0] === " " || text[0] === "+" || text[0] === "-")
    ? text.slice(1)
    : text;

/** Hunks with old/new line bodies, used to reverse an agent file edit. */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  const ensure = (): DiffHunk => {
    if (!current) current = { oldStart: 0, newStart: 1, oldLines: [], newLines: [] };
    return current;
  };
  for (const row of parseDiffRows(diff)) {
    if (row.kind === "hunk") {
      if (current) hunks.push(current);
      const parsed = /^@@(?: -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?)?/.exec(row.text);
      current = {
        oldStart: parsed?.[1] !== undefined ? Number(parsed[1]) : 0,
        newStart: parsed?.[2] !== undefined ? Number(parsed[2]) : 0,
        oldLines: [],
        newLines: [],
      };
      continue;
    }
    if (row.kind === "meta") continue;
    const hunk = ensure();
    const line = payloadLine(row.text);
    if (row.kind === "ctx") {
      hunk.oldLines.push(line);
      hunk.newLines.push(line);
    } else if (row.kind === "add") hunk.newLines.push(line);
    else if (row.kind === "del") hunk.oldLines.push(line);
  }
  if (current) hunks.push(current);
  return hunks;
}

function findBlock(lines: readonly string[], block: readonly string[], hint: number): number {
  if (block.length === 0) return Math.min(Math.max(0, hint), lines.length);
  let best = -1;
  let bestDist = Infinity;
  const last = lines.length - block.length;
  for (let i = 0; i <= last; i++) {
    if (!block.every((line, index) => lines[i + index] === line)) continue;
    const dist = Math.abs(i - hint);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

function applyHunks(
  lines: readonly string[],
  hunks: readonly DiffHunk[],
  direction: "forward" | "reverse",
): string[] | "already-reverted" | "conflict" {
  if (hunks.length === 0) return "conflict";
  const next = [...lines];
  let applied = 0;
  let already = 0;
  for (let index = hunks.length - 1; index >= 0; index--) {
    const hunk = hunks[index]!;
    const from = direction === "reverse" ? hunk.newLines : hunk.oldLines;
    const to = direction === "reverse" ? hunk.oldLines : hunk.newLines;
    const fromStart = direction === "reverse" ? hunk.newStart : hunk.oldStart;
    const toStart = direction === "reverse" ? hunk.oldStart : hunk.newStart;
    const fromHint = Math.max(0, fromStart > 0 ? fromStart - 1 : 0);
    const toHint = Math.max(0, toStart > 0 ? toStart - 1 : 0);
    if (from.length === 0) {
      if (to.length === 0) continue;
      if (findBlock(next, to, toHint) >= 0) {
        already += 1;
        continue;
      }
      next.splice(Math.min(fromHint, next.length), 0, ...to);
      applied += 1;
      continue;
    }
    const at = findBlock(next, from, fromHint);
    if (at >= 0) {
      next.splice(at, from.length, ...to);
      applied += 1;
      continue;
    }
    if (to.length === 0 || findBlock(next, to, toHint) >= 0) {
      already += 1;
      continue;
    }
    return "conflict";
  }
  if (applied === 0) return already > 0 ? "already-reverted" : "conflict";
  return next;
}

function joinLines(lines: readonly string[], trailingNl: boolean): string {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}${trailingNl ? "\n" : ""}`;
}

export type DiffApplyDirection = "forward" | "reverse";

export type RevertFileResult =
  | { ok: true; action: "write"; content: string }
  | { ok: true; action: "delete" }
  | { ok: false; reason: "already-reverted" | "already-applied" | "conflict" | "empty" };

function alreadyAtTarget(direction: DiffApplyDirection): RevertFileResult {
  return { ok: false, reason: direction === "forward" ? "already-applied" : "already-reverted" };
}

/** Apply `diff` forward (redo the agent edit) or in reverse (undo it). */
export function applyUnifiedDiff(
  current: string | null,
  diff: string,
  direction: DiffApplyDirection,
): RevertFileResult {
  const hunks = parseDiffHunks(diff);
  if (hunks.length === 0) return { ok: false, reason: "empty" };
  const sourceEmpty = hunks.every((hunk) =>
    (direction === "forward" ? hunk.oldLines : hunk.newLines).length === 0);
  const targetEmpty = hunks.every((hunk) =>
    (direction === "forward" ? hunk.newLines : hunk.oldLines).length === 0);
  if (current === null) {
    if (targetEmpty && !sourceEmpty) return alreadyAtTarget(direction);
    if (!sourceEmpty) return { ok: false, reason: "conflict" };
    const applied = applyHunks([], hunks, direction);
    if (applied === "already-reverted") return alreadyAtTarget(direction);
    if (applied === "conflict") return { ok: false, reason: "conflict" };
    return { ok: true, action: "write", content: joinLines(applied, true) };
  }
  const trailing = current.endsWith("\n");
  const applied = applyHunks(toDiffLines(current), hunks, direction);
  if (applied === "already-reverted") return alreadyAtTarget(direction);
  if (applied === "conflict") return { ok: false, reason: "conflict" };
  if (targetEmpty && applied.length === 0) return { ok: true, action: "delete" };
  return { ok: true, action: "write", content: joinLines(applied, trailing) };
}

/** Reverse `diff` against the current file contents (or `null` if the file is gone). */
export function revertUnifiedDiff(current: string | null, diff: string): RevertFileResult {
  return applyUnifiedDiff(current, diff, "reverse");
}
