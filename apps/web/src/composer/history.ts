import type { AttachmentRef, PromptHistoryEntryDto } from "@polyth/contracts";
import { collapseChatMentions } from "./chatMentionDraft.ts";

export interface PromptHistoryDraft {
  text: string;
  attachments: AttachmentRef[];
}

export interface PromptHistoryCursor {
  entryId: string | null;
  draft: PromptHistoryDraft;
}

export interface PromptHistoryStep {
  entry: PromptHistoryEntryDto | null;
  text: string;
  attachments: AttachmentRef[];
  cursor: PromptHistoryCursor;
}

const emptyDraft = (): PromptHistoryDraft => ({ text: "", attachments: [] });

export const emptyPromptHistoryCursor = (): PromptHistoryCursor => ({
  entryId: null,
  draft: emptyDraft(),
});

type AttachmentContext = {
  projectId: string;
  worktreePath?: string | null;
};

function sameAttachmentContext(
  entry: Pick<PromptHistoryEntryDto, "projectId" | "worktreePath">,
  target: AttachmentContext,
): boolean {
  return entry.projectId === target.projectId
    && (entry.worktreePath ?? "") === (target.worktreePath ?? "");
}

/** File/image/range refs are only reusable in the source project/worktree.
 *  Cross-context recall drops path/url so send cannot resolve a different file
 *  of the same relative path. URL and browser-context attachments stay portable. */
export function attachmentsForRecall(
  entry: PromptHistoryEntryDto,
  target: AttachmentContext,
): AttachmentRef[] {
  const portable = sameAttachmentContext(entry, target);
  return entry.attachments.map((ref) => {
    if (ref.kind === "url" || ref.kind === "browser-context" || (portable && ref.path)) return ref;
    const { path: _path, url: _url, ...rest } = ref;
    return rest;
  });
}

export function isBlockedAttachment(ref: AttachmentRef): boolean {
  if (ref.kind === "url") return false;
  if (ref.kind === "browser-context") return !ref.browserContext;
  return !ref.path;
}

function snapshotDraft(current: PromptHistoryDraft): PromptHistoryDraft {
  return { text: current.text, attachments: current.attachments.slice() };
}

export function restorePromptHistoryDraft(cursor: PromptHistoryCursor): PromptHistoryStep | null {
  if (!cursor.entryId) return null;
  const draft = snapshotDraft(cursor.draft);
  return {
    entry: null,
    text: draft.text,
    attachments: draft.attachments,
    cursor: emptyPromptHistoryCursor(),
  };
}

export function stepPromptHistory(
  items: readonly PromptHistoryEntryDto[],
  current: PromptHistoryDraft,
  cursor: PromptHistoryCursor,
  direction: "up" | "down",
): PromptHistoryStep | null {
  if (items.length === 0) return null;
  if (direction === "up") {
    const idx = cursor.entryId
      ? items.findIndex((item) => item.id === cursor.entryId)
      : items.length;
    const nextIdx = idx < 0 ? -1 : idx - 1;
    if (nextIdx < 0) return null;
    const item = items[nextIdx]!;
    return {
      entry: item,
      text: item.text,
      attachments: item.attachments,
      cursor: {
        entryId: item.id,
        draft: cursor.entryId ? cursor.draft : snapshotDraft(current),
      },
    };
  }
  if (!cursor.entryId) return null;
  const idx = items.findIndex((item) => item.id === cursor.entryId);
  if (idx < 0 || idx >= items.length - 1) return restorePromptHistoryDraft(cursor);
  const item = items[idx + 1]!;
  return {
    entry: item,
    text: item.text,
    attachments: item.attachments,
    cursor: { ...cursor, entryId: item.id },
  };
}

export function shouldHandlePromptHistoryKey(input: {
  key: string;
  composing: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  autocompleteActive?: boolean;
  queueEditActive?: boolean;
}): boolean {
  if (input.composing) return false;
  if (input.autocompleteActive || input.queueEditActive) return false;
  if (input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) return false;
  return input.key === "ArrowUp" || input.key === "ArrowDown";
}

/** Ctrl+Up / Cmd+Up opens the previous-prompts palette. Plain Up/Down keep
 *  stepping through history; Alt/Shift variants stay free for the editor. */
export function isPromptHistoryPaletteKey(input: {
  key: string;
  composing: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  if (input.composing) return false;
  if (input.altKey || input.shiftKey) return false;
  return input.key === "ArrowUp" && Boolean(input.ctrlKey || input.metaKey);
}

/** Entries of one project for the palette, newest first. The store lists a
 *  scope oldest first; the palette reads the other way round. */
export function paletteEntries(
  items: readonly PromptHistoryEntryDto[],
  projectId: string | null,
): PromptHistoryEntryDto[] {
  const seen = new Set<string>();
  const out: PromptHistoryEntryDto[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (projectId && item.projectId !== projectId) continue;
    // The same words sent twice are one row: the newest copy wins.
    const key = item.text.trim();
    if (!key && item.attachments.length === 0) continue;
    if (key && seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** A prompt as a person reads it: a chat mention token shows as `@Title`, not
 *  its link markup and session id. */
export function promptDisplayText(text: string): string {
  return collapseChatMentions(text).text;
}

/** Every typed word must appear somewhere in the prompt as it is shown
 *  (case-insensitive, any order). An empty query keeps the newest-first order. */
export function filterPromptHistory(
  entries: readonly PromptHistoryEntryDto[],
  query: string,
): PromptHistoryEntryDto[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries.slice();
  return entries.filter((entry) => {
    const hay = promptDisplayText(entry.text).toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

/** The shortcut as the person's keyboard names it. */
export function promptHistoryShortcutLabel(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): string {
  return /Mac|iPhone|iPad/i.test(platform) ? "\u2318\u2191" : "Ctrl \u2191";
}
