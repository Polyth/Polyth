// Advisory edit-loop observer: tiny in-memory ring per session, never scans the log.
import type { EditLoopKind, JsonObject, RuntimeEvent } from "@polyth/contracts";

const RING = 16;
const NEED_EDITS = 3;

const EDIT_TOOL =
  /(^|[./:_-])(apply[_-]?patch|create[_-]?file|delete[_-]?file|edit|multiedit|patch|write)([./:_-]|$)/i;
const CHECK_TOOL =
  /(^|[./:_-])(bash|shell|exec|npm|pnpm|yarn|bun|cargo|make|gradle|mvn|pytest|vitest|jest|go|dotnet|cmake|tsc|eslint)([./:_-]|$)/i;
const CHECK_COMMAND =
  /\b(test|spec|build|compile|typecheck|lint|ci|check|vitest|jest|pytest|mocha|cargo\s+test|go\s+test)\b/i;

export interface ToolCallRecord {
  tool: string;
  path?: string;
  edit: boolean;
  /** Failed check/build tool (not a failed edit). */
  failedCheck: boolean;
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

export interface EditLoopDedupeState {
  signature: string;
  at: number;
}

/** Live per-session rings — advisory only; not persisted across restarts. */
const rings = new Map<string, ToolCallRecord[]>();

function usablePath(value: string): string | null {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.includes("\0") || path.includes("\n") || /^[a-z]+:\/\//i.test(path)) return null;
  return path;
}

/** Only well-known top-level path fields — no recursive JSON crawl. */
function directPath(input?: JsonObject): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "file", "filePath", "filename"] as const) {
    const value = input[key];
    if (typeof value === "string") {
      const path = usablePath(value);
      if (path) return path;
    }
  }
  return undefined;
}

function commandOf(input?: JsonObject): string {
  if (!input) return "";
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  return "";
}

function isFailed(ev: Extract<RuntimeEvent, { type: "tool/result" | "tool/error" }>): boolean {
  if (ev.type === "tool/error") return true;
  const meta = ev.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const record = meta as JsonObject;
    if (typeof record.exitCode === "number" && record.exitCode !== 0) return true;
    if (record.failed === true || record.rejected === true) return true;
  }
  return false;
}

function isCheckTool(tool: string, input?: JsonObject): boolean {
  if (!CHECK_TOOL.test(tool)) return false;
  if (/^(bash|shell|exec)$/i.test(tool) || /[/._-](bash|shell|exec)$/i.test(tool)) {
    return CHECK_COMMAND.test(commandOf(input));
  }
  return true;
}

function recordFromEvent(ev: RuntimeEvent): ToolCallRecord | null {
  if (ev.type !== "tool/result" && ev.type !== "tool/error") return null;
  const tool = typeof ev.tool === "string" ? ev.tool : "";
  if (!tool) return null;
  const input = (ev.input && typeof ev.input === "object" && !Array.isArray(ev.input))
    ? ev.input as JsonObject
    : undefined;
  const path = EDIT_TOOL.test(tool) ? directPath(input) : undefined;
  const edit = Boolean(path);
  const failedCheck = !edit && isCheckTool(tool, input) && isFailed(ev);
  return { tool, ...(path ? { path } : {}), edit, failedCheck };
}

/**
 * Strict pattern: edit A → failing check → edit A → failing check → edit A.
 * Anything else (including A/B oscillation) is ignored.
 */
export function detectEditLoop(records: readonly ToolCallRecord[]): EditLoopDetection | null {
  const relevant = records.filter((r) => r.edit || r.failedCheck);
  for (let i = 0; i + NEED_EDITS * 2 - 2 < relevant.length; i += 1) {
    const first = relevant[i]!;
    if (!first.edit || !first.path) continue;
    const path = first.path;
    let ok = true;
    const indexes: number[] = [i];
    for (let step = 1; step < NEED_EDITS * 2 - 1; step += 1) {
      const row = relevant[i + step];
      if (!row) {
        ok = false;
        break;
      }
      if (step % 2 === 1) {
        if (!row.failedCheck) {
          ok = false;
          break;
        }
      } else if (!row.edit || row.path !== path) {
        ok = false;
        break;
      }
      indexes.push(i + step);
    }
    if (!ok) continue;
    const evidence: EditLoopEvidence[] = indexes.map((index) => {
      const row = relevant[index]!;
      return {
        tool: row.tool,
        ...(row.path ? { path: row.path } : {}),
        ...(row.failedCheck ? { failed: true } : {}),
        role: row.edit ? "edit" : "check",
      };
    });
    const kind = "repeated-edit-with-failing-checks" as const;
    return {
      detected: true,
      kind,
      paths: [path],
      signature: `${kind}:${path}`,
      evidence,
    };
  }
  return null;
}

/** Push a live tool terminal event into the session ring; return detection if any. */
export function observeToolEvent(sessionId: string, ev: RuntimeEvent): EditLoopDetection | null {
  const record = recordFromEvent(ev);
  if (!record) return null;
  const ring = rings.get(sessionId) ?? [];
  ring.push(record);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  rings.set(sessionId, ring);
  return detectEditLoop(ring);
}

/** Test helper: clear in-memory rings. */
export function clearEditLoopState(sessionId?: string): void {
  if (sessionId) rings.delete(sessionId);
  else rings.clear();
}

export function shouldEmitEditLoop(
  detection: EditLoopDetection | null,
  previous: EditLoopDedupeState | undefined,
  now = Date.now(),
): { emit: boolean; next: EditLoopDedupeState | undefined } {
  if (!detection) return { emit: false, next: undefined };
  // Same loop stays suppressed until the pattern breaks (next becomes undefined).
  if (previous && previous.signature === detection.signature) {
    return { emit: false, next: previous };
  }
  void now;
  return {
    emit: true,
    next: { signature: detection.signature, at: now },
  };
}
