// Replay Theater: step-by-step playback of the file changes of a turn range.
// Pure and event-log-derived like deriveWalkthrough — file state before/after
// each step is rebuilt by folding the ordered tool results, so nothing lives
// in memory beyond the caller's own playback cursor. Browser-safe (no Node).
import type { SessionEvent } from "@polyth/contracts";
import { unifiedDiff } from "../../../apps/web/src/diff.ts";

const FILE_TOOLS = new Set(["write", "edit", "patch"]);

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const fileOf = (input: Record<string, unknown>): string | undefined => {
  const v = input.filePath ?? input.path ?? input.file;
  return typeof v === "string" && v ? v : undefined;
};

const slashes = (path: string): string => path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
const rootsOf = (roots: readonly string[]): string[] =>
  [...new Set(roots.filter(Boolean).map((root) => slashes(root).replace(/\/+$/, "")).filter(Boolean))]
    .sort((a, b) => b.length - a.length);

/** Workspace-relative display path: the longest matching root is stripped and
 *  doubled separators collapse. A path outside every root stays absolute. */
export function replayDisplayPath(file: string, roots: readonly string[] = []): string {
  const value = slashes(file);
  for (const root of rootsOf(roots)) {
    if (value.startsWith(`${root}/`)) return value.slice(root.length + 1);
  }
  return value;
}

/** Rewrite a provider diff's `---`/`+++` headers to workspace-relative paths,
 *  keeping the `a/`/`b/` prefix single (`b//abs/path` → `b/rel/path`). */
export function relativizeDiffHeaders(diff: string, roots: readonly string[] = []): string {
  return diff.replace(/^(---|\+\+\+) (?:([ab])\/)?(\S.*)$/gm, (line, mark: string, side: string | undefined, path: string) => {
    if (path === "/dev/null") return line;
    const rel = replayDisplayPath(path, roots).replace(/^\/+/, "");
    return `${mark} ${side ?? (mark === "---" ? "a" : "b")}/${rel}`;
  });
}

/** Absolute roots in free text (tool titles) become workspace-relative. */
const relativizeText = (text: string, roots: readonly string[]): string =>
  rootsOf(roots).reduce((out, root) => out.split(`${root}/`).join(""), text);

export interface ReplayOptions {
  /** Absolute workspace roots (session worktree, project, repositories). */
  roots?: readonly string[];
}

export interface ReplayFileState {
  /** File text when it is fully known, else only the changed snippet. */
  text: string;
  /** false → `text` is just the edited fragment (base content never seen). */
  complete: boolean;
}

export interface ReplayStep {
  /** index in the full (unscoped) derived list; stable across turn scopes */
  index: number;
  file: string;
  tool: string;
  explanation: string;
  diff: string;
  /** seq of the tool/result event that produced the change */
  seq: number;
  time: number;
  /** 0-based turn ordinal (user messages delimit turns); -1 before any prompt */
  turn: number;
  /** seq of the user/message that started this turn, for jump-to-message */
  messageSeq?: number;
  before: ReplayFileState | null;
  after: ReplayFileState;
}

export interface ReplayModel {
  steps: ReplayStep[];
  /** number of turns that contain at least one prompt (user/message) */
  turnCount: number;
}

export interface ReplayRange { fromTurn: number; toTurn: number }

const isHiddenPrompt = (ev: SessionEvent): boolean => {
  const d = asRecord(ev.data) ?? {};
  return d.hiddenUserMessage === true || d.autoResume === true || d.githubConflictResolution === true;
};

