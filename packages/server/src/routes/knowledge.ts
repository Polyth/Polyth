// Project knowledge routes (WP10). Attach-to-chat appends knowledge/attached
// with the exact revision AND body to the session log BEFORE any model/UI use,
// so replay survives later edits or deletion of the source record.
import { knowledgeDigest } from "@polyth/knowledge";
import type { KnowledgeKind, KnowledgePatch, KnowledgeStore } from "@polyth/knowledge";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";

export interface KnowledgeRouteDeps {
  knowledge: KnowledgeStore;
  events: {
    append(sessionId: string, type: string, data: JsonObject): Promise<SessionEvent>;
  };
}

const KINDS: KnowledgeKind[] = ["note", "spec", "plan", "memory"];

export function knowledgeRoutes(deps: KnowledgeRouteDeps): RouteHandler {
  const { knowledge } = deps;
  return async ({ path, method, url, body, json }) => {
    if (path === "/api/knowledge" && method === "GET") {
      const kindRaw = url.searchParams.get("kind");
      json(200, await knowledge.list({
        projectId: url.searchParams.get("projectId") ?? "",
        ...(kindRaw && KINDS.includes(kindRaw as KnowledgeKind) ? { kind: kindRaw as KnowledgeKind } : {}),
        ...(url.searchParams.get("q") ? { q: url.searchParams.get("q")! } : {}),
        ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
        ...(url.searchParams.get("offset") ? { offset: Number(url.searchParams.get("offset")) } : {}),
      }));
      return true;
    }
    if (path === "/api/knowledge" && method === "POST") {
      const b = await body();
      json(200, await knowledge.create({
        projectId: String(b.projectId ?? ""),
        kind: (KINDS.includes(b.kind as KnowledgeKind) ? b.kind : "note") as KnowledgeKind,
        title: String(b.title ?? ""),
        body: String(b.body ?? ""),
        ...(Array.isArray(b.tags) ? { tags: b.tags.map(String) } : {}),
        ...(b.sourceSessionId ? { sourceSessionId: String(b.sourceSessionId) } : {}),
      }));
      return true;
    }
    let m = path.match(/^\/api\/knowledge\/([^/]+)$/);
    if (m && method === "GET") {
      const item = await knowledge.get(m[1]!);
      if (!item) json(404, { error: "not-found" });
      else json(200, item);
      return true;
    }
    if (m && method === "PATCH") {
      const b = await body();
      const patch: KnowledgePatch = {
        ...(b.title !== undefined ? { title: String(b.title) } : {}),
        ...(b.body !== undefined ? { body: String(b.body) } : {}),
        ...(Array.isArray(b.tags) ? { tags: b.tags.map(String) } : {}),
        ...(b.kind !== undefined && KINDS.includes(b.kind as KnowledgeKind) ? { kind: b.kind as KnowledgeKind } : {}),
      };
      json(200, await knowledge.update(m[1]!, patch, Number(b.expectedRevision ?? 0)));
      return true;
    }
    if (m && method === "DELETE") {
      json(200, { ok: await knowledge.remove(m[1]!) });
      return true;
    }

    // Attach a knowledge card to a session: the exact revision/body is logged
    // first; the response is only the appended event reference.
    m = path.match(/^\/api\/sessions\/([^/]+)\/knowledge$/);
    if (m && method === "POST") {
      const b = await body();
      const item = await knowledge.get(String(b.knowledgeId ?? ""));
      if (!item) {
        json(404, { error: "not-found", message: "knowledge item not found" });
        return true;
      }
      if (b.revision !== undefined && Number(b.revision) !== item.revision) {
        json(409, { error: "conflict", message: `item is at revision ${item.revision}, you attached ${Number(b.revision)}` });
        return true;
      }
      const ev = await deps.events.append(m[1]!, "knowledge/attached", {
        knowledgeId: item.id,
        revision: item.revision,
        title: item.title,
        body: item.body,
        digest: knowledgeDigest(item.body),
      });
      json(200, { ok: true, eventSeq: ev.seq, revision: item.revision });
      return true;
    }
    return false;
  };
}
