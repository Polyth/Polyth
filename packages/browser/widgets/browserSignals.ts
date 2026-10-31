import type { SessionEvent } from "@polyth/contracts";
import type { BrowserSessionDto } from "@polyth/session/web-api";

/**
 * Package-local signals that let mounted Browser UI react to changes instead
 * of polling the server. Session events arrive from the host subscription in
 * the package entry; tab updates come from chat-side "Open in Browser" calls
 * that navigate a tab the viewer may already be showing.
 */
type Listener<T> = (value: T) => void;

function channel<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    publish(value: T) {
      for (const listener of [...listeners]) {
        try { listener(value); } catch { /* one viewer must not break another */ }
      }
    },
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const sessionEvents = channel<SessionEvent>();
const tabUpdates = channel<BrowserSessionDto>();

export const publishBrowserSessionEvent = sessionEvents.publish;
export const subscribeBrowserSessionEvents = sessionEvents.subscribe;
export const publishBrowserTabUpdate = tabUpdates.publish;
export const subscribeBrowserTabUpdates = tabUpdates.subscribe;

/** Session facts that can add, remove or rename a Browser tab of a chat. */
export function changesBrowserTabs(event: SessionEvent, sessionId: string | null): boolean {
  if (sessionId === null || event.sessionId !== sessionId) return false;
  return event.type === "browser/action-completed" || event.type === "browser/action-failed";
}

/** Session facts that open or settle a credential-fill approval. */
export function changesVaultFillRequests(event: SessionEvent, sessionId: string | null): boolean {
  if (sessionId === null || event.sessionId !== sessionId) return false;
  return event.type === "browser/vault-fill-requested" || event.type === "browser/vault-fill-resolved";
}

/**
 * Safety net for a missed signal (reconnect, unlinked tab). Liveness comes
 * from events; this only bounds how long a stale view can survive.
 */
export const BROWSER_RESYNC_INTERVAL_MS = 15_000;
