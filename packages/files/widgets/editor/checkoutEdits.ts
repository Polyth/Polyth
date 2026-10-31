/** Pure, browser-safe: every chat's edits in one repository checkout.
 *
 * Sources are the viewing chat (live render model + server history) and the
 * other chats the server reports for the same checkout. Each chat gets a
 * stable colour slot: the viewing chat slot 0, the others by creation order.
 */
import type { JsonObject } from "@polyth/contracts";
import { toolEditFragments, type EditFragment } from "./editFragments.ts";
import {
  collectSessionChanges,
  relativeToRoots,
  type ChangeKind,
  type GitKindEntry,
  type SessionChange,
} from "./sessionChanges.ts";

/** One completed edit-tool call (server `SessionEditCall` or a live tool message). */
export interface EditCall {
  callId: string;
  seq: number;
  time: number;
  tool: string;
  input: JsonObject;
  metadata?: JsonObject;
  changedFiles: readonly string[];
  /** Rewound away in the viewing chat: not part of its narrative any more. */
  undone?: boolean;
}

export interface EditSource {
  sessionId: string;
  title: string;
  createdAt: number;
  viewer: boolean;
  calls: readonly EditCall[];
  /** Sequence of the chat's latest user message (latest-turn emphasis). */
  lastUserSeq?: number;
}

export interface FileEditRecord {
  sessionId: string;
  seq: number;
  time: number;
  fragments: readonly EditFragment[];
}

export interface CheckoutSession {
  sessionId: string;
  title: string;
  viewer: boolean;
  /** Colour slot: 0 for the viewing chat, 1… for the others. */
  tone: number;
}

export interface CheckoutFile extends SessionChange {
  /** Chats that edited the file, in colour-slot order. */
  sessions: readonly string[];
  /** Every edit of the file, oldest first. */
  edits: readonly FileEditRecord[];
}

export interface CheckoutEdits {
  sessions: readonly CheckoutSession[];
  files: ReadonlyMap<string, CheckoutFile>;
}

export const SESSION_TONE_SLOTS = 8;

/** CSS colour of a slot (defined by the Files surface styles). */
export const sessionToneColor = (tone: number): string =>
  tone < 0 ? "var(--session-tone-none)" : `var(--session-tone-${tone % SESSION_TONE_SLOTS})`;

/** Viewing chat first, then the other chats in creation order. */
export function assignTones(sources: readonly Pick<EditSource, "sessionId" | "createdAt" | "viewer">[]): Map<string, number> {
  const tones = new Map<string, number>();
  const viewer = sources.find((source) => source.viewer);
  if (viewer) tones.set(viewer.sessionId, 0);
  const others = sources
    .filter((source) => !source.viewer)
    .sort((left, right) => left.createdAt - right.createdAt || left.sessionId.localeCompare(right.sessionId));
  others.forEach((source, index) => tones.set(source.sessionId, 1 + (index % (SESSION_TONE_SLOTS - 1))));
  return tones;
}

/** Kind of a path after merging chats: the newest edit decides. */
function newer(left: (SessionChange & { time: number }) | undefined, right: SessionChange & { time: number }): boolean {
  return !left || right.time > left.time || (right.time === left.time && right.seq > left.seq);
}

export function buildCheckoutEdits(
  sources: readonly EditSource[],
  roots: readonly string[],
  git: readonly GitKindEntry[] = [],
): CheckoutEdits {
  const files = new Map<string, CheckoutFile & { time: number }>();
  const editing = new Map<string, Set<string>>();
  const records = new Map<string, FileEditRecord[]>();
  const withEdits = new Set<string>();
  for (const source of sources) {
    const calls = source.calls.filter((call) => !call.undone);
    const changes = collectSessionChanges(
      calls.map((call) => ({ kind: "tool", tool: call.tool, eventSeq: call.seq, changedFiles: call.changedFiles, status: "done" })),
      roots,
      git,
    );
    if (changes.size === 0) continue;
    withEdits.add(source.sessionId);
    const timeOf = new Map(calls.map((call) => [call.seq, call.time]));
    for (const [path, change] of changes) {
      const latestTurn = source.viewer && source.lastUserSeq !== undefined && change.seq > source.lastUserSeq;
      const time = timeOf.get(change.seq) ?? 0;
      const entry = { ...change, latestTurn, time };
      const current = files.get(path);
      if (newer(current, entry)) {
        files.set(path, {
          ...entry,
          latestTurn: latestTurn || current?.latestTurn === true,
          sessions: [],
          edits: [],
        });
      } else if (latestTurn && current) current.latestTurn = true;
      const owners = editing.get(path) ?? new Set<string>();
      owners.add(source.sessionId);
      editing.set(path, owners);
    }
    for (const call of calls) {
      const found = new Set<string>();
      for (const file of toolEditFragments(call.input, call.metadata)) {
        const path = relativeToRoots(file.path, roots);
        if (!path || !changes.has(path)) continue;
        found.add(path);
        const list = records.get(path) ?? [];
        list.push({ sessionId: source.sessionId, seq: call.seq, time: call.time, fragments: file.fragments });
        records.set(path, list);
      }
      // Paths the payload named but no fragment covered still count as edited.
      for (const changed of call.changedFiles) {
        const path = relativeToRoots(changed, roots);
        if (!path || found.has(path) || !changes.has(path)) continue;
        const list = records.get(path) ?? [];
        list.push({ sessionId: source.sessionId, seq: call.seq, time: call.time, fragments: [] });
        records.set(path, list);
      }
    }
  }
  const tones = assignTones(sources.filter((source) => withEdits.has(source.sessionId)));
  const sessions: CheckoutSession[] = sources
    .filter((source) => withEdits.has(source.sessionId))
    .map((source) => ({ sessionId: source.sessionId, title: source.title, viewer: source.viewer, tone: tones.get(source.sessionId)! }))
    .sort((left, right) => left.tone - right.tone);
  const result = new Map<string, CheckoutFile>();
  for (const [path, file] of files) {
    const { time: _time, ...change } = file;
    result.set(path, {
      ...change,
      sessions: [...(editing.get(path) ?? [])].sort((left, right) => (tones.get(left) ?? 0) - (tones.get(right) ?? 0)),
      edits: (records.get(path) ?? []).sort((left, right) => left.time - right.time || left.seq - right.seq),
    });
  }
  return { sessions, files: result };
}

/**
 * The tree's change map: everything the viewing chat wrote (as before), plus
 * other chats' files while they are still uncommitted in Git, so finished
 * work of an older chat never colours the tree forever.
 */
export function treeChanges(
  edits: CheckoutEdits,
  viewerId: string | null,
  dirty: ReadonlySet<string>,
): Map<string, CheckoutFile> {
  const result = new Map<string, CheckoutFile>();
  for (const [path, file] of edits.files) {
    if ((viewerId && file.sessions.includes(viewerId)) || dirty.has(path)) result.set(path, file);
  }
  return result;
}

export type { ChangeKind };
