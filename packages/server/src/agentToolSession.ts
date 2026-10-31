// Which canonical session owns one package-tool call.
//
// Package-contributed tools do not always reach Polyth from a process that
// belongs to a single canonical session. A tool token is minted during
// capability provisioning and lives in the harness process environment for as
// long as that process runs, so the session recorded on the grant is the session
// that *started* the process. A session that later resumes the same native
// runtime leg — a fork, or any session adopted onto a running leg — shares that
// process while being a different canonical session.
//
// Ownership is therefore resolved against live Polyth state instead of trusted
// from the grant: the minted session wins when it is really running a turn,
// otherwise the turn-active sessions that share its runtime leg. Idle,
// unrelated and ambiguous callers resolve to nothing, and the bridge fails
// closed.

import { resolve } from "node:path";
import type { SessionProjection } from "@polyth/contracts";

export interface AgentToolSessionRequest {
  spaceId: string;
  projectId: string;
  cwd: string;
  /** Harness the tool projection was minted for. */
  harnessId?: string;
  /** Session recorded on the grant; may be the (possibly idle) leg owner. */
  sessionId?: string;
  /** Opaque native-session correlation supplied by the harness MCP request. */
  runtimeSessionId?: string;
}

export interface AgentToolSessionDeps {
  /** Canonical sessions currently admitting or executing a turn. */
  liveSessionIds(): Iterable<string>;
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  /** Sessions of `request.projectId` inside `request.spaceId`. */
  projectSessions(): Promise<SessionProjection[]>;
  /** Absolute checkout roots the session may execute in. */
  workspaceCwds(projection: SessionProjection): Promise<Array<string | undefined>>;
}

const sameDirectory = (left: string | undefined, right: string): boolean =>
  Boolean(left) && resolve(left!) === resolve(right);

async function matchesRequest(
  projection: SessionProjection,
  request: AgentToolSessionRequest,
  deps: AgentToolSessionDeps,
): Promise<boolean> {
  if (projection.projectId !== request.projectId || projection.spaceId !== request.spaceId) return false;
  if (request.harnessId && projection.resolvedHarnessId !== request.harnessId) return false;
  const cwds = await deps.workspaceCwds(projection);
  return cwds.some((path) => sameDirectory(path, request.cwd));
}

export async function selectAgentToolSessionOwner(
  request: AgentToolSessionRequest,
  deps: AgentToolSessionDeps,
): Promise<SessionProjection | undefined> {
  const live = new Set(deps.liveSessionIds());
  const granted = request.sessionId ? await deps.projection(request.sessionId) : undefined;

  // Fast path: the minted session is the caller. This is the steady state for a
  // leg that serves exactly one canonical session and keeps the common case free
  // of any project-wide scan. Metadata takes the scoped path below so a
  // session-bound grant cannot be redirected by a foreign native-session hint.
  if (!request.runtimeSessionId && granted && request.sessionId && live.has(request.sessionId)
    && await matchesRequest(granted, request, deps)) {
    return granted;
  }

  const ids = new Set<string>();
  if (request.sessionId) {
    ids.add(request.sessionId);
    const legId = granted?.runtimeLeg?.id;
    if (legId) {
      for (const session of await deps.projectSessions()) {
        if (session.runtimeLeg?.id === legId) ids.add(session.id);
      }
    }
  } else {
    for (const sessionId of live) ids.add(sessionId);
  }

  // OpenCode and other MCP harnesses may correlate a physical-runtime call with
  // the native session that emitted it. The value is untrusted correlation data,
  // not authorization: it must identify exactly one live canonical session in
  // the same project/Space/cwd, otherwise the call fails closed.
  if (request.runtimeSessionId) {
    const candidates: SessionProjection[] = [];
    for (const sessionId of ids) {
      if (!live.has(sessionId)) continue;
      const projection = sessionId === request.sessionId ? granted : await deps.projection(sessionId);
      if (!projection) continue;
      const nativeIds = [projection.backendSessionId, projection.runtimeLeg?.nativeSessionId];
      if (!nativeIds.includes(request.runtimeSessionId)) continue;
      if (await matchesRequest(projection, request, deps)) candidates.push(projection);
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  const candidates: SessionProjection[] = [];
  for (const sessionId of ids) {
    if (!live.has(sessionId)) continue;
    const projection = sessionId === request.sessionId ? granted : await deps.projection(sessionId);
    if (!projection) continue;
    if (await matchesRequest(projection, request, deps)) candidates.push(projection);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
