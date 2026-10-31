import type { AttachmentRef, PromptHistoryEntryDto } from "@polyth/contracts";

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
