// Recovery of a draft that vanished without a send. The composer keeps the
// text for a short window and offers it back; a send always wins.
export const CLEARED_DRAFT_MIN_CHARS = 20;
export const CLEARED_DRAFT_WINDOW_MS = 10_000;

export interface ClearedDraft {
  text: string;
  at: number;
}

/** A change from `prev` to `next` that emptied a real draft the person had not
 *  sent. `lastSent` is the text of the latest send: the composer empties itself
 *  after it, and that is never a loss. */
export function captureClearedDraft(input: {
  prev: string;
  next: string;
  lastSent: string | null;
  now: number;
}): ClearedDraft | null {
  if (input.next.trim() !== "") return null;
  const kept = input.prev.trim();
  if (kept.length < CLEARED_DRAFT_MIN_CHARS) return null;
  if (input.lastSent !== null && input.lastSent.trim() === kept) return null;
  return { text: input.prev, at: input.now };
}

export function clearedDraftLive(draft: ClearedDraft | null, now: number): draft is ClearedDraft {
  return draft !== null && now - draft.at < CLEARED_DRAFT_WINDOW_MS;
}

/** New typing of this many characters means the person moved on. */
export function typingDismissesClearedDraft(next: string): boolean {
  return next.length >= CLEARED_DRAFT_MIN_CHARS;
}

/** Cmd/Ctrl+Z (not Shift) while a cleared draft waits and the input is empty. */
export function isRestoreUndoKey(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  return input.key.toLowerCase() === "z" && Boolean(input.ctrlKey || input.metaKey)
    && !input.shiftKey && !input.altKey;
}

/** The restore shortcut as this keyboard names it. */
export function restoreDraftKeyLabel(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): string {
  return /Mac|iPhone|iPad/i.test(platform) ? "\u2318Z" : "Ctrl Z";
}
