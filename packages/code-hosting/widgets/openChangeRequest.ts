// A request to show one change request in the provider's own view, made from
// outside it (the chat's watch line, a timeline fact). The view takes it when
// it mounts or while it is open; a request nobody takes soon goes stale, so a
// later, unrelated open of the view never jumps to an old pull request.
const STALE_MS = 10_000;

interface OpenRequest {
  provider: string;
  projectId: string;
  number: number;
  at: number;
}

let pending: OpenRequest | null = null;
const listeners = new Set<() => void>();

export function requestChangeRequestOpen(input: { provider: string; projectId: string; number: number }): void {
  pending = { ...input, at: Date.now() };
  for (const listener of [...listeners]) listener();
}

/** The pending request for this provider and project, once. */
export function takeChangeRequestOpen(provider: string, projectId: string | null): { number: number } | null {
  const request = pending;
  if (!request || request.provider !== provider) return null;
  if (Date.now() - request.at > STALE_MS) { pending = null; return null; }
  if (!projectId || request.projectId !== projectId) return null;
  pending = null;
  return { number: request.number };
}

export function subscribeChangeRequestOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
