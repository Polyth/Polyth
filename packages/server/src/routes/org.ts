// Organization routes (WP5): project PATCH, session rename/organize, folders,
// labels, bulk archive/restore with partial-failure reporting, richer search.
import type { BulkSessionResult, ProjectService, SessionService } from "@polyth/contracts";
import type { Store } from "@polyth/session";
import type { RouteHandler } from "../http.ts";
import { matchWorkspaces } from "../search.ts";

export function orgRoutes(deps: {
  projects: ProjectService;
  sessions: SessionService;
  store: Store;
}): RouteHandler {
  const { projects, sessions, store } = deps;

  return async ({ path, method, url, body, json }) => {
    if (path === "/api/projects/clone" && method === "POST") {
      if (!projects.clone) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      json(200, await projects.clone(String(b.repository ?? ""), String(b.parentPath ?? "")));
      return true;
    }

    // ---- project PATCH -----------------------------------------------------
    let m = path.match(/^\/api\/projects\/([^/]+)$/);
    if (m && method === "PATCH") {
      if (!projects.update) { json(501, { error: "unsupported" }); return true; }
      const b = await body();
      json(200, await projects.update(m[1]!, {
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.color === "string" ? { color: b.color } : {}),
        ...(typeof b.icon === "string" ? { icon: b.icon } : {}),
        ...(b.defaults && typeof b.defaults === "object" ? { defaults: b.defaults as Record<string, never> } : {}),
      }));
      return true;
    }

    // ---- session rename + organize ----------------------------------------
    m = path.match(/^\/api\/sessions\/([^/]+)\/rename$/);
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

    // ---- bulk archive/restore ----------------------------------------------
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

    // ---- folders -------------------------------------------------------------
    if (path === "/api/folders" && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) { json(400, { error: "invalid-input", message: "projectId required" }); return true; }
      json(200, await store.folderList(projectId));
      return true;
    }
    if (path === "/api/folders" && method === "POST") {
      const b = await body();
      json(200, await store.folderCreate(String(b.projectId ?? ""), String(b.name ?? ""), b.parentId ? String(b.parentId) : undefined));
      return true;
    }
    m = path.match(/^\/api\/folders\/([^/]+)$/);
    if (m && method === "PATCH") {
      const b = await body();
      json(200, await store.folderUpdate(m[1]!, {
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(b.parentId !== undefined ? { parentId: b.parentId === null ? null : String(b.parentId) } : {}),
        ...(typeof b.position === "number" ? { position: b.position } : {}),
      }, Number(b.revision ?? 0)));
      return true;
    }
    if (m && method === "DELETE") {
      const removed = await store.folderRemove(m[1]!);
      json(removed ? 200 : 404, removed ? { ok: true } : { error: "not-found" });
      return true;
    }

    // ---- labels ---------------------------------------------------------------
    if (path === "/api/labels" && method === "GET") {
      json(200, await store.labelList());
      return true;
    }
    if (path === "/api/labels" && method === "POST") {
      const b = await body();
      json(200, await store.labelCreate(String(b.name ?? ""), String(b.color ?? "#888888")));
      return true;
    }
    m = path.match(/^\/api\/labels\/([^/]+)$/);
    if (m && method === "PATCH") {
      const b = await body();
      json(200, await store.labelUpdate(m[1]!, {
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.color === "string" ? { color: b.color } : {}),
        ...(typeof b.position === "number" ? { position: b.position } : {}),
      }, Number(b.revision ?? 0)));
      return true;
    }
    if (m && method === "DELETE") {
      const removed = await store.labelRemove(m[1]!);
      json(removed ? 200 : 404, removed ? { ok: true } : { error: "not-found" });
      return true;
    }

    // ---- palette workspace search (WP13) ------------------------------------
    if (path === "/api/search/workspaces" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim();
      const archivedFlag = url.searchParams.get("archived") === "true";
      if (!q && !archivedFlag) { json(200, { items: [] }); return true; }
      const [projectList, sessionList, labels] = await Promise.all([
        projects.list(),
        sessions.list(),
        store.labelList(),
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

    // ---- richer session search --------------------------------------------
    if (path === "/api/search/sessions" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim();
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 100);
      if (!q) { json(200, []); return true; }
      const needle = q.toLowerCase();
      const [projections, labels, textHits] = await Promise.all([
        sessions.list(projectId),
        store.labelList(),
        store.searchEventText(q, limit * 2),
      ]);
      const labelName = new Map(labels.map((l) => [l.id, l.name] as const));
      const bySession = new Map<string, { sessionId: string; title: string; status: string; updatedAt: number; matches: Array<{ field: string; snippet: string }> }>();
      const entry = (p: { id: string; title: string; status: string; updatedAt: number }) => {
        let e = bySession.get(p.id);
        if (!e) bySession.set(p.id, (e = { sessionId: p.id, title: p.title, status: p.status, updatedAt: p.updatedAt, matches: [] }));
        return e;
      };
      for (const p of projections) {
        if (p.title.toLowerCase().includes(needle)) entry(p).matches.push({ field: "title", snippet: p.title.slice(0, 120) });
        if (p.branch && p.branch.toLowerCase().includes(needle)) entry(p).matches.push({ field: "branch", snippet: p.branch });
        for (const lid of p.labelIds ?? []) {
          const name = labelName.get(lid);
          if (name && name.toLowerCase().includes(needle)) entry(p).matches.push({ field: "label", snippet: name });
        }
      }
      const projIndex = new Map(projections.map((p) => [p.id, p] as const));
      for (const hit of textHits) {
        const p = projIndex.get(hit.sessionId);
        if (!p) continue; // out-of-scope project or deleted session
        const e = entry(p);
        if (e.matches.length < 3) e.matches.push({ field: "message", snippet: hit.snippet });
      }
      const results = [...bySession.values()]
        .filter((e) => e.matches.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
      json(200, results);
      return true;
    }

    return false;
  };
}
