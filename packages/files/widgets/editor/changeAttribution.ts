/** Pure, browser-safe: which chat wrote each changed line of a file.
 *
 * Git says WHAT changed (the working-tree diff against the index: the same
 * hunks Undo discards). Edit fragments say WHO: each chat's edits are found
 * in the current text, oldest first, and claim the changed lines they wrote,
 * so the newest writer of a line wins. A removal belongs to the chat whose
 * lines replaced it, else to the newest edit that removed that text. With a
 * single editing chat everything it could have written is its own; anything
 * else stays unattributed (a person's edit, a formatter, a shell command).
 */
import { hunkDigest, splitHunks } from "@polyth/git/hunks";
import type { FileEditRecord } from "./checkoutEdits.ts";

export interface AttributedLine {
  line: number;
  /** Session id, or null when no chat's edit explains the line. */
  owner: string | null;
}

export interface AttributedRemoval {
  /** The removed text sat before this line (line count + 1 = end of file). */
  line: number;
  text: string[];
  owner: string | null;
}

export interface AttributedHunk {
  /** Git hunk index in the current diff (the hunk-mutation identity). */
  index: number;
  digest: string;
  lines: AttributedLine[];
  removed: AttributedRemoval[];
  /** First changed line: where the hunk's actions and navigation land. */
  anchorLine: number;
}

export interface AttributionInput {
  /** Current file text the diff's new side must match. */
  text: string;
  /** `git diff -- <path>` (working tree against the index). */
  diff: string;
  edits: readonly FileEditRecord[];
  /** Hunk digests the person kept: hidden until the hunk changes again. */
  accepted?: ReadonlySet<string>;
}

const MAX_OCCURRENCES = 32;
const trimEnd = (line: string): string => line.replace(/[ \t\r]+$/, "");

interface Located { normText: string; lineStarts: number[] }

function locate(text: string): Located {
  const lines = text.split("\n").map(trimEnd);
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  return { normText: lines.join("\n"), lineStarts };
}

