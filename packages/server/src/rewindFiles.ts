import type {
  JsonObject,
  RewindFilesUnavailableReason,
  SessionEvent,
  WorkspaceCheckpointData,
} from "@polyth/contracts";
import { extractChangedFiles } from "@polyth/contracts/tool-edits";
import type { WorkspaceCheckpointTurn } from "@polyth/plugins";

/** Event type of a per-turn workspace snapshot (ignorable, never history). */
export const WORKSPACE_CHECKPOINT_EVENT = "workspace/checkpoint";

/** Turns a rollback to `atSeq` would undo, oldest first, read from the
 *  durable log: each admitted turn's checkpoints and the paths this chat's
 *  edit tools reported in it. */
export type RewindCheckpointTurns =
  | {
      ok: true;
      turns: WorkspaceCheckpointTurn[];
      /** Repository top-level every checkpoint in the range covers. */
      root: string;
      /** The newest turn has no `after` snapshot yet because it is running;
       *  the caller supplies a provisional one (preview) or refuses (apply). */
      runningPromptSeq?: number;
    }
  | { ok: false; reason: RewindFilesUnavailableReason };

const objectOf = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const stringOf = (value: unknown): string => typeof value === "string" ? value : "";

const checkpointData = (event: SessionEvent): WorkspaceCheckpointData | undefined => {
  if (event.type !== WORKSPACE_CHECKPOINT_EVENT) return undefined;
  const data = objectOf(event.data);
  const promptSeq = Number(data?.promptSeq);
  const phase = data?.phase;
  if (!Number.isSafeInteger(promptSeq) || (phase !== "before" && phase !== "after")) return undefined;
  return data as unknown as WorkspaceCheckpointData;
};

/** Paths reported by edit tools in `events` (tool/call|started input joined
 *  to its tool/result, keyed by callId: some harnesses name the result
 *  `tool`, so the name is remembered from the call). */
export const editedPaths = (events: readonly SessionEvent[]): string[] => {
  const open = new Map<string, { tool: string; input: JsonObject }>();
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool/call" && event.type !== "tool/started" && event.type !== "tool/result") continue;
    const data = objectOf(event.data) ?? {};
    const callId = stringOf(data.callId);
    if (!callId) continue;
    if (event.type !== "tool/result") {
      const input = objectOf(data.input);
      const existing = open.get(callId);
      if (existing) {
        if (input && Object.keys(input).length > 0) existing.input = input;
        if (!existing.tool) existing.tool = stringOf(data.tool);
      } else {
        open.set(callId, { tool: stringOf(data.tool), input: input ?? {} });
      }
      continue;
    }
    const started = open.get(callId);
    open.delete(callId);
    // A result repeating an empty input must not hide the call's real one.
    const late = objectOf(data.input);
    const input = late && Object.keys(late).length > 0 ? late : started?.input ?? {};
    const tool = started?.tool || stringOf(data.tool);
    for (const path of extractChangedFiles(tool, input, objectOf(data.metadata))) {
      paths.add(path);
    }
  }
  return [...paths];
};

/**
 * `visible` is the effective history (no active rewind); `all` the complete
 * log, where checkpoints of every visible prompt are found. A prompt with no
 * checkpoint at all was steered or queued into a turn another prompt started;
 * its work belongs to that turn. A rollback can only start at a prompt that
 * started its own turn.
 */
export function rewindCheckpointTurns(
  visible: readonly SessionEvent[],
  all: readonly SessionEvent[],
  atSeq: number,
  options: { running: boolean },
): RewindCheckpointTurns {
  const target = visible.find((event) => event.seq === atSeq);
  if (!target || target.type !== "user/message") return { ok: false, reason: "mid-turn" };

  const before = new Map<number, WorkspaceCheckpointData>();
  const after = new Map<number, WorkspaceCheckpointData>();
  for (const event of all) {
    const data = checkpointData(event);
    if (!data || data.promptSeq < atSeq) continue;
    // The newest record of a phase wins (a stop with open requests may be
    // followed by another stop of the same turn).
    (data.phase === "before" ? before : after).set(data.promptSeq, data);
  }

  const prompts = visible
    .filter((event) => event.type === "user/message" && event.seq >= atSeq && before.has(event.seq))
    .map((event) => event.seq);
  if (prompts[0] !== atSeq) return { ok: false, reason: "no-snapshot" };

  const turns: WorkspaceCheckpointTurn[] = [];
  let root: string | undefined;
  let runningPromptSeq: number | undefined;
  for (let index = 0; index < prompts.length; index++) {
    const promptSeq = prompts[index]!;
    const nextPromptSeq = prompts[index + 1] ?? Number.POSITIVE_INFINITY;
    const opened = before.get(promptSeq)!;
    if (!opened.commit || !opened.root) return { ok: false, reason: "no-snapshot" };
    if (root !== undefined && opened.root !== root) return { ok: false, reason: "no-snapshot" };
    root = opened.root;
    const closed = after.get(promptSeq);
    const isNewest = index === prompts.length - 1;
    if (!closed?.commit) {
      if (isNewest && options.running) {
        runningPromptSeq = promptSeq;
      } else {
        return { ok: false, reason: "no-snapshot" };
      }
    } else if (closed.root !== root) {
      return { ok: false, reason: "no-snapshot" };
    }
    const skipped = [...(opened.skipped ?? []), ...(closed?.skipped ?? [])];
    turns.push({
      promptSeq,
      before: opened.commit,
      after: closed?.commit ?? "",
      touched: editedPaths(visible.filter((event) => event.seq > promptSeq && event.seq < nextPromptSeq)),
      ...(skipped.length > 0 ? { skipped } : {}),
    });
  }
  if (!root) return { ok: false, reason: "no-snapshot" };
  return { ok: true, turns, root, ...(runningPromptSeq !== undefined ? { runningPromptSeq } : {}) };
}

/** A checkpoint's root must still be the checkout the session works in: a
 *  chat moved into its own worktree (or another project) since must never
 *  have files written into a different checkout. */
export const cwdInsideRoot = (cwd: string, root: string, sep: string): boolean =>
  cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
