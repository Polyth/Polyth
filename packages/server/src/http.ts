// REST per docs/PLAN.md §5 + static web bundle serving. node:http only.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { constants as zlibConstants, gzip, gzipSync } from "node:zlib";
import { extname, join, normalize, resolve, sep } from "node:path";
import type {
  AgentRuntime,
  AuthResolution,
  JsonObject,
  ModelDescriptor,
  RequestIngress,
  RouteHandler,
  RouteRequest,
  SessionService,
} from "@polyth/contracts";
import type { ProjectService } from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";
import { aggregateRuntimes } from "./runtimeAggregate.ts";
import type { ModelVisibilityService } from "./modelVisibility.ts";
import type { RuntimeCatalog } from "./runtimeCatalog.ts";
import {
  AuthorizationError,
  publicHttpIngress,
  requirePrincipalCapability,
  UNTRUSTED_INGRESS_HEADERS,
  type AuthRequestLike,
  type GateDenial,
} from "./auth.ts";
import {
  assertPairedHttpAllowed,
  CORE_REMOTE_ACCESS,
  type OwnedRemotePolicy,
} from "./remotePolicy.ts";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".map": "application/json", ".woff2": "font/woff2",
};

const HASHED_ASSET = /-[A-Z0-9]{8,}(?:\.[^./]+){1,2}$/;

// Text payloads above a kilobyte compress well; everything else (png, woff2)
// is already compressed on disk.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript))/;
const RECOVERY_CONFLICT_CODES = new Set([
  "binding-mismatch",
  "confirmation-required",
  "epoch-pending",
  "epoch-proof-required",
  "epoch-reset-unconfirmed",
  "outcome-unknown",
  "stale-evidence",
]);

/** Gzip cache keyed by path+mtime so a rebuilt dist never serves stale bytes. */
const gzipCache = new Map<string, { mtimeMs: number; gz: Buffer }>();

// JSON payloads above a kilobyte gzip in-process (no reverse proxy assumed):
// event logs and projection lists shrink ~10x on the wire.
const JSON_GZIP_MIN_BYTES = 1024;
// Above this, compression moves to the libuv threadpool at best-speed level:
// a full-log export (100MB+) must never block the event loop for seconds.
const JSON_GZIP_SYNC_MAX_BYTES = 256 * 1024;

const writeJson = (req: IncomingMessage, res: ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  if (
    payload.length > JSON_GZIP_MIN_BYTES
    && String(req.headers["accept-encoding"] ?? "").includes("gzip")
  ) {
    const buf = Buffer.from(payload, "utf8");
    res.writeHead(code, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      vary: "accept-encoding",
    });
    if (buf.length <= JSON_GZIP_SYNC_MAX_BYTES) {
      res.end(gzipSync(buf));
    } else {
      gzip(buf, { level: zlibConstants.Z_BEST_SPEED }, (err, gz) => {
        if (err) { res.destroy(err); return; }
        res.end(gz);
      });
    }
    return;
  }
  res.writeHead(code, { "content-type": "application/json" });
  res.end(payload);
};

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

const sendStaticFile = async (
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
): Promise<void> => {
  const data = await readFile(filePath);
  const contentType = MIME[extname(filePath)] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": contentType,
    "cache-control": HASHED_ASSET.test(filePath)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
  // ponytail: in-process gzip, no reverse proxy assumed.
  if (
    data.length > 1024
    && COMPRESSIBLE.test(contentType)
    && (req.headers["accept-encoding"] ?? "").includes("gzip")
  ) {
    const mtimeMs = statSync(filePath).mtimeMs;
    const hit = gzipCache.get(filePath);
    const gz = hit && hit.mtimeMs === mtimeMs ? hit.gz : gzipSync(data);
    if (gz !== hit?.gz) {
      if (gzipCache.size > 500) gzipCache.clear();
      gzipCache.set(filePath, { mtimeMs, gz });
    }
    headers["content-encoding"] = "gzip";
    headers.vary = "accept-encoding";
    res.writeHead(200, headers);
    res.end(gz);
    return;
  }
  res.writeHead(200, headers);
  res.end(data);
};

