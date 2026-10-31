// SERVER_PERMISSION_WAITING_BUS: packages hear that a permission card waits
// for a person's decision. The session service notifies only when no rule or
// automatic approval decided the request (a decided answer that failed to
// deliver, a deny rule's included, is never offered) and after its card is
// published. Observation only: an answer still goes through an authorized
// facade's `replyPermission`.
import type { SessionProjection } from "@polyth/contracts";
import type { ServerPermissionWaitingBus, ServerPermissionWaitingEvent } from "@polyth/plugins";

export function createPermissionWaitingBus(deps: {
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  /** A Space with a guarded member never answers automatically. */
  guardedSpace(spaceId: string | undefined): boolean;
  onError?(error: unknown): void;
}): { service: ServerPermissionWaitingBus; publish(sessionId: string, requestId: string): void } {
  const listeners = new Set<(event: ServerPermissionWaitingEvent) => void | Promise<void>>();
  const report = deps.onError ?? ((error: unknown) => console.error("[polyth] package permission listener failed", error));
  return {
    service: {
      subscribe(listener) {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      },
    },
    publish(sessionId, requestId) {
      if (!listeners.size) return;
      void deps.projection(sessionId)
        .then((projection) => {
          const event = { sessionId, requestId, automaticAllowed: !deps.guardedSpace(projection?.spaceId) };
          // Listeners never hold up the session service, or each other.
          for (const listener of [...listeners]) void Promise.resolve().then(() => listener(event)).catch(report);
        })
        .catch(report);
    },
  };
}