/** Reconstruct the (before, after) file state of every file-editing step. */
export function deriveReplay(events: readonly SessionEvent[], options: ReplayOptions = {}): ReplayModel {
  const roots = options.roots ?? [];
  const known = new Map<string, string>();
  const steps: ReplayStep[] = [];
  let turn = -1;
  let messageSeq: number | undefined;

  for (const ev of events) {
    if (ev.type === "user/message") {
      if (isHiddenPrompt(ev)) continue;
      turn += 1;
      messageSeq = ev.seq;
      continue;
    }
    if (ev.type !== "tool/result") continue;
    const d = ev.data as { tool?: unknown; title?: unknown; input?: unknown };
    const tool = typeof d.tool === "string" ? d.tool : "";
    if (!FILE_TOOLS.has(tool)) continue;
    const input = asRecord(d.input) ?? {};
    const raw = fileOf(input);
    if (!raw) continue;
    const file = replayDisplayPath(raw, roots);
    const headerPath = file.replace(/^\/+/, "");

    const prior = known.get(file);
    let before: ReplayFileState | null = prior === undefined ? null : { text: prior, complete: true };
    let after: ReplayFileState;
    let diff = typeof input.diff === "string" && input.diff.trim() ? relativizeDiffHeaders(input.diff, roots) : "";

    if (tool === "write") {
      const content = typeof input.content === "string" ? input.content : "";
      after = { text: content, complete: true };
      known.set(file, content);
      if (!diff) diff = unifiedDiff(prior ?? "", content, headerPath);
    } else if (tool === "edit") {
      const oldString = typeof input.oldString === "string" ? input.oldString : "";
      const newString = typeof input.newString === "string" ? input.newString : "";
      if (prior !== undefined && oldString && prior.includes(oldString)) {
        const next = input.replaceAll === true ? prior.split(oldString).join(newString) : prior.replace(oldString, () => newString);
        after = { text: next, complete: true };
        known.set(file, next);
      } else {
        before = { text: oldString, complete: false };
        after = { text: newString, complete: false };
        known.delete(file); // base no longer trustworthy
      }
      if (!diff) diff = unifiedDiff(oldString, newString, headerPath);
    } else {
      // patch: only the diff is authoritative; later edits can't trust a base
      after = { text: "", complete: false };
      known.delete(file);
    }
    if (!diff.trim()) continue;
    const title = typeof d.title === "string" && d.title.trim() ? relativizeText(d.title.trim(), roots) : "";
    steps.push({
      index: steps.length, file, tool,
      explanation: title || `${tool === "write" ? "Write" : tool === "edit" ? "Edit" : "Patch"} ${file}`,
      diff, seq: ev.seq, time: ev.time, turn, ...(messageSeq !== undefined ? { messageSeq } : {}),
      before, after,
    });
  }
  return { steps, turnCount: turn + 1 };
}

/** Default scope: the last turn that changed any file ("last iteration"). */
export function lastTurnRange(model: ReplayModel): ReplayRange {
  const last = model.steps[model.steps.length - 1];
  const t = last ? last.turn : Math.max(0, model.turnCount - 1);
  return { fromTurn: t, toTurn: t };
}

/** Steps within an inclusive turn range, optionally limited to some files. */
export function scopeReplay(
  steps: readonly ReplayStep[],
  range: ReplayRange,
  files?: ReadonlySet<string> | null,
): ReplayStep[] {
  const lo = Math.min(range.fromTurn, range.toTurn);
  const hi = Math.max(range.fromTurn, range.toTurn);
  return steps.filter((s) => s.turn >= lo && s.turn <= hi && (!files || files.size === 0 || files.has(s.file)));
}

/** Per-file timeline entries (file → step positions in the scoped list). */
export function timelineByFile(steps: readonly ReplayStep[]): Array<{ file: string; positions: number[] }> {
  const map = new Map<string, number[]>();
  steps.forEach((s, i) => { const l = map.get(s.file) ?? []; l.push(i); map.set(s.file, l); });
  return [...map.entries()].map(([file, positions]) => ({ file, positions }));
}

export const clampStep = (index: number, count: number): number =>
  count <= 0 ? 0 : Math.min(Math.max(0, Math.trunc(index) || 0), count - 1);

export type ReplayKey =
  | "toggle" | "next" | "prev" | "first" | "last" | "faster" | "slower" | "jump";

/** Keyboard map for the replay surface; undefined → not a replay shortcut. */
export function replayKeyAction(key: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}): ReplayKey | undefined {
  if (mods.ctrl || mods.meta || mods.alt) return undefined;
  switch (key) {
    case " ": case "k": return "toggle";
    case "ArrowRight": case "l": return "next";
    case "ArrowLeft": case "j": return "prev";
    case "Home": return "first";
    case "End": return "last";
    case "+": case "=": return "faster";
    case "-": case "_": return "slower";
    case "m": return "jump";
    default: return undefined;
  }
}

/** Heuristic for text that would render as control-character noise. */
export function looksBinary(text: string): boolean {
  if (!text) return false;
  if (text.includes("\u0000")) return true;
  const sample = text.slice(0, 8000);
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) control++;
  }
  return control / sample.length > 0.01;
}

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;
export const REPLAY_BASE_INTERVAL_MS = 1500;
export const replayIntervalMs = (speed: number): number => Math.round(REPLAY_BASE_INTERVAL_MS / Math.max(0.25, speed));
