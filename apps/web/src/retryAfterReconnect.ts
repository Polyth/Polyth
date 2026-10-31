// A background read that lost its transport (a phone returning from the
// background, a Polyth Link proxy restart) has no HTTP answer to show. Asking
// the sync client to reconnect and repeating the read once the socket is back
// replaces a dead-end "connection lost" toast with the data the user wanted.
// Reads only: a mutation without a response has an unknown outcome and must
// never be replayed this way.

import type { SyncStatus } from "./sync.ts";

export interface ReconnectSignal {
  getStatus(): SyncStatus;
  subscribe(listener: () => void): () => void;
  reconnect(): void;
}

/** Ask for a reconnect and call `retry` once, on the next transition into
 *  `connected`. Returns a disposer that cancels a retry not yet delivered. */
export function retryAfterReconnect(signal: ReconnectSignal, retry: () => void): () => void {
  let settled = false;
  let unsubscribe = (): void => undefined;
  unsubscribe = signal.subscribe(() => {
    if (settled || signal.getStatus() !== "connected") return;
    settled = true;
    unsubscribe();
    retry();
  });
  signal.reconnect();
  return () => {
    if (settled) return;
    settled = true;
    unsubscribe();
  };
}
