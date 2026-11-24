// Organization routes: session rename/organize, folders,
// labels, bulk archive/restore with partial-failure reporting, richer search.
import type { BulkSessionResult, PersonMessageInput, PersonMessageShare } from "@polyth/contracts";
import { isSessionAccessLevel } from "@polyth/contracts";
import type { Store } from "@polyth/session";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";
import { matchWorkspaces } from "../search.ts";
import { matchesSearchTerms, searchHighlightRanges, searchTerms, textHasTerm } from "@polyth/session/search-text";

/** Per-session cap on transcript snippets returned by `/api/search/sessions`. */
const MESSAGE_MATCHES_PER_SESSION = 4;
/** Newest messages a short search page scans for words inside longer words. */
const SUBSTRING_SCAN_MESSAGES = 4000;

const shareEntries = (raw: unknown): PersonMessageShare[] => (Array.isArray(raw) ? raw : []).flatMap((entry) => {
  const { userId, access } = (entry ?? {}) as { userId?: unknown; access?: unknown };
  return typeof userId === "string" && isSessionAccessLevel(access) ? [{ userId, access }] : [];
});

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
    via?: "chat" | "substring";
  }>;
  /** Total transcript hits in the ranked page, including ones beyond the cap. */
  messageHits: number;
  rank: number;
  /** 0 metadata, 1 every word in one message, 2 words spread over the chat, 3 word inside a longer word. */
  tier: number;
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
    m = path.match(/^\/api\/sessions\/([^/]+)\/move$/);
    if (m && method === "POST") {
      if (!sessions.moveToProject || !sessions.previewMoveToProject) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      if (typeof b.projectId !== "string" || !b.projectId) {
        json(400, { error: "invalid-input", message: "projectId is required" });
        return true;
      }
      if (b.expectedProjectId !== undefined && typeof b.expectedProjectId !== "string") {
        json(400, { error: "invalid-input", message: "expectedProjectId must be a string" });
        return true;
      }
      if (b.acknowledgePersonalContext !== undefined && typeof b.acknowledgePersonalContext !== "boolean") {
        json(400, { error: "invalid-input", message: "acknowledgePersonalContext must be a boolean" });
        return true;
      }
      const input = {
        projectId: b.projectId,
        ...(typeof b.expectedProjectId === "string" ? { expectedProjectId: b.expectedProjectId } : {}),
        ...(b.acknowledgePersonalContext === true ? { acknowledgePersonalContext: true } : {}),
      };
      json(200, b.dryRun === true
        ? await sessions.previewMoveToProject(m[1]!, input)
        : await sessions.moveToProject(m[1]!, input));
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
        ...(Array.isArray(b.attachments) ? { attachments: b.attachments } : {}),
        ...(Array.isArray(b.mentions) ? { mentions: b.mentions.map(String) } : {}),
        ...(b.carryToAgent === true ? { carryToAgent: true } : {}),
        ...(typeof b.replyToSeq === "number" ? { replyToSeq: b.replyToSeq } : {}),
        ...(Array.isArray(b.shareWith) ? { shareWith: shareEntries(b.shareWith) } : {}),
        ...(Array.isArray(b.requestAccessFor) ? { requestAccessFor: b.requestAccessFor.map(String) } : {}),
        ...(typeof b.clientOperationId === "string" ? { clientOperationId: b.clientOperationId } : {}),
      };
      const result = await sessions.postPersonMessage(m[1]!, input);
      json(200, result);
      return true;
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/person-messages\/(\d+)\/access$/);
    if (m && method === "POST") {
      if (!sessions.decidePersonAccess) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      if (b.decision !== "share" && b.decision !== "decline") {
        json(400, { error: "invalid-input", message: "decision must be share or decline" });
        return true;
      }
      if (b.access !== undefined && !isSessionAccessLevel(b.access)) {
        json(400, { error: "invalid-input", message: "access must be an access level" });
        return true;
      }
      json(200, await sessions.decidePersonAccess(m[1]!, Number(m[2]), {
        decision: b.decision,
        ...(b.access !== undefined ? { access: b.access } : {}),
      }));
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
    m = path.match(/^\/api\/sessions\/([^/]+)\/chat-mention-candidates$/);
    if (m && method === "GET") {
      if (!sessions.chatMentionCandidates) { json(501, { error: "unsupported" }); return true; }
      json(200, { items: await sessions.chatMentionCandidates(m[1]!) });
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
      const terms = searchTerms(q);
      if (!terms.length) { json(200, []); return true; }
      const [projections, labels, textHits] = await Promise.all([
        sessions.list(projectId),
        store.labelList(spaceId),
        // Scoped in SQL to the Space (and project) so a narrow scope still
        // receives a full page of its own hits, then intersected with the
        // gateway-scoped projection list before anything is returned. A
        // short page broadens to words spread over a chat and to words
        // inside longer words among the newest messages.
        store.searchMessages({
          q,
          limit: limit * 4,
          spaceId,
          ...(projectId ? { projectId } : {}),
          ...(role ? { role } : {}),
          broaden: { sessions: limit, scanMessages: SUBSTRING_SCAN_MESSAGES },
        }),
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
            tier: 4,
          }));
        }
        return e;
      };
      // Metadata: every typed word somewhere in the title, branch or label
      // names (the shared rule, so the sidebar and palette agree with it);
      // each field holding one of the words is reported for highlighting.
      for (const p of projections) {
        if (role) break; // role-filtered searches are message-only
        const names = (p.labelIds ?? []).map((lid) => labelName.get(lid)).filter((n): n is string => !!n);
        if (!matchesSearchTerms([p.title, p.branch, ...names], terms)) continue;
        const e = entry(p);
        e.tier = 0;
        const hit = (text: string | undefined) => !!text && terms.some((t) => textHasTerm(text, t));
        if (hit(p.title)) { const snippet = p.title.slice(0, 120); e.matches.push({ field: "title", snippet, ranges: searchHighlightRanges(snippet, terms) }); }
        if (hit(p.branch)) e.matches.push({ field: "branch", snippet: p.branch!, ranges: searchHighlightRanges(p.branch!, terms) });
        for (const name of names) if (hit(name)) e.matches.push({ field: "label", snippet: name, ranges: searchHighlightRanges(name, terms) });
      }
      const projIndex = new Map(projections.map((p) => [p.id, p] as const));
      for (const hit of textHits) {
        const p = projIndex.get(hit.sessionId);
        if (!p) continue;
        const e = entry(p);
        e.messageHits += 1;
        const tier = hit.via === "substring" ? 3 : hit.via === "chat" ? 2 : 1;
        if (tier < e.tier) { e.tier = tier; e.rank = hit.rank; }
        else if (tier === e.tier) e.rank = Math.min(e.rank, hit.rank);
        if (e.matches.filter((m) => m.field === "message").length < MESSAGE_MATCHES_PER_SESSION) {
          e.matches.push({
            field: "message",
            snippet: hit.snippet,
            ranges: hit.ranges,
            seq: hit.seq,
            role: hit.role,
            time: hit.time,
            ...(hit.via ? { via: hit.via } : {}),
          });
        }
      }
      // Metadata hits lead (a title match is the strongest intent signal),
      // then chats with every word in one message by relevance, then chats
      // that hold the words between messages, then words inside longer
      // words; recency breaks ties and orders the metadata and substring tiers.
      const results = [...bySession.values()]
        .filter((e) => e.matches.length > 0)
        .sort((a, b) => {
          if (a.tier !== b.tier) return a.tier - b.tier;
          if ((a.tier === 1 || a.tier === 2) && a.rank !== b.rank) return a.rank - b.rank;
          return b.updatedAt - a.updatedAt;
        })
        .slice(0, limit)
        .map(({ rank: _rank, tier: _tier, ...rest }) => rest);
      json(200, results);
      return true;
    }
    return false;
  };
}
