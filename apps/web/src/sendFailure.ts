export interface FailedSend {
  sessionId: string;
  kind: "unavailable";
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

export function reportSendFailure(sessionId: string, error: unknown): FailedSend | null {
  if (!isUnavailableSendError(error)) {
    clearSendFailure(sessionId);
    return null;
  }
  const failure: FailedSend = { sessionId, kind: "unavailable" };
  failures.set(sessionId, failure);
  publish();
  return failure;
}

export function clearSendFailure(sessionId: string): void {
  if (!failures.delete(sessionId)) return;
  publish();
}

export function getSendFailure(sessionId: string | null): FailedSend | null {
  return sessionId ? failures.get(sessionId) ?? null : null;
}

export function subscribeSendFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
