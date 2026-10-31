// Self-healing model catalog (client half). The server drops its catalog
// caches when a provider says the selected model is unknown or unavailable;
// this page drops its day-long persisted copies on the same signals so the
// picker stops offering a retired model (and shows a newly added one) without
// waiting for the daily refresh or a manual Refresh.
import type { SessionEvent } from "@polyth/contracts";

/** A live terminal event that says the provider refused the selected model. */
export const signalsStaleModelCatalog = (event: Pick<SessionEvent, "type" | "data">): boolean =>
  event.type === "turn/stopped" && event.data.code === "model-unavailable";

/** A send or create refusal that says the picker offered a model, or a
 *  thinking level for it, that the runtime lacks. */
export const isStaleModelRefusal = (code: string | undefined): boolean =>
  code === "invalid-model" || code === "invalid-variant";

/** At most one client-side invalidation per window. The server throttles its
 * rediscovery the same way, so a burst of failures re-reads one fresh list. */
export function createStaleCatalogTrigger(
  invalidate: () => void,
  options: { cooldownMs?: number; now?: () => number } = {},
): () => boolean {
  const cooldownMs = options.cooldownMs ?? 10_000;
  const now = options.now ?? Date.now;
  let last: number | undefined;
  return () => {
    const at = now();
    if (last !== undefined && at - last < cooldownMs) return false;
    last = at;
    invalidate();
    return true;
  };
}