// Buffered-body ceiling: headroom over the 20MB MAX_RAW_BYTES attachment cap
// (@polyth/files) so a maximal upload survives its JSON envelope while a
// runaway client can no longer grow the heap without bound.
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // On overflow keep draining without buffering: memory stays bounded and
    // the connection ends cleanly so the 413 reliably reaches the client.
    if (size > MAX_BODY_BYTES) { overflow = true; chunks.length = 0; }
    if (!overflow) chunks.push(chunk as Buffer);
  }
  if (overflow) {
    throw Object.assign(
      new Error(`request body too large (max ${MAX_BODY_BYTES} bytes)`),
      { code: "payload-too-large" },
    );
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error("Request body must be a JSON object."), { code: "invalid-json" });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: string }).code === "invalid-json") throw error;
    throw Object.assign(new Error("Request body must be valid JSON."), { code: "invalid-json" });
  }
};

/** The gateway's route contract is public so trusted plugins can contribute it. */
export type { RouteHandler, RouteRequest } from "@polyth/contracts";

export type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ingress: RequestIngress,
) => Promise<void>;

export interface HttpAuth {
  resolve(req: AuthRequestLike, ingress: RequestIngress): AuthResolution;
  gate(req: AuthRequestLike, ingress: RequestIngress): GateDenial | null;
}

export interface HttpDeps {
  sessions: SessionService;
  projects: ProjectService;
  runtimes: RuntimePool;
  capabilities(): string[];
  webDist: string;
  /** Workspace packages root containing each package's dist/web assets. */
  packagesDir?: string;
  version: string;
  routes?: RouteHandler[];
  /** Provider/model visibility toggles (Providers & Models settings). */
  visibility?: ModelVisibilityService;
  /** Single-flight, server-lifetime OpenCode catalog cache. */
  catalog?: RuntimeCatalog;
  /** F16 gate: null = proceed, otherwise the denial to answer with. Applied
   *  to every /api path except the two the lock screen itself needs. */
  auth?: HttpAuth;
  /** Extra remote-access policies (package-owned). Core policy is always included. */
  remotePolicies?: () => readonly OwnedRemotePolicy[];
  /** Public listener id recorded on RequestIngress. */
  listenerId?: string;
}

// Public even when a password is set: the SPA lock screen must be able to
// learn that auth is required and then mint a session.
const AUTH_PUBLIC = new Set(["/api/auth/status", "/api/auth/login"]);

const headerValue = (req: IncomingMessage, name: string): string | undefined => {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
};

const stripUntrustedHeaders = (req: IncomingMessage, ingress: RequestIngress): void => {
  const stripInternal = () => {
    for (const key of Object.keys(req.headers)) {
      if (key.toLowerCase().startsWith("x-polyth-link-") || key.toLowerCase().startsWith("x-polyth-internal-")) {
        delete req.headers[key];
      }
    }
  };
  if (ingress.kind === "polyth-link") {
    for (const name of UNTRUSTED_INGRESS_HEADERS) delete req.headers[name];
    delete req.headers.cookie;
    delete req.headers.authorization;
    stripInternal();
    return;
  }
  if (ingress.kind !== "public-http") return;
  for (const name of UNTRUSTED_INGRESS_HEADERS) {
    if (name === "cookie" || name === "authorization") continue;
    delete req.headers[name];
  }
  stripInternal();
};

export const TUNNEL_INTERNAL_TOKEN_HEADER = "x-polyth-internal-token";
export const TUNNEL_INTERNAL_CONNECTION_HEADER = "x-polyth-internal-connection";

export interface TunnelIngressBinding {
  secret: string;
  lookup(connectionId: string): Extract<RequestIngress, { kind: "polyth-link" }> | null;
}

/** Dedicated unix/loopback ingress. The public listener never accepts these tokens. */
export function createTunnelIngressServer(handler: HttpHandler, binding: TunnelIngressBinding): Server {
  return createServer((req, res) => {
    const secret = headerValue(req, TUNNEL_INTERNAL_TOKEN_HEADER);
    const connectionId = headerValue(req, TUNNEL_INTERNAL_CONNECTION_HEADER);
    if (!secret || secret !== binding.secret || !connectionId) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden", message: "not allowed" }));
      return;
    }
    const ingress = binding.lookup(connectionId);
    if (!ingress) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden", message: "not allowed" }));
      return;
    }
    void handler(req, res, ingress);
  });
}

