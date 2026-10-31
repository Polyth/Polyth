import { createApiTransport, type ApiTransport } from "@polyth/web-sdk";
import type { IsolationMergeResultDto, SessionProjection } from "@polyth/contracts";
import type { IsolationConflictPreview } from "../src/sessionIntegration.ts";

export function createIsolationClient(transport: ApiTransport = createApiTransport()) {
  const action = (sessionId: string, name: "merge" | "keep" | "discard" | "recover", repositoryId: string) =>
    transport.post(`/api/isolation/${encodeURIComponent(sessionId)}/${name}`, { repositoryId }) as Promise<IsolationMergeResultDto | SessionProjection>;
  return {
    merge: (sessionId: string, repositoryId: string) => action(sessionId, "merge", repositoryId) as Promise<IsolationMergeResultDto>,
    keep: (sessionId: string, repositoryId: string) => action(sessionId, "keep", repositoryId) as Promise<SessionProjection>,
    discard: (sessionId: string, repositoryId: string) => action(sessionId, "discard", repositoryId) as Promise<SessionProjection>,
    recover: (sessionId: string, repositoryId: string) => action(sessionId, "recover", repositoryId) as Promise<SessionProjection>,
    /** Where merging the session's work into its target branch conflicts now. */
    conflicts: (sessionId: string) =>
      transport.get(`/api/isolation/${encodeURIComponent(sessionId)}/conflicts`) as Promise<IsolationConflictPreview>,
  };
}
