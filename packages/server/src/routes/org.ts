// Organization routes: session rename/organize, folders,
// labels, bulk archive/restore with partial-failure reporting, richer search.
import type { BulkSessionResult, PersonMessageInput } from "@polyth/contracts";
import type { Store } from "@polyth/session";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";
import { foldText, matchWorkspaces } from "../search.ts";

/** Per-session cap on transcript snippets returned by `/api/search/sessions`. */
const MESSAGE_MATCHES_PER_SESSION = 4;

interface SessionSearchResultDto {
  sessionId: string;
  projectId: string;
  title: string;
  status: string;
  updatedAt: number;
  matches: Array<{
    field: "title" | "branch" | "label" | "message";
    snippet: string;
    ranges?: Array<[number, number]>;
    seq?: number;
    role?: "user" | "assistant";
    time?: number;
  }>;
  /** Total transcript hits in the ranked page, including ones beyond the cap. */
  messageHits: number;
  rank: number;
}

export function orgRoutes(deps: {
  spaces: SpaceServicesFor;
  store: Store;
}): RouteHandler {
  const { store } = deps;

  return async (rc) => {
    const { path, method, url, body, json } = rc;
    if (!path.startsWith("/api/")) return false;
    if (!(
      path.startsWith("/api/sessions")
      || path === "/api/conversations"
      || path.startsWith("/api/folders")
      || path.startsWith("/api/labels")
      || path.startsWith("/api/search/")
    )) return false;
    const space = rc.space;
    const { projects, sessions, guard } = deps.spaces(space);
    const spaceId = space.spaceId;
    const assertFolderInSpace = (folderId: string): void => {
      const projectId = store.folderProject(folderId);
      if (!projectId) throw Object.assign(new Error("folder not found"), { code: "not-found" });
      guard.assertProject(space, projectId);
    };
    let m = path.match(/^\/api\/sessions\/([^/]+)\/rename$/);
    if (m && method === "POST") {
      const b = await body();
      await sessions.rename?.(m[1]!, String(b.title ?? ""));
      json(200, { ok: true });
      return true;
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/organize$/);
    if (m && method === "PATCH") {
      const b = await body();
      let pinned: { position: number } | null | undefined;
      if (b.pinned === null) pinned = null;
      else if (b.pinned !== undefined) {
        if (!b.pinned || typeof b.pinned !== "object" || typeof (b.pinned as { position?: unknown }).position !== "number") {
          throw Object.assign(new Error("pinned must be null or { position }"), { code: "invalid-input" });
        }
        pinned = { position: (b.pinned as { position: number }).position };
      }
      await sessions.organize?.(m[1]!, {
        ...(b.folderId !== undefined ? { folderId: b.folderId === null ? null : String(b.folderId) } : {}),
        ...(Array.isArray(b.labelIds) ? { labelIds: b.labelIds.map(String) } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
      });
      json(200, { ok: true });
      return true;
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/read$/);
    if (m && method === "POST") {
      const b = await body();
      const seq = Number(b.seq ?? 0);
      if (!Number.isSafeInteger(seq) || seq <= 0) {
        json(400, { error: "invalid-input", message: "seq must be a positive integer" });
        return true;
      }
      await sessions.markRead?.(m[1]!, seq);
      json(200, { ok: true });
      return true;
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/draft$/);
    if (m && method === "PATCH") {
      if (!sessions.saveDraft) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      if (typeof b.text !== "string") {
        json(400, { error: "invalid-input", message: "text must be a string" });
        return true;
      }
      const expected = b.expectedDraftUpdatedAt as unknown;
      if (expected !== undefined && expected !== null
        && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0)) {
        json(400, { error: "invalid-input", message: "expectedDraftUpdatedAt must be a timestamp or null" });
        return true;
      }
      const saved = await sessions.saveDraft(m[1]!, b.text, expected);
      json(200, saved);
      return true;
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/person-messages$/);
    if (m && method === "POST") {
      if (!sessions.postPersonMessage) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      const input: PersonMessageInput = {
        text: String(b.text ?? ""),
        ...(Array.isArray(b.mentions) ? { mentions: b.mentions.map(String) } : {}),
        ...(b.carryToAgent === true ? { carryToAgent: true } : {}),
        ...(typeof b.replyToSeq === "number" ? { replyToSeq: b.replyToSeq } : {}),
        ...(typeof b.clientOperationId === "string" ? { clientOperationId: b.clientOperationId } : {}),
      };
      const result = await sessions.postPersonMessage(m[1]!, input);
      json(200, result);
      return true;
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/conversation\/start$/);
    if (m && method === "POST") {
      if (!sessions.startSessionFromConversation) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      if (!Array.isArray(b.sourceSeqs)) {
        json(400, { error: "invalid-input", message: "sourceSeqs must be a list" });
        return true;
      }
      const participants = Array.isArray(b.participants)
        ? b.participants.flatMap((raw) => {
            const entry = raw as { userId?: unknown; access?: unknown } | null;
            return entry && typeof entry.userId === "string" && typeof entry.access === "string"
              ? [{ userId: entry.userId, access: entry.access as never }]
              : [];
          })
        : [];
      const result = await sessions.startSessionFromConversation(m[1]!, {
        sourceSeqs: b.sourceSeqs.map(Number),
        participants,
        ...(typeof b.prompt === "string" ? { prompt: b.prompt } : {}),
        ...(typeof b.title === "string" ? { title: b.title } : {}),
        ...(b.harness && typeof b.harness === "object" ? { harness: b.harness as never } : {}),
        ...(b.model && typeof b.model === "object" ? { model: b.model as never } : {}),
        ...(typeof b.clientOperationId === "string" ? { clientOperationId: b.clientOperationId } : {}),
      });
      json(200, result);
      return true;
    }
    if (path === "/api/conversations" && method === "POST") {
      if (!sessions.createConversation) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      if (!Array.isArray(b.participants) || typeof b.text !== "string" || typeof b.projectId !== "string") {
        json(400, { error: "invalid-input", message: "projectId, participants[] and text are required" });
        return true;
      }
      const result = await sessions.createConversation({
        projectId: b.projectId,
        participants: b.participants.map(String),
        text: b.text,
        ...(typeof b.title === "string" ? { title: b.title } : {}),
        ...(typeof b.clientOperationId === "string" ? { clientOperationId: b.clientOperationId } : {}),
      });
      json(200, { id: result.id });
      return true;
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/mention-candidates$/);
    if (m && method === "GET") {
      if (!sessions.mentionCandidates) { json(501, { error: "unsupported" }); return true; }
      json(200, { items: await sessions.mentionCandidates(m[1]!) });
      return true;
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/mute$/);
    if (m && method === "PUT") {
      if (!sessions.setPersonMute) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      if (typeof b.muted !== "boolean") {
        json(400, { error: "invalid-input", message: "muted must be a boolean" });
        return true;
      }
      await sessions.setPersonMute(m[1]!, b.muted);
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/sessions/bulk" && method === "POST") {
      const b = await body();
      const op = b.op === "archive" || b.op === "restore" ? b.op : null;
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      if (!op || ids.length === 0) {
        json(400, { error: "invalid-input", message: "op (archive|restore) and ids[] required" });
        return true;
      }
      const result: BulkSessionResult = { succeeded: [], failed: [] };
      for (const id of ids) {
        try {
          await (op === "archive" ? sessions.archive(id) : sessions.restore(id));
          result.succeeded.push(id);
        } catch (err) {
          const code = (err as { code?: string }).code ?? "internal";
          result.failed.push({ id, code });
        }
      }
      json(200, result);
      return true;
    }
    if (path === "/api/folders" && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) { json(400, { error: "invalid-input", message: "projectId required" }); return true; }
      guard.assertProject(space, projectId);
      json(200, await store.folderList(projectId));
      return true;
    }
    if (path === "/api/folders" && method === "POST") {
      const b = await body();
      const projectId = String(b.projectId ?? "");
      guard.assertProject(space, projectId);
      json(200, await store.folderCreate(projectId, String(b.name ?? ""), b.parentId ? String(b.parentId) : undefined));
      return true;
    }
    m = path.match(/^\/api\/folders\/([^/]+)$/);
    if (m && method === "PATCH") {
      assertFolderInSpace(m[1]!);
      const b = await body();
      json(200, await store.folderUpdate(m[1]!, {
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(b.parentId !== undefined ? { parentId: b.parentId === null ? null : String(b.parentId) } : {}),
        ...(typeof b.position === "number" ? { position: b.position } : {}),
      }, Number(b.revision ?? 0)));
      return true;
    }
    if (m && method === "DELETE") {
      assertFolderInSpace(m[1]!);
      const removed = await store.folderRemove(m[1]!);
      json(removed ? 200 : 404, removed ? { ok: true } : { error: "not-found" });
      return true;
    }
    if (path === "/api/labels" && method === "GET") {
      json(200, await store.labelList(spaceId));
      return true;
    }
    if (path === "/api/labels" && method === "POST") {
      const b = await body();
      json(200, await store.labelCreate(String(b.name ?? ""), String(b.color ?? "#888888"), spaceId));
      return true;
    }
    m = path.match(/^\/api\/labels\/([^/]+)$/);
    if (m && method === "PATCH") {
      const b = await body();
      json(200, await store.labelUpdate(m[1]!, {
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.color === "string" ? { color: b.color } : {}),
        ...(typeof b.position === "number" ? { position: b.position } : {}),
      }, Number(b.revision ?? 0), spaceId));
      return true;
    }
    if (m && method === "DELETE") {
      const removed = await store.labelRemove(m[1]!, spaceId);
      json(removed ? 200 : 404, removed ? { ok: true } : { error: "not-found" });
      return true;
    }
    if (path === "/api/search/workspaces" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim();
      const archivedFlag = url.searchParams.get("archived") === "true";
      if (!q && !archivedFlag) { json(200, { items: [] }); return true; }
      const [projectList, sessionList, labels] = await Promise.all([
        projects.list(),
        sessions.list(),
        store.labelList(spaceId),
      ]);
      const items = matchWorkspaces({
        projects: projectList,
        sessions: sessionList,
        labels,
        q,
        limit: Number(url.searchParams.get("limit") ?? 30),
        archived: archivedFlag,
      });
      json(200, { items });
      return true;
    }
    if (path === "/api/search/sessions" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim();
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const roleParam = url.searchParams.get("role");
      const role = roleParam === "user" || roleParam === "assistant" ? roleParam : undefined;
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 30) || 30, 100));
      if (!q) { json(200, []); return true; }
      const needle = foldText(q);
      const terms = needle.split(/\s+/).filter(Boolean);
      const [projections, labels, textHits] = await Promise.all([
        sessions.list(projectId),
        store.labelList(spaceId),
        // Scoped in SQL to the Space (and project) so a narrow scope still
        // receives a full page of its own hits, then intersected with the
        // gateway-scoped projection list before anything is returned.
        store.searchMessages({ q, limit: limit * 4, spaceId, ...(projectId ? { projectId } : {}), ...(role ? { role } : {}) }),
      ]);
      const labelName = new Map(labels.map((l) => [l.id, l.name] as const));
      const bySession = new Map<string, SessionSearchResultDto>();
      const entry = (p: { id: string; projectId: string; title: string; status: string; updatedAt: number }) => {
        let e = bySession.get(p.id);
        if (!e) {
          bySession.set(p.id, (e = {
            sessionId: p.id,
            projectId: p.projectId,
            title: p.title,
            status: p.status,
            updatedAt: p.updatedAt,
            matches: [],
            messageHits: 0,
            rank: Number.POSITIVE_INFINITY,
          }));
        }
        return e;
      };
      const includesAll = (text: string | undefined) => {
        if (!text) return false;
        const folded = foldText(text);
        return terms.every((t) => folded.includes(t));
      };
      // Metadata matches are not FTS hits; every typed term must appear.
      for (const p of projections) {
        if (role) break; // role-filtered searches are message-only
        if (includesAll(p.title)) entry(p).matches.push({ field: "title", snippet: p.title.slice(0, 120) });
        if (includesAll(p.branch)) entry(p).matches.push({ field: "branch", snippet: p.branch! });
        for (const lid of p.labelIds ?? []) {
          const name = labelName.get(lid);
          if (includesAll(name)) entry(p).matches.push({ field: "label", snippet: name! });
        }
      }
      const projIndex = new Map(projections.map((p) => [p.id, p] as const));
      for (const hit of textHits) {
        const p = projIndex.get(hit.sessionId);
        if (!p) continue;
        const e = entry(p);
        e.messageHits += 1;
        e.rank = Math.min(e.rank, hit.rank);
        if (e.matches.filter((m) => m.field === "message").length < MESSAGE_MATCHES_PER_SESSION) {
          e.matches.push({
            field: "message",
            snippet: hit.snippet,
            ranges: hit.ranges,
            seq: hit.seq,
            role: hit.role,
            time: hit.time,
          });
        }
      }
      // Metadata hits lead (a title match is the strongest intent signal),
      // then message hits by relevance, recency breaking ties.
      const results = [...bySession.values()]
        .filter((e) => e.matches.length > 0)
        .sort((a, b) => {
          const am = a.matches.some((m) => m.field !== "message") ? 0 : 1;
          const bm = b.matches.some((m) => m.field !== "message") ? 0 : 1;
          if (am !== bm) return am - bm;
          if (am === 0) return b.updatedAt - a.updatedAt;
          if (a.rank !== b.rank) return a.rank - b.rank;
          return b.updatedAt - a.updatedAt;
        })
        .slice(0, limit)
        .map(({ rank: _rank, ...rest }) => rest);
      json(200, results);
      return true;
    }
    return false;
  };
}
