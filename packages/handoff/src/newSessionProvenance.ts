import type { HandoffResultImportedData } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { hashText } from "./hash.ts";

type PendingImport = {
  provenance: HandoffResultImportedData["provenance"];
  textHash: string;
};

const pendingByProject = new Map<string, PendingImport[]>();

export function noteNewSessionHandoffPending(
  projectId: string,
  provenance: HandoffResultImportedData["provenance"],
  text: string,
): void {
  const list = pendingByProject.get(projectId) ?? [];
  list.push({ provenance, textHash: hashText(text) });
  pendingByProject.set(projectId, list);
}

export function takeNewSessionHandoffPending(projectId: string, text: string): PendingImport | null {
  const list = pendingByProject.get(projectId);
  if (!list) return null;
  const textHash = hashText(text);
  const idx = list.findIndex((pending) => pending.textHash === textHash);
  if (idx < 0) return null;
  const [pending] = list.splice(idx, 1);
  if (list.length === 0) pendingByProject.delete(projectId);
  else pendingByProject.set(projectId, list);
  return pending ?? null;
}

export async function flushNewSessionHandoffImport(
  projectId: string,
  sessionId: string,
  text: string,
): Promise<void> {
  const pending = takeNewSessionHandoffPending(projectId, text);
  if (!pending) return;
  const transport = createApiTransport();
  await transport.post("/api/handoff/imports", {
    sessionId,
    provenance: pending.provenance,
    textHash: pending.textHash,
  });
}

/** Test helper — clears module state between cases. */
export function resetNewSessionHandoffPending(): void {
  pendingByProject.clear();
}
