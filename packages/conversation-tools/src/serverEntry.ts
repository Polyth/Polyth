import { REMOTE_CAPABILITY, type RemoteAccessPolicy, type RouteHandler } from "@polyth/contracts";
import type { ServerPackage, ServerPackageHost } from "@polyth/plugins";
import { findConversation, FIND_QUERY_MAX } from "./search.ts";

export const CONVERSATION_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["conversation"],
  http: [{ methods: ["GET"], path: "/api/conversation/:sessionId/find", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false }],
};

export function conversationRoutes(host: ServerPackageHost): RouteHandler {
  return async (rc) => {
    const match = /^\/api\/conversation\/([^/]+)\/find$/.exec(rc.path);
    if (!match || rc.method !== "GET") return false;
    const sessionId = decodeURIComponent(match[1]!);
    const sessions = host.forSpace(rc.space).sessions;
    // Scope validation precedes both query validation and history access.
    // A valid foreign-Space id gets the same response as an absent id.
    try { await sessions.snapshot(sessionId); }
    catch { throw Object.assign(new Error("Session unavailable"), { code: "not-found" }); }
    const query = rc.url.searchParams.get("q") ?? "";
    const rawOffset = rc.url.searchParams.get("offset") ?? "0";
    const offset = Number(rawOffset);
    if (query.length > FIND_QUERY_MAX || !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset)) {
      throw Object.assign(new Error("Invalid conversation search"), { code: "invalid-input" });
    }
    const events = query ? await sessions.events(sessionId) : [];
    rc.json(200, findConversation(sessionId, events, query, offset));
    return true;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  return { remoteAccess: CONVERSATION_REMOTE_ACCESS, routes: conversationRoutes(host) };
}