/** 1-based line of a character offset in the normalized text. */
function lineAt(located: Located, offset: number): number {
  let low = 0;
  let high = located.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (located.lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

const normalizeFragment = (text: string): string =>
  text.replace(/\r\n/g, "\n").split("\n").map(trimEnd).join("\n").replace(/\n+$/, "");

/** A line distinctive enough to anchor an alignment ("}" or "" never is). */
const distinctive = (line: string): boolean => {
  const value = line.trim();
  return value.length >= 4 && /[\p{L}\p{N}]/u.test(value);
};

const MAX_ALIGNMENTS = 3;
const MAX_LINE_CANDIDATES = 64;

/** Whether `lines` occurs as a contiguous run inside `haystack`. */
function containsRun(haystack: readonly string[], lines: readonly string[]): boolean {
  if (lines.length === 0 || lines.length > haystack.length) return false;
  outer: for (let start = 0; start + lines.length <= haystack.length; start++) {
    for (let index = 0; index < lines.length; index++) {
      if (trimEnd(haystack[start + index]!) !== trimEnd(lines[index]!)) continue outer;
    }
    return true;
  }
  return false;
}

interface ParsedHunk {
  index: number;
  digest: string;
  added: number[];
  removed: Array<{ line: number; text: string[] }>;
}

/** Parse Git hunks against `textLines`; null when any line disagrees (stale diff). */
function parseHunks(diff: string, textLines: readonly string[]): ParsedHunk[] | null {
  const parsed: ParsedHunk[] = [];
  const hunks = splitHunks(diff);
  for (const [index, hunk] of hunks.entries()) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
    if (!header) return null;
    const newCount = header[2] === undefined ? 1 : Number(header[2]);
    // A hunk with an empty new side names the line before the removal.
    let line = Number(header[1]) + (newCount === 0 ? 1 : 0);
    const added: number[] = [];
    const removed: Array<{ line: number; text: string[] }> = [];
    let run: { line: number; text: string[] } | null = null;
    for (const body of hunk.body) {
      if (body.startsWith("\\")) continue;
      if (body.startsWith("-")) {
        if (!run) {
          run = { line, text: [] };
          removed.push(run);
        }
        run.text.push(body.slice(1));
        continue;
      }
      run = null;
      if (body === "") continue;
      const expected = body.slice(1);
      if (trimEnd(textLines[line - 1] ?? "\u0000") !== trimEnd(expected)) return null;
      if (body.startsWith("+")) added.push(line);
      line++;
    }
    parsed.push({ index, digest: hunkDigest(hunk), added, removed });
  }
  return parsed;
}

export function attributeChanges(input: AttributionInput): AttributedHunk[] | null {
  const textLines = input.text.split("\n");
  const hunks = parseHunks(input.diff, textLines);
  if (!hunks) return null;
  const added = new Set(hunks.flatMap((hunk) => hunk.added));
  const owner = new Map<number, string>();
  const located = locate(input.text);
  const normLines = located.normText.split("\n");
  // Changed lines by their text, to realign an edit a later edit partly rewrote.
  const byText = new Map<string, number[]>();
  for (const line of added) {
    const text = normLines[line - 1] ?? "";
    if (!distinctive(text)) continue;
    const list = byText.get(text) ?? [];
    if (list.length < MAX_LINE_CANDIDATES) list.push(line);
    byText.set(text, list);
  }
  const edits = [...input.edits].sort((left, right) => left.time - right.time || left.seq - right.seq);
  const claim = (sessionId: string, line: number, expected: string) => {
    if (added.has(line) && normLines[line - 1] === expected) owner.set(line, sessionId);
  };
  if (added.size > 0) {
    for (const edit of edits) {
      for (const fragment of edit.fragments) {
        const needle = normalizeFragment(fragment.text);
        if (!needle.trim()) continue;
        const fragmentLines = needle.split("\n");
        const written = fragment.written === null
          ? fragmentLines.map((_, offset) => offset)
          : fragment.written.filter((offset) => offset < fragmentLines.length);
        let exact = false;
        let from = 0;
        for (let count = 0; count < MAX_OCCURRENCES; count++) {
          const at = located.normText.indexOf(needle, from);
          if (at < 0) break;
          exact = true;
          from = at + 1;
          const start = lineAt(located, at);
          for (const offset of written) {
            if (added.has(start + offset)) owner.set(start + offset, edit.sessionId);
          }
        }
        if (exact) continue;
        // A later edit rewrote part of this one: align the written lines that
        // survived by voting on where they sit now, and claim those.
        const votes = new Map<number, number>();
        let anchors = 0;
        for (const offset of written) {
          const candidates = byText.get(fragmentLines[offset]!);
          if (!candidates) continue;
          anchors++;
          for (const line of candidates) votes.set(line - offset, (votes.get(line - offset) ?? 0) + 1);
        }
        const ranked = [...votes].sort((left, right) => right[1] - left[1]).slice(0, MAX_ALIGNMENTS);
        for (const [start, count] of ranked) {
          const unique = anchors === 1 && count === 1 && ranked.length === 1;
          if (count < 2 && !unique) continue;
          for (const offset of written) claim(edit.sessionId, start + offset, fragmentLines[offset]!);
        }
      }
    }
  }
  const editors = new Set(edits.map((edit) => edit.sessionId));
  const sole = editors.size === 1 ? [...editors][0]! : null;
  const result: AttributedHunk[] = [];
  for (const hunk of hunks) {
    if (input.accepted?.has(hunk.digest)) continue;
    const lines = hunk.added.map((line) => ({ line, owner: owner.get(line) ?? sole }));
    const removed = hunk.removed.map((block) => {
      // Replaced text belongs to whoever wrote its replacement.
      let blockOwner = added.has(block.line) ? owner.get(block.line) ?? null : null;
      if (!blockOwner) {
        for (const edit of [...edits].reverse()) {
          if (edit.fragments.some((fragment) => containsRun(fragment.removed, block.text))) {
            blockOwner = edit.sessionId;
            break;
          }
        }
      }
      return { line: block.line, text: block.text, owner: blockOwner ?? sole };
    });
    const anchorLine = Math.min(
      ...lines.map((line) => line.line),
      ...removed.map((block) => block.line),
    );
    if (!Number.isFinite(anchorLine)) continue;
    result.push({ index: hunk.index, digest: hunk.digest, lines, removed, anchorLine });
  }
  return result;
}
