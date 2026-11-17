// SERVER_TOOL_QUIET_BUS: packages hear that an open tool call has been quiet
// for a while and nobody kept it running, before Polyth's silence stop. The
// session service announces once per quiet stretch; this adds the Space and
// project from the projection. Observation only: keeping the call goes through
// an authorized facade's `keepToolRunning`.
import type { SessionProjection } from "@polyth/contracts";
import type { ServerToolQuietBus, ServerToolQuietEvent } from "@polyth/plugins";

export type ToolQuietNotice = Omit<ServerToolQuietEvent, "spaceId" | "projectId">;

export function createToolQuietBus(deps: {
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  onError?(error: unknown): void;
}): { service: ServerToolQuietBus; publish(notice: ToolQuietNotice): void } {
  const listeners = new Set<(event: ServerToolQuietEvent) => void | Promise<void>>();
  const report = deps.onError ?? ((error: unknown) => console.error("[polyth] package tool-quiet listener failed", error));
  return {
    service: {
      subscribe(listener) {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      },
    },
    publish(notice) {
      if (!listeners.size) return;
      void deps.projection(notice.sessionId)
        .then((projection) => {
          if (!projection) return;
          const event: ServerToolQuietEvent = {
            ...notice,
            ...(projection.spaceId ? { spaceId: projection.spaceId } : {}),
            ...(projection.projectId ? { projectId: projection.projectId } : {}),
          };
          // Listeners never hold up the session service, or each other.
          for (const listener of [...listeners]) void Promise.resolve().then(() => listener(event)).catch(report);
        })
        .catch(report);
    },
  };
}
