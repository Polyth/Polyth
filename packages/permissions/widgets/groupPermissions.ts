import type { PendingPermission } from "../../../apps/web/src/reduce.ts";

export interface PermissionGroup {
  key: string;
  requests: PendingPermission[];
}

/** Group only identical approval subjects. Keep every canonical request ID so
 * a visible group decision answers each request through the normal API. */
export function groupPermissions(permissions: readonly PendingPermission[]): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>();
  const seen = new Set<string>();
  for (const request of permissions) {
    if (request.status !== "pending") continue;
    const identity = JSON.stringify([request.sessionId, request.requestId]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = JSON.stringify([
      request.sessionId,
      // A parent's mirrored cards stay separate per subagent.
      request.sourceSessionId ?? null,
      request.permission,
      request.tool ?? null,
      request.patterns,
      request.preview
        ? [request.preview.title, request.preview.lines, request.preview.risk ?? null]
        : null,
      [...new Set(request.allowedScopes ?? ["once", "session", "project"])].sort(),
    ]);
    const group = groups.get(key);
    if (group) group.requests.push(request);
    else groups.set(key, { key, requests: [request] });
  }
  return [...groups.values()];
}
