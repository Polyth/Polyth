// Lightweight edit-loop observer: structured signal only, never terminates a turn.
import type { EditLoopKind, JsonObject, SessionEvent } from "@polyth/contracts";

/** How many recent tool terminal events (result/error) to inspect. */
export const EDIT_LOOP_WINDOW = 20;
/** Same file must be edited at least this many times with failing checks between. */
export const EDIT_LOOP_SAME_FILE_EDITS = 3;
/** Strict A↔B alternation must complete at least this many A→B→A cycles. */
export const EDIT_LOOP_OSCILLATION_CYCLES = 3;
/** Suppress re-emitting the same signature for this long even if the loop continues. */
const EDIT_LOOP_COOLDOWN_MS = 60_000;

const WRITE_TOOL =
  /(^|[./:_-])(apply[_-]?patch|create[_-]?file|delete[_-]?file|edit|multiedit|patch|write)([./:_-]|$)/i;
const TEST_BUILD_TOOL =
  /(^|[./:_-])(bash|shell|exec|npm|pnpm|yarn|bun|cargo|make|gradle|mvn|pytest|vitest|jest|go|dotnet|cmake|tsc|eslint)([./:_-]|$)/i;
const TEST_BUILD_COMMAND =
  /\b(test|spec|build|compile|typecheck|lint|ci|check|vitest|jest|pytest|mocha|cargo\s+test|go\s+test|npm\s+(?:run\s+)?(?:test|build)|pnpm\s+(?:run\s+)?(?:test|build)|yarn\s+(?:run\s+)?(?:test|build))\b/i;
const PATH_KEY = /^(changedFiles|file|filePath|filename|files|path|paths|target)$/i;
const PATCH_FILE = /^\*{3} (?:Add|Delete|Update) File:\s*(.+)$/gm;

export interface ToolCallRecord {
  tool: string;
  path?: string;
  /** True when this record is an edit-like write targeting `path`. */
  edit: boolean;
  /** True when this looks like a test/build/check invocation. */
  check: boolean;
  /** True for tool/error or a failed check result. */
  failed: boolean;
}

export interface EditLoopEvidence {
  tool: string;
  path?: string;
  failed?: boolean;
  role: "edit" | "check" | "other";
}

export interface EditLoopDetection {
  detected: true;
  kind: EditLoopKind;
  paths: string[];
  signature: string;
  evidence: EditLoopEvidence[];
}

function usablePath(value: string): string | null {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.includes("\0") || path.includes("\n") || /^[a-z]+:\/\//i.test(path)) return null;
  return path;
}

function collectPathValue(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const path = usablePath(value);
    if (path) out.add(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValue(item, out);
    return;
  }
  if (value && typeof value === "object") collectPathFields(value as JsonObject, out);
}

function collectPathFields(value: JsonObject, out: Set<string>): void {
  for (const [key, child] of Object.entries(value)) {
    if (PATH_KEY.test(key)) collectPathValue(child, out);
    else if (child && typeof child === "object") collectPathValue(child, out);
    if (typeof child === "string" && /^(patch|patchText)$/i.test(key)) {
      for (const match of child.matchAll(PATCH_FILE)) {
        const path = usablePath(match[1] ?? "");
        if (path) out.add(path);
      }
    }
  }
}

function isEditTool(tool: string): boolean {
  return WRITE_TOOL.test(tool);
}

function isCheckTool(tool: string, input?: JsonObject): boolean {
  if (TEST_BUILD_TOOL.test(tool)) {
    const command = typeof input?.command === "string"
      ? input.command
      : typeof input?.cmd === "string"
        ? input.cmd
        : "";
    // Bare bash/shell without a test/build-ish command is too noisy to count.
    if (/^(bash|shell|exec)$/i.test(tool) || /[/._-](bash|shell|exec)$/i.test(tool)) {
      return command.length > 0 && TEST_BUILD_COMMAND.test(command);
    }
    return true;
  }
  const command = typeof input?.command === "string"
    ? input.command
    : typeof input?.cmd === "string"
      ? input.cmd
      : "";
  return command.length > 0 && TEST_BUILD_COMMAND.test(command);
}

function extractEditPath(tool: string, input?: JsonObject, metadata?: JsonObject): string | undefined {
  if (!isEditTool(tool) || !input) return undefined;
  const paths = new Set<string>();
  collectPathFields(input, paths);
  if (metadata) collectPathFields(metadata, paths);
  const [first] = [...paths].sort((a, b) => a.localeCompare(b));
  return first;
}

function isFailedToolResult(
  kind: "result" | "error",
  tool: string,
  outputOrError: string,
  metadata?: JsonObject,
  input?: JsonObject,
): boolean {
  if (kind === "error") return true;
  if (metadata && typeof metadata.exitCode === "number" && metadata.exitCode !== 0) return true;
  if (metadata?.failed === true || metadata?.rejected === true) return true;
  if (!isCheckTool(tool, input)) return false;
  // Conservative text signals for check tools that omit exit metadata.
  return /\b(fail(ed|ure)?|error|✖|×|ELIFECYCLE|AssertionError|FAILED)\b/i.test(outputOrError)
    && !/\b0 failing\b/i.test(outputOrError);
}

