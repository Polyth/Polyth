import type { ReviewView } from "./branchReview.ts";

/** A review view asked for before Source Control mounts: the view, and for
 *  Conflicts the file to open first. */
export interface ReviewHandoff {
  scope: ReviewView;
  path?: string;
}

const pending = new Map<string, ReviewHandoff>();
const listeners = new Set<() => void>();
export function handoffReviewScope(identity: string, scope: ReviewView, path?: string): void {
  pending.set(identity, path === undefined ? { scope } : { scope, path });
  for (const listener of listeners) listener();
}
export function consumeReviewScope(identity: string): ReviewHandoff | undefined {
  const handoff = pending.get(identity);
  pending.delete(identity);
  return handoff;
}
export function subscribeReviewScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