export function createHttpHandler(deps: HttpDeps): HttpHandler {
  const { sessions, projects } = deps;

  // Aggregate across live runtimes (per-project pools may differ).
  const aggregate = <T>(fetch: (rt: AgentRuntime) => Promise<T[]>): Promise<T[]> =>
    aggregateRuntimes({ projects, runtimes: deps.runtimes }, fetch)
      .then((result) => result.items);
  const models = () => deps.catalog?.models() ?? aggregate<ModelDescriptor>((runtime) => runtime.models());

  return async (req, res, ingress) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const json = (target: ServerResponse, code: number, body: unknown): void => {
      writeJson(req, target, code, body);
    };
    try {
      stripUntrustedHeaders(req, ingress);
      const reqLike: AuthRequestLike = {
        headers: { cookie: req.headers.cookie, "user-agent": Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"][0] : req.headers["user-agent"] },
        socket: { remoteAddress: req.socket?.remoteAddress },
      };
      const resolution = deps.auth?.resolve(reqLike, ingress) ?? {
        principal: { kind: "local-user", trustedLoopback: true } as const,
        authenticated: true,
      };
      const principal = resolution.principal;

      if (deps.auth && path.startsWith("/api/") && !AUTH_PUBLIC.has(path)) {
        const denial = deps.auth.gate(reqLike, ingress);
        if (denial) return json(res, denial.status, denial.body);
      }

      if (principal.kind === "paired-device") {
        if (path.startsWith("/internal/") || path === "/metrics" || path.startsWith("/debug")) {
          throw new AuthorizationError("forbidden", "not allowed");
        }
        if (!path.startsWith("/api/")) {
          throw new AuthorizationError("forbidden", "not allowed");
        }
        const policies: OwnedRemotePolicy[] = [
          { owner: "core", policy: CORE_REMOTE_ACCESS },
          ...(deps.remotePolicies?.() ?? []),
        ];
        assertPairedHttpAllowed(principal, method, path, policies);
      }

      const requireCapability = (capability: string) => requirePrincipalCapability(principal, capability);

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
        // F14: listing no longer silently adopts every backend session — the
        // sidebar's "Import sessions…" sheet browses and adopts selectively
        // via /api/control/backend-sessions.
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
      if (m && method === "DELETE") {
        if (!sessions.delete) throw Object.assign(new Error("session deletion unavailable"), { code: "unsupported" });
        await sessions.delete(m[1]!);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (m && method === "GET") {
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
        // Keyset paging: limit returns the NEWEST events in the window,
        // beforeSeq pages older history backward without offset scans.
        const beforeSeqRaw = url.searchParams.get("beforeSeq");
        const limitRaw = url.searchParams.get("limit");
        const prefetchRaw = url.searchParams.get("prefetch");
        const beforeSeq = beforeSeqRaw === null ? undefined : Number(beforeSeqRaw);
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        const page = (Number.isSafeInteger(beforeSeq) && beforeSeq! > 0)
          || (Number.isSafeInteger(limit) && limit! > 0)
          || prefetchRaw === "0" || prefetchRaw === "1"
          ? {
              ...(Number.isSafeInteger(beforeSeq) && beforeSeq! > 0 ? { beforeSeq: beforeSeq! } : {}),
              ...(Number.isSafeInteger(limit) && limit! > 0 ? { limit: limit! } : {}),
              ...(prefetchRaw === "0" || prefetchRaw === "1" ? { prefetch: prefetchRaw === "1" } : {}),
            }
          : undefined;
        return json(res, 200, await sessions.events(m[1]!, afterSeq, page));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
      if (m && method === "POST") {
        const b = await readBody(req);
        const delivery = b.delivery;
        return json(res, 200, await sessions.send(m[1]!, {
          text: String(b.text ?? ""),
          ...(b.autoTitle === true ? { autoTitle: true } : {}),
          // sanitized + existence-checked inside the session service (F2)
          ...(Array.isArray(b.attachments) ? { attachments: b.attachments as never } : {}),
          ...(b.model ? { model: b.model as { providerID: string; modelID: string } } : {}),
          ...(b.agent ? { agent: String(b.agent) } : {}),
          ...(delivery === "steer" || delivery === "queue" || delivery === "interrupt" || delivery === "normal"
            ? { delivery } : {}),
          ...(b.dismissPending === true ? { dismissPending: true } : {}),
          // string selects a profile, explicit null clears the stored one,
          // absent field inherits it — never conflated (UX-COMPOSER-DISC)
          ...(b.agentProfileId !== undefined
            ? { agentProfileId: b.agentProfileId === null ? null : String(b.agentProfileId) }
            : {}),
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
      if (m && method === "PATCH") {
        const b = await readBody(req);
        return json(res, 200, await sessions.queueEdit?.(m[1]!, m[2]!, String(b.text ?? "")));
      }
      if (m && method === "DELETE") {
        await sessions.queueRemove?.(m[1]!, m[2]!);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/(abort|archive|restore)$/);
      if (m && method === "POST") {
        await (m[2] === "abort" ? sessions.abort(m[1]!) : m[2] === "archive" ? sessions.archive(m[1]!) : sessions.restore(m[1]!));
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/resume\/(cancel|now)$/);
      if (m && method === "POST") {
        if (m[2] === "cancel") {
          await sessions.cancelResume?.(m[1]!);
          return json(res, 200, { ok: true });
        }
        if (!sessions.resumeNow) {
          throw Object.assign(new Error("rate-limit resume unavailable"), { code: "unsupported" });
        }
        const b = await readBody(req);
        const model = b.model && typeof b.model === "object" && !Array.isArray(b.model)
          ? (b.model as { providerID: string; modelID: string })
          : undefined;
        return json(res, 200, await sessions.resumeNow(m[1]!, model));
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
      m = path.match(/^\/api\/sessions\/([^/]+)\/secrets\/([^/]+)$/);
      if (m && method === "POST") {
        if (!sessions.replySecret) throw Object.assign(new Error("Secure Safe unavailable"), { code: "unsupported" });
        const b = await readBody(req);
        if (b.action === "save") {
          if (typeof b.value !== "string" || !b.value.trim()) {
            throw Object.assign(new Error("value is required"), { code: "invalid-input" });
          }
          await sessions.replySecret(m[1]!, m[2]!, { action: "save", value: b.value });
        } else if (b.action === "dismiss") {
          await sessions.replySecret(m[1]!, m[2]!, { action: "dismiss" });
        } else {
          throw Object.assign(new Error("action must be save or dismiss"), { code: "invalid-input" });
        }
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
      // Provider/model visibility routes must win over the plain aggregate below.
      if (deps.visibility) {
        const vis = deps.visibility;
        if (path === "/api/models" && method === "GET") {
          const allModels = await models();
          // ?all=1 → unfiltered catalog (settings); default → enabled + connected.
          if (url.searchParams.get("all") === "1") return json(res, 200, allModels);
          return json(res, 200, vis.filter(allModels));
        }
        if (path === "/api/providers" && method === "GET") {
          return json(res, 200, vis.catalog(await models()));
        }
        m = path.match(/^\/api\/providers\/([^/]+)\/enabled$/);
        if (m && method === "POST") {
          const b = await readBody(req);
          const state = await vis.setProviderEnabled(decodeURIComponent(m[1]!), b.enabled !== false);
          return json(res, 200, { ok: true, ...state });
        }
        if (path === "/api/models/enabled" && method === "POST") {
          const b = await readBody(req);
          const state = await vis.setModelEnabled(String(b.key ?? ""), b.enabled !== false);
          return json(res, 200, { ok: true, ...state });
        }
      }

      m = path.match(/^\/api\/(models|agents)$/);
      if (m && method === "GET") {
        const out = m[1] === "models"
          ? await models()
          : deps.catalog ? await deps.catalog.agents() : await aggregate<unknown>((runtime) => runtime.agents());
        return json(res, 200, out);
      }

      if (deps.routes?.length) {
        let bodyCache: Record<string, unknown> | undefined;
        const rc: RouteRequest = {
          req, res, url, path, method, ingress, principal, requireCapability,
          body: async () => (bodyCache ??= await readBody(req)),
          json: (code, body) => json(res, code, body),
        };
        for (const route of deps.routes) if (await route(rc)) return;
      }

      if (path.startsWith("/api/")) return json(res, 404, { error: "not-found", path });

      if (path.startsWith("/packages/")) {
        const asset = path.match(/^\/packages\/([a-z0-9][a-z0-9-]*)\/(.+)$/);
        if (!asset) { res.writeHead(404); res.end(); return; }
        let relativeAsset: string;
        try {
          relativeAsset = decodeURIComponent(asset[2]!);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        const packageRoot = resolve(
          deps.packagesDir ?? resolve(import.meta.dirname, "../.."),
          asset[1]!,
          "dist",
          "web",
        );
        const filePath = resolve(packageRoot, relativeAsset);
        if (
          relativeAsset.includes("\0")
          || relativeAsset.includes("\\")
          || !inside(packageRoot, filePath)
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        await sendStaticFile(req, res, filePath);
        return;
      }

      // static web bundle
      let filePath = normalize(join(deps.webDist, path === "/" ? "index.html" : path));
      if (!filePath.startsWith(normalize(deps.webDist))) { res.writeHead(403); res.end(); return; }
      if (!existsSync(filePath)) {
        // SPA fallback is for navigations only. A missing asset-like path
        // (anything with a file extension) must fail honestly: serving
        // index.html as e.g. a JS module response breaks refresh replay on
        // nested routes with an unhelpful MIME error (EXT-SEAMS-V3).
        if (extname(path) !== "") { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
        filePath = join(deps.webDist, "index.html");
      }
      await sendStaticFile(req, res, filePath);
    } catch (err) {
      const e = err as Error & { code?: string; cause?: unknown; field?: unknown; status?: number };
      if (e instanceof AuthorizationError || e.code === "unauthorized" || e.code === "forbidden") {
        return json(res, e.status === 401 || e.code === "unauthorized" ? 401 : 403, {
          error: e.code ?? "forbidden",
          message: e.code === "unauthorized" ? "authentication required" : "not allowed",
        });
      }
      // A dead OpenCode transport is transient: the runtime pool respawns on
      // the next call, so give clients a retryable status and useful message.
      if (/fetch failed|terminated|ECONNREFUSED/i.test(`${e.message ?? ""} ${String(e.cause ?? "")}`)) {
        return json(res, 503, { error: "unavailable", message: "OpenCode is reconnecting. Try again in a moment." });
      }
      const status =
        e.code === "not-found" ? 404
        : e.code === "invalid-json" || e.code === "invalid-path" || e.code === "invalid-input" ? 400
        // history-mismatch keeps its own code in the body so the client can
        // explain a failed exact-history branch, but shares 409 semantics.
        : e.code === "conflict" || e.code === "history-mismatch" || RECOVERY_CONFLICT_CODES.has(e.code ?? "") ? 409
        : e.code === "payload-too-large" ? 413
        // Dependency failures (unreachable SSH host, missing remote runtime,
        // dead backend) are honest 503s with their actionable message — a
        // masked 500 would hide "install opencode on <host>" from the user.
        : e.code === "unavailable" ? 503
        : e.code === "unsupported" ? 501
        : 500;
      const message =
        e.code === "invalid-path" ? "The requested path is invalid."
        : e.code === "invalid-json" ? e.message
        : status === 500 ? "An internal server error occurred."
        : e.message;
      json(res, status, {
        error: e.code ?? "internal",
        message,
        ...(e.code === "invalid-input" && typeof e.field === "string" ? { field: e.field } : {}),
      });
    }
  };
}

export function createPublicHttpServer(handler: HttpHandler, listenerId = "public"): Server {
  return createServer((req, res) => {
    const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    const ingress = publicHttpIngress(req, { listenerId, secure: encrypted });
    void handler(req, res, ingress);
  });
}

export function createHttpServer(deps: HttpDeps): Server {
  return createPublicHttpServer(createHttpHandler(deps), deps.listenerId ?? "public");
}
