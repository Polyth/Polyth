// Per-session composer draft: restored on session switch, autosaved while typing.
// Also owns marker-seeded draft provenance (UX-MSG-ACTIONS): a rewind or fork
// marker seeds the composer at most once, and reload never overwrites an
// edited draft or reinserts a deliberately cleared one.
// UX-PANE-MODEL: pane/session transitions never rely on the 250ms
// debounce — the outgoing text is flushed synchronously on session switch,
// pagehide, and composer unmount (legacy navigation adapters), so nothing
// typed is lost when a workspace surface opens, expands, or closes.
import type { AttachmentRef } from "@polyth/contracts";
import { saveDraft } from "./utils.ts";
import { hydratePendingAttachments, seedAttachments } from "./attachments.ts";
import { shouldApplySeed, type SeedRecord } from "./messageActions.ts";
import { hydrateScopedDraftRecord, loadScopedDraftRecord, updateScopedDraftRecord } from "./draftRecord.ts";

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
 * composer; local browser storage remains synchronous and needs no await. */
export async function hydrateComposerDraft(sessionId: string): Promise<void> {
  await hydrateScopedDraftRecord(sessionId);
  await hydratePendingAttachments(sessionId);
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
