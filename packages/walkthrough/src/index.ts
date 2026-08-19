// Walkthrough workflow plugin: turns a session's file-editing tool calls into
// an ordered list of reviewable steps with a unified diff per step. Entirely
// derived from the durable session event log (invariant #4) — there is no
// in-memory state; approve/reject just appends an overlay event and the next
// GET re-derives the list, so a server restart cannot lose or duplicate a
// decision.
import type { JsonObject, SessionEvent, WalkthroughStepDto, WalkthroughStepStatus } from "@polyth/contracts";

export type { WalkthroughStepDto, WalkthroughStepStatus } from "@polyth/contracts";

const FILE_TOOLS = new Set(["write", "edit", "patch"]);
const MAX_DIFF_LINES = 1500;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const fileOf = (input: Record<string, unknown>): string | undefined => {
  const v = input.filePath ?? input.path ?? input.file;
  return typeof v === "string" && v ? v : undefined;
};

/** Split into lines, dropping the single trailing empty element `String.split`
 *  produces for a trailing newline — otherwise every file would diff one line
 *  longer than it actually is. */
const toLines = (text: string): string[] => {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

// ---------------------------------------------------------------- unified diff

interface DiffOp { tag: "eq" | "del" | "ins"; line: string }

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

/** Standard unified-diff text (`--- a/file`, `+++ b/file`, `@@ ... @@` hunks,
 *  3 lines of context). Falls back to a whole-file replace hunk for inputs too
 *  large to diff line-by-line, so callers never pay O(n*m) on huge files. */
export function unifiedDiff(oldText: string, newText: string, path = "file"): string {
  if (oldText === newText) return "";
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  const header = [`--- a/${path}`, `+++ b/${path}`];
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return [
      ...header,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((l) => `-${l}`),
      ...newLines.map((l) => `+${l}`),
    ].join("\n");
  }
  const ops = diffLines(oldLines, newLines);

  // prefix[i] = number of old/new lines consumed by ops[0..i)
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

// ---------------------------------------------------------------- step derivation

const diffFor = (tool: string, input: Record<string, unknown>): string => {
  const file = fileOf(input) ?? "file";
  if (typeof input.diff === "string" && input.diff.trim()) return input.diff;
  if (tool === "edit") {
    const oldString = typeof input.oldString === "string" ? input.oldString : "";
    const newString = typeof input.newString === "string" ? input.newString : "";
    return unifiedDiff(oldString, newString, file);
  }
  if (tool === "write") {
    const content = typeof input.content === "string" ? input.content : "";
    return unifiedDiff("", content, file);
  }
  return "";
};

const verbFor = (tool: string): string => (tool === "write" ? "Write" : tool === "edit" ? "Edit" : "Patch");

/** Pure derivation: ordered file-change steps + their current approve/reject
 *  status, entirely reconstructed from the event log. */
export function deriveWalkthrough(events: readonly SessionEvent[]): WalkthroughStepDto[] {
  const steps: WalkthroughStepDto[] = [];
  for (const ev of events) {
    if (ev.type !== "tool/result") continue;
    const d = ev.data as { tool?: unknown; title?: unknown; input?: unknown };
    const tool = typeof d.tool === "string" ? d.tool : "";
    if (!FILE_TOOLS.has(tool)) continue;
    const input = asRecord(d.input) ?? {};
    const file = fileOf(input);
    if (!file) continue;
    const diff = diffFor(tool, input);
    if (!diff.trim()) continue;
    const explanation = typeof d.title === "string" && d.title.trim() ? d.title.trim() : `${verbFor(tool)} ${file}`;
    steps.push({ file, explanation, diff, status: "pending" });
  }

  for (const ev of events) {
    if (ev.type !== "walkthrough/step-approved" && ev.type !== "walkthrough/step-rejected") continue;
    const idx = Number((ev.data as { stepIndex?: unknown }).stepIndex);
    const step = steps[idx];
    if (!step) continue;
    step.status = ev.type === "walkthrough/step-approved" ? "approved" : "rejected";
  }

  return steps;
}

export function stepEventData(stepIndex: number, step: WalkthroughStepDto): JsonObject {
  return { stepIndex, file: step.file };
}

export const decisionEventType = (status: Extract<WalkthroughStepStatus, "approved" | "rejected">): string =>
  status === "approved" ? "walkthrough/step-approved" : "walkthrough/step-rejected";
