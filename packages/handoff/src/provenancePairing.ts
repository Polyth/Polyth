import type { HandoffResultImportedData } from "@polyth/contracts";
import type { SessionEvent } from "@polyth/contracts";
import { hashText } from "./hash.ts";

export interface PairedProvenance {
  provenance: HandoffResultImportedData["provenance"];
  importedAt: number;
}

const pendingBySession = new Map<string, { provenance: HandoffResultImportedData["provenance"]; textHash: string; importedAt: number }>();
const pairedByMessage = new Map<string, PairedProvenance>();

function messageKey(sessionId: string, eventSeq: number): string {
  return `${sessionId}:${eventSeq}`;
}

export function noteImportPending(
  sessionId: string,
  provenance: HandoffResultImportedData["provenance"],
  textHash: string,
  importedAt: number,
): void {
  pendingBySession.set(sessionId, { provenance, textHash, importedAt });
}

export function pairUserMessage(event: SessionEvent): void {
  if (event.type !== "user/message") return;
  const pending = pendingBySession.get(event.sessionId);
  if (!pending) return;
  const text = typeof event.data.text === "string" ? event.data.text : "";
  if (hashText(text) !== pending.textHash) return;
  pairedByMessage.set(messageKey(event.sessionId, event.seq), {
    provenance: pending.provenance,
    importedAt: pending.importedAt,
  });
  pendingBySession.delete(event.sessionId);
}

export function getPairedProvenance(sessionId: string, eventSeq: number): PairedProvenance | null {
  return pairedByMessage.get(messageKey(sessionId, eventSeq)) ?? null;
}

/** Test helper — clears module state between cases. */
export function resetProvenancePairing(): void {
  pendingBySession.clear();
  pairedByMessage.clear();
}
