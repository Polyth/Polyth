// Per-session composer draft: restored on session switch, autosaved while typing.
// Also owns marker-seeded draft provenance: a rewind or fork
// marker seeds the composer at most once, and reload never overwrites an
// edited draft or reinserts a deliberately cleared one.
// Pane/session transitions never rely on the 250ms
// debounce — the outgoing text is flushed synchronously on session switch,
// pagehide, and composer unmount (legacy navigation adapters), so nothing
// typed is lost when a workspace surface opens, expands, or closes.
import type { AttachmentRef } from "@polyth/contracts";
import { saveDraft } from "./utils.ts";
import { hydratePendingAttachments, seedAttachments } from "./attachments.ts";
import { shouldApplySeed, type SeedRecord } from "./messageActions.ts";
import { loadScopedDraftRecord, updateScopedDraftRecord } from "./draftRecord.ts";
import { stripRecoveryContextBlocks } from "./recoveryDisplay.ts";

// Marker provenance belongs to the same trusted namespace as the draft text.
export function loadSeedRecord(sessionId: string): SeedRecord | null {
  return loadScopedDraftRecord(sessionId).seed ?? null;
}

export function saveSeedRecord(sessionId: string, record: SeedRecord): void {
  updateScopedDraftRecord(sessionId, { seed: record });
}

export function clearSeedRecord(sessionId: string): void {
  const record = loadScopedDraftRecord(sessionId);
  updateScopedDraftRecord(sessionId, { seed: undefined, attachments: record.attachments });
}

/** Explicit native restart hook. Call before mounting/restoring a session
 * composer; local browser storage remains synchronous and needs no await.
 * Opening a session awaits this, and the draft is a convenience, not the
 * session: a native read that stalls past its deadline (a Link stall after the
 * app resumes) leaves the composer on its local copy instead of failing the
 * open. The failed read is not cached, so the next open asks again. */
export async function hydrateComposerDraft(sessionId: string): Promise<void> {
  try {
    // Hydrates the whole scoped draft record (text included) in one read.
    await hydratePendingAttachments(sessionId);
  } catch (error) {
    console.warn("composer draft hydration failed", error);
  }
}

/** Apply a marker-owned seed at most once: writes the draft text, the pending
 *  attachment pills, and the provenance record. Returns false (and changes
 *  nothing) when this marker already seeded the session — an edit or a
 *  deliberate clear must survive reload. */
export function applyComposerSeed(
  sessionId: string,
  key: string,
  draft: { text: string; attachments?: AttachmentRef[] },
): boolean {
  if (!shouldApplySeed(loadSeedRecord(sessionId), key)) return false;
  saveDraft(sessionId, draft.text);
  seedAttachments(sessionId, draft.attachments ?? []);
  saveSeedRecord(sessionId, { key, seedText: draft.text });
  return true;
}

/** Drop a seeded draft entirely (successful Restore of the original timeline). */
export function discardComposerSeed(sessionId: string): void {
  saveDraft(sessionId, "");
  seedAttachments(sessionId, []);
  clearSeedRecord(sessionId);
}

/** Live composer text. An in-flight submit already owns an echo; the staged
 *  recovery copy must not reappear if this composer remounts mid-admission. */
export function visibleComposerDraft(stored: string, inFlightPrompt: boolean): string {
  return inFlightPrompt ? "" : stripRecoveryContextBlocks(stored);
}

// Caret/selection is UI-local state, not history: kept in memory only, bounded,
// and keyed by the scoped draft key so new-chat lanes and Spaces stay separate.
// A remembered caret only applies to the exact text it was recorded against.
const COMPOSER_SELECTION_CAP = 64;
const composerSelections = new Map<string, { length: number; hash: number; start: number; end: number }>();

function textHash(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) | 0;
  return h;
}

export function rememberComposerSelection(
  key: string,
  text: string,
  selection: { start: number; end: number },
): void {
  composerSelections.delete(key);
  composerSelections.set(key, { length: text.length, hash: textHash(text), start: selection.start, end: selection.end });
  while (composerSelections.size > COMPOSER_SELECTION_CAP) {
    const oldest = composerSelections.keys().next().value;
    if (oldest === undefined) break;
    composerSelections.delete(oldest);
  }
}

/** Remembered selection for `key`, clamped to `text`; null when none or the
 *  text changed since it was recorded. Consumes the entry. */
export function takeComposerSelection(key: string, text: string): { anchor: number; head: number } | null {
  const entry = composerSelections.get(key);
  composerSelections.delete(key);
  if (!entry || entry.length !== text.length || entry.hash !== textHash(text)) return null;
  const anchor = Math.max(0, Math.min(entry.start, text.length));
  const head = Math.max(anchor, Math.min(entry.end, text.length));
  return { anchor, head };
}

export function forgetComposerSelection(key: string): void {
  composerSelections.delete(key);
}