function toolRecordFromEvent(ev: SessionEvent): ToolCallRecord | null {
  if (ev.type !== "tool/result" && ev.type !== "tool/error") return null;
  const data = ev.data as JsonObject;
  const tool = typeof data.tool === "string" ? data.tool : "";
  if (!tool) return null;
  const input = (data.input && typeof data.input === "object" && !Array.isArray(data.input))
    ? data.input as JsonObject
    : undefined;
  const metadata = (data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata))
    ? data.metadata as JsonObject
    : undefined;
  const outputOrError = ev.type === "tool/error"
    ? (typeof data.error === "string" ? data.error : "")
    : (typeof data.output === "string" ? data.output : "");
  const path = extractEditPath(tool, input, metadata);
  const edit = Boolean(path);
  const check = isCheckTool(tool, input);
  const failed = isFailedToolResult(
    ev.type === "tool/error" ? "error" : "result",
    tool,
    outputOrError,
    metadata,
    input,
  );
  return {
    tool,
    ...(path ? { path } : {}),
    edit,
    check,
    failed,
  };
}

/** Newest-last window of terminal tool records from a session log. */
export function recentToolRecords(
  events: readonly SessionEvent[],
  windowSize = EDIT_LOOP_WINDOW,
): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  for (let i = events.length - 1; i >= 0 && records.length < windowSize; i -= 1) {
    const record = toolRecordFromEvent(events[i]!);
    if (record) records.push(record);
  }
  return records.reverse();
}

function evidenceFrom(records: readonly ToolCallRecord[], indexes: readonly number[]): EditLoopEvidence[] {
  return indexes.map((index) => {
    const record = records[index]!;
    return {
      tool: record.tool,
      ...(record.path ? { path: record.path } : {}),
      ...(record.failed ? { failed: true } : {}),
      role: record.edit ? "edit" : record.check ? "check" : "other",
    };
  });
}

function editLoopSignature(kind: EditLoopKind, paths: readonly string[]): string {
  return `${kind}:${[...paths].sort().join("|")}`;
}

function detectRepeatedEditWithFailingChecks(
  records: readonly ToolCallRecord[],
): EditLoopDetection | null {
  const editsByPath = new Map<string, number[]>();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (!record.edit || !record.path) continue;
    const list = editsByPath.get(record.path) ?? [];
    list.push(i);
    editsByPath.set(record.path, list);
  }

  for (const [path, editIndexes] of editsByPath) {
    if (editIndexes.length < EDIT_LOOP_SAME_FILE_EDITS) continue;
    const first = editIndexes[0]!;
    const last = editIndexes[editIndexes.length - 1]!;
    const failingChecks: number[] = [];
    for (let i = first + 1; i < last; i += 1) {
      const record = records[i]!;
      if (record.check && record.failed) failingChecks.push(i);
    }
    // Require intervening failing checks between edits — not merely adjacent
    // rewrites of the same file (legitimate multi-hunk edits).
    if (failingChecks.length === 0) continue;
    const evidenceIndexes = [...editIndexes.slice(0, EDIT_LOOP_SAME_FILE_EDITS), ...failingChecks.slice(0, 3)]
      .sort((a, b) => a - b);
    const kind = "repeated-edit-with-failing-checks" as const;
    const paths = [path];
    return {
      detected: true,
      kind,
      paths,
      signature: editLoopSignature(kind, paths),
      evidence: evidenceFrom(records, evidenceIndexes),
    };
  }
  return null;
}

function detectFileOscillation(records: readonly ToolCallRecord[]): EditLoopDetection | null {
  const editIndexes: number[] = [];
  const editPaths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (!record.edit || !record.path) continue;
    // Collapse consecutive edits of the same path (multi-tool hunks).
    if (editPaths.length > 0 && editPaths[editPaths.length - 1] === record.path) continue;
    editIndexes.push(i);
    editPaths.push(record.path);
  }
  if (editPaths.length < EDIT_LOOP_OSCILLATION_CYCLES * 2 + 1) return null;

  for (let start = 0; start <= editPaths.length - (EDIT_LOOP_OSCILLATION_CYCLES * 2 + 1); start += 1) {
    const a = editPaths[start]!;
    const b = editPaths[start + 1]!;
    if (a === b) continue;
    let ok = true;
    for (let i = 0; i < EDIT_LOOP_OSCILLATION_CYCLES * 2 + 1; i += 1) {
      const expected = i % 2 === 0 ? a : b;
      if (editPaths[start + i] !== expected) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const kind = "file-oscillation" as const;
    const paths = [a, b];
    const sliceIndexes = editIndexes.slice(start, start + EDIT_LOOP_OSCILLATION_CYCLES * 2 + 1);
    return {
      detected: true,
      kind,
      paths,
      signature: editLoopSignature(kind, paths),
      evidence: evidenceFrom(records, sliceIndexes),
    };
  }
  return null;
}

/** Inspect a bounded tool sequence. Returns a detection or null. */
export function detectEditLoop(records: readonly ToolCallRecord[]): EditLoopDetection | null {
  if (records.length === 0) return null;
  return detectRepeatedEditWithFailingChecks(records) ?? detectFileOscillation(records);
}

export interface EditLoopDedupeState {
  signature: string;
  at: number;
}

/** Decide whether a fresh detection should be emitted given prior state. */
export function shouldEmitEditLoop(
  detection: EditLoopDetection | null,
  previous: EditLoopDedupeState | undefined,
  now = Date.now(),
  cooldownMs = EDIT_LOOP_COOLDOWN_MS,
): { emit: boolean; next: EditLoopDedupeState | undefined } {
  if (!detection) {
    // Pattern broken — allow the same signature to fire again later.
    return { emit: false, next: undefined };
  }
  if (
    previous
    && previous.signature === detection.signature
    && now - previous.at < cooldownMs
  ) {
    return { emit: false, next: previous };
  }
  if (previous && previous.signature === detection.signature) {
    // Same loop still active past cooldown: keep suppressed until the pattern
    // breaks (next === undefined) so we do not spam the log every minute.
    return { emit: false, next: previous };
  }
  return {
    emit: true,
    next: { signature: detection.signature, at: now },
  };
}
