// REST per docs/PLAN.md §5 + static web bundle serving. node:http only.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { JsonObject, SessionService } from "@polyth/contracts";
import type { ProjectService } from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

/** A plugin-contributed route group: returns true when it handled the request.
 *  This is the HTTP face of a capability contribution — feature packages never
 *  edit this file, they hand a RouteHandler to the boot profile. */
export type RouteHandler = (rc: RouteRequest) => Promise<boolean>;
export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  body(): Promise<Record<string, unknown>>;
  json(code: number, body: unknown): void;
}

export interface HttpDeps {
  sessions: SessionService;
  projects: ProjectService;
  runtimes: RuntimePool;
  capabilities(): string[];
  webDist: string;
  version: string;
  routes?: RouteHandler[];
}

export function createHttpServer(deps: HttpDeps): Server {
  const { sessions, projects } = deps;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (path === "/api/health" && method === "GET") {
        return json(res, 200, { ok: true, version: deps.version, capabilities: deps.capabilities() });
      }
      if (path === "/api/projects" && method === "GET") return json(res, 200, await projects.list());
      if (path === "/api/projects" && method === "POST") {
        const b = await readBody(req);
        return json(res, 200, await projects.add(String(b.path), b.name ? String(b.name) : undefined));
      }
      if (path === "/api/projects/create" && method === "POST") {
        const b = await readBody(req);
        return json(res, 200, await projects.create(String(b.path), b.name ? String(b.name) : undefined));
      }
      let m = path.match(/^\/api\/projects\/([^/]+)$/);
      if (m && method === "DELETE") { await projects.remove(m[1]!); return json(res, 200, { ok: true }); }

      if (path === "/api/sessions" && method === "GET") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        if (projectId) await sessions.sync(projectId).catch((err) => console.warn("[polyth] OpenCode session sync failed", err));
        return json(res, 200, await sessions.list(projectId));
      }
      if (path === "/api/sessions" && method === "POST") {
        const b = await readBody(req);
        const ref = await sessions.create({
          projectId: String(b.projectId),
          ...(b.title ? { title: String(b.title) } : {}),
          ...(b.model ? { model: b.model as { providerID: string; modelID: string } } : {}),
          ...(b.agent ? { agent: String(b.agent) } : {}),
          ...(b.worktreePath ? { worktreePath: String(b.worktreePath) } : {}),
        });
        return json(res, 200, ref);
      }
      m = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (m && method === "GET") return json(res, 200, await sessions.snapshot(m[1]!));
      m = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (m && method === "GET") {
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
        return json(res, 200, await sessions.events(m[1]!, afterSeq));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
      if (m && method === "POST") {
        const b = await readBody(req);
        const delivery = b.delivery;
        return json(res, 200, await sessions.send(m[1]!, {
          text: String(b.text ?? ""),
          ...(b.model ? { model: b.model as { providerID: string; modelID: string } } : {}),
          ...(b.agent ? { agent: String(b.agent) } : {}),
          ...(delivery === "steer" || delivery === "queue" || delivery === "interrupt" || delivery === "normal"
            ? { delivery } : {}),
          ...(b.dismissPending === true ? { dismissPending: true } : {}),
          ...(b.agentProfileId ? { agentProfileId: String(b.agentProfileId) } : {}),
        }));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/queue$/);
      if (m && method === "GET") return json(res, 200, await sessions.queueList?.(m[1]!) ?? []);
      m = path.match(/^\/api\/sessions\/([^/]+)\/queue\/order$/);
      if (m && method === "PATCH") {
        const b = await readBody(req);
        const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
        return json(res, 200, await sessions.queueReorder?.(m[1]!, ids) ?? []);
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)$/);
      if (m && method === "DELETE") {
        await sessions.queueRemove?.(m[1]!, m[2]!);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/(abort|archive|restore)$/);
      if (m && method === "POST") {
        await (m[2] === "abort" ? sessions.abort(m[1]!) : m[2] === "archive" ? sessions.archive(m[1]!) : sessions.restore(m[1]!));
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/fork$/);
      if (m && method === "POST") {
        const b = await readBody(req);
        return json(res, 200, await sessions.fork(m[1]!, b.atSeq === undefined ? undefined : Number(b.atSeq)));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/rewind$/);
      if (m && method === "POST") {
        if (!sessions.rewind) throw Object.assign(new Error("session rewind unavailable"), { code: "unsupported" });
        const b = await readBody(req);
        if (b.atSeq === undefined) throw Object.assign(new Error("atSeq required"), { code: "invalid-input" });
        return json(res, 200, await sessions.rewind(m[1]!, Number(b.atSeq)));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/rewind\/clear$/);
      if (m && method === "POST") {
        if (!sessions.clearRewind) throw Object.assign(new Error("session rewind unavailable"), { code: "unsupported" });
        return json(res, 200, await sessions.clearRewind(m[1]!));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/shell$/);
      if (m && method === "POST") {
        if (!sessions.runShell) throw Object.assign(new Error("composer shell unavailable"), { code: "unsupported" });
        const b = await readBody(req);
        if (typeof b.command !== "string") throw Object.assign(new Error("command required"), { code: "invalid-input" });
        return json(res, 200, await sessions.runShell(m[1]!, b.command));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/permission\/([^/]+)$/);
      if (m && method === "POST") {
        const b = await readBody(req);
        const scope = b.scope === "session" || b.scope === "project" ? b.scope : undefined;
        await sessions.replyPermission(m[1]!, m[2]!, b.reply as "once" | "always" | "reject", scope);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/question\/([^/]+)\/reject$/);
      if (m && method === "POST") {
        await sessions.replyQuestion(m[1]!, m[2]!, { __reject: true });
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/question\/([^/]+)$/);
      if (m && method === "POST") {
        const b = await readBody(req);
        await sessions.replyQuestion(m[1]!, m[2]!, (b.answers ?? b) as JsonObject);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/(models|agents)$/);
      if (m && method === "GET") {
        // aggregate across live runtimes (per-project pools may differ)
        const projectList = await projects.list();
        const out: unknown[] = [];
        const seen = new Set<string>();
        for (const p of projectList.length ? projectList : [{ id: "__default__" }]) {
          try {
            const rt = await deps.runtimes.forProject(p.id);
            const items = m[1] === "models" ? await rt.models() : await rt.agents();
            for (const it of items) {
              const key = JSON.stringify(it);
              if (!seen.has(key)) { seen.add(key); out.push(it); }
            }
          } catch { /* runtime for that project unavailable */ }
        }
        return json(res, 200, out);
      }

      if (deps.routes?.length) {
        let bodyCache: Record<string, unknown> | undefined;
        const rc: RouteRequest = {
          req, res, url, path, method,
          body: async () => (bodyCache ??= await readBody(req)),
          json: (code, body) => json(res, code, body),
        };
        for (const route of deps.routes) if (await route(rc)) return;
      }

      if (path.startsWith("/api/")) return json(res, 404, { error: "not-found", path });

      // static web bundle
      let filePath = normalize(join(deps.webDist, path === "/" ? "index.html" : path));
      if (!filePath.startsWith(normalize(deps.webDist))) { res.writeHead(403); return res.end(); }
      if (!existsSync(filePath)) filePath = join(deps.webDist, "index.html"); // SPA fallback
      const data = await readFile(filePath);
      res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(data);
    } catch (err) {
      const e = err as Error & { code?: string; cause?: unknown };
      // A dead OpenCode transport is transient: the runtime pool respawns on
      // the next call, so give clients a retryable status and useful message.
      if (/fetch failed|terminated|ECONNREFUSED/i.test(`${e.message ?? ""} ${String(e.cause ?? "")}`)) {
        return json(res, 503, { error: "unavailable", message: "OpenCode is reconnecting. Try again in a moment." });
      }
      const status =
        e.code === "not-found" ? 404
        : e.code === "invalid-path" || e.code === "invalid-input" ? 400
        : e.code === "conflict" ? 409
        : e.code === "unsupported" ? 501
        : 500;
      json(res, status, { error: e.code ?? "internal", message: e.message });
    }
  });
}
