import { scopedDraftCacheKey } from "./draftRecord.ts";
import { shouldSurfaceLocalMutationRecovery } from "./mutationIntent.ts";

export interface FailedSend {
  sessionId: string;
  kind: "unavailable" | "unknown";
}

const failures = new Map<string, FailedSend>();
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of [...listeners]) listener();
}

export function isUnavailableSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
  if (/epoch-pending|confirmation-required|binding-mismatch|epoch-proof-required/i.test(`${code} ${message}`)) {
    return false;
  }
  return /\b503\b|\bunavailable\b/i.test(message);
}

export function reportSendFailure(sessionId: string, error: unknown, capturedScopeKey = scopedDraftCacheKey(sessionId)): FailedSend | null {
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : 0;
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "";
  // Reconnect/session-open reconciliation can race the exact POST that wrote
  // the durable `unknown` marker — or finish after that POST already succeeded
  // and cleared it. Only an orphaned durable intent is a real recovery state.
  if (code === "outcome-unknown" && !shouldSurfaceLocalMutationRecovery(sessionId)) return null;
  if (code === "outcome-unknown" || status === 0 || status >= 500) {
    const failure: FailedSend = { sessionId, kind: "unknown" };
    failures.set(capturedScopeKey, failure);
    publish();
    return failure;
  }
  if (!isUnavailableSendError(error)) {
    clearSendFailure(sessionId, capturedScopeKey);
    return null;
  }
  const failure: FailedSend = { sessionId, kind: "unavailable" };
  failures.set(capturedScopeKey, failure);
  publish();
  return failure;
}

export function clearSendFailure(sessionId: string, capturedScopeKey = scopedDraftCacheKey(sessionId)): void {
  if (!failures.delete(capturedScopeKey)) return;
  publish();
}

export function getSendFailure(sessionId: string | null): FailedSend | null {
  return sessionId ? failures.get(scopedDraftCacheKey(sessionId)) ?? null : null;
}

export function subscribeSendFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
