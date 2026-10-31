// REST per docs/PLAN.md §5 + static web bundle serving. node:http only.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as zlibConstants, gzip, gzipSync } from "node:zlib";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import {
  canonicalizeRemotePath,
  isGrantBoundPrincipal,
  principalAccountGrants,
  type AgentRuntime,
  type AuthResolution,
  type HarnessSelection,
  type MemoryNarrowing,
  type JsonObject,
  type ModelDescriptor,
  type ModelRef,
  type RequestIngress,
  type ResumeTurnOptions,
  type RouteHandler,
  type RouteRequest
} from "@polyth/contracts";
import type { ProjectService } from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";
import { parseTurnCommand } from "./turnCommand.ts";
import {
  parseSpaceCookie,
  SPACE_HEADER,
  type SpaceGateway
} from "./spaces.ts";
import type { SpaceServices } from "./spaceScope.ts";
import { aggregateRuntimes } from "./runtimeAggregate.ts";
import type { ModelVisibilityService } from "./modelVisibility.ts";
import type { RuntimeCatalog } from "./runtimeCatalog.ts";
import type { HttpServerContext } from "@polyth/plugins";
import { PairedSocketRegistry } from "@polyth/plugins";
import {
  AuthorizationError,
  authRequestLike,
  isLoopbackAddress,
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
import { TERMINATED_TLS } from "@polyth/identity/http";
import { guardedCatalog, guardrailsForUser } from "./accountGuardrails.ts";
import { harnessAllowedFor, limitedCatalog, limitsForUser } from "./accountLimits.ts";
import { privateHarnessCatalog, type HarnessAccess } from "./accountPermissions.ts";
import { createProxyTrust, type ProxyTrust } from "./trustedProxy.ts";
import { logHttp500 } from "./httpLog.ts";
import { httpErrorDiagnostics } from "./errorDiagnostics.ts";
import { streamHistoryResponse } from "./historyResponse.ts";
import { withProjectIconRef } from "./projectIconRefs.ts";
import { createSessionOnce, sessionCreateOperationStatus, sessionIdForCreateOperation } from "./sessionCreateIdempotency.ts";
import { clampWaitMs, type SessionEventWaiters } from "./sessionEventWaiters.ts";
import type { HttpAdmission } from "./httpAdmission.ts";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".map": "application/json", ".woff2": "font/woff2", ".mp3": "audio/mpeg",
};

const HASHED_ASSET = /-[A-Z0-9]{8,}(?:\.[^./]+){1,2}$/;
const FRESH_SHELL_ASSET = /(?:^|[\\/])(?:index\.html|main\.js|main\.css|build-id\.json|packages-manifest\.json)$/;
const FRESH_MARKER = /(?:^|[\\/])(?:index\.html|build-id\.json|packages-manifest\.json)$/;

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
const CLIENT_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failedSessionIdOf = (error: unknown): string | undefined => {
  const sessionId = typeof (error as { sessionId?: unknown }).sessionId === "string"
    ? (error as { sessionId: string }).sessionId
    : undefined;
  return sessionId !== undefined && CLIENT_OPERATION_ID.test(sessionId) ? sessionId : undefined;
};

const clientOperationId = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CLIENT_OPERATION_ID.test(value)) {
    throw Object.assign(new Error("clientOperationId must be a UUID"), { code: "invalid-input" });
  }
  return value.toLowerCase();
};

/** The renderer's UUID is not a global authority. Fold the authenticated
 * account (from the resolved SpaceContext, never the body) into the durable
 * record key so an identical token from another account cannot alias it. */
export const accountScopedClientOperationId = (operationId: string, userId: string): string => {
  const digest = createHash("sha256").update(userId).update("\0").update(operationId).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const harnessSelectionInput = (value: unknown): HarnessSelection | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("invalid harness selection"), { code: "invalid-input" });
  }
  const raw = value as { mode?: unknown; harnessId?: unknown };
  if (raw.mode === "auto" && raw.harnessId === undefined) return { mode: "auto" };
  if (raw.mode === "pinned"
    && typeof raw.harnessId === "string"
    && /^[a-z][a-z0-9-]*$/.test(raw.harnessId)) {
    return { mode: "pinned", harnessId: raw.harnessId };
  }
  throw Object.assign(new Error("invalid harness selection"), { code: "invalid-input" });
};

const repositoryIdsInput = (value: unknown, field = "repositoryIds"): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 128 || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw Object.assign(new Error(`${field} must be a non-empty array of up to 128 ids`), { code: "invalid-input" });
  }
  return value.map((id) => (id as string).trim());
};

const memoryNarrowingInput = (value: unknown): MemoryNarrowing | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("memory must be an object"), { code: "invalid-input" });
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "read" && key !== "remember") {
      throw Object.assign(new Error("memory only accepts read and remember"), { code: "invalid-input" });
    }
  }
  for (const key of ["read", "remember"] as const) {
    if (raw[key] !== undefined && raw[key] !== "inherit" && raw[key] !== "off") {
      throw Object.assign(new Error(`memory.${key} must be inherit or off`), { code: "invalid-input" });
    }
  }
  const out: MemoryNarrowing = {};
  if (raw.read !== undefined) out.read = raw.read as MemoryNarrowing["read"];
  if (raw.remember !== undefined) out.remember = raw.remember as MemoryNarrowing["remember"];
  return Object.keys(out).length ? out : undefined;
};

/** Keep recovery's public JSON input small and serializable. The session
 * service validates the selected model against the chosen runtime catalog. */
const modelRefInput = (value: unknown): ModelRef | undefined => {
  // Earlier clients serialized an absent picker choice as null; preserve that
  // harmless no-selection payload while rejecting malformed model objects.
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("invalid model selection"), { code: "invalid-input" });
  }
  const raw = value as { providerID?: unknown; modelID?: unknown; variant?: unknown };
  if (typeof raw.providerID !== "string" || raw.providerID.length === 0
    || typeof raw.modelID !== "string" || raw.modelID.length === 0
    || (raw.variant !== undefined && typeof raw.variant !== "string")) {
    throw Object.assign(new Error("invalid model selection"), { code: "invalid-input" });
  }
  return {
    providerID: raw.providerID,
    modelID: raw.modelID,
    ...(typeof raw.variant === "string" ? { variant: raw.variant } : {}),
  };
};

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

/** The published web generation (build.ts writes build-id.json last), re-read
 * only when the marker file changes. */
const buildIdCache = new Map<string, { mtimeMs: number; id: string | null }>();
const currentWebBuild = (webDist: string): string | null => {
  const marker = join(webDist, "build-id.json");
  try {
    const { mtimeMs } = statSync(marker);
    const hit = buildIdCache.get(marker);
    if (hit?.mtimeMs === mtimeMs) return hit.id;
    const build = (JSON.parse(readFileSync(marker, "utf8")) as { build?: unknown }).build;
    const id = typeof build === "string" && build ? build : null;
    buildIdCache.set(marker, { mtimeMs, id });
    return id;
  } catch {
    return null;
  }
};

const sendStaticFile = async (
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  webBuild: string | null = null,
): Promise<void> => {
  const stat = statSync(filePath);
  // index.html and the generation markers are never cached. Every other
  // unhashed shell/package URL carries `?b=<build>`; once that names the
  // published generation the bytes behind the URL can no longer change, so
  // the browser keeps them instead of re-downloading ~1 MB on every boot.
  // A stale `b` (a page from before a rebuild) keeps the old fresh policy.
  const requestedBuild = new URL(req.url ?? "/", "http://x").searchParams.get("b");
  const cacheControl = HASHED_ASSET.test(filePath)
    || (webBuild !== null && requestedBuild === webBuild && !FRESH_MARKER.test(filePath))
    ? "public, max-age=31536000, immutable"
    : FRESH_SHELL_ASSET.test(filePath)
      ? "no-store"
      : "no-cache";
  const contentType = MIME[extname(filePath)] ?? "application/octet-stream";
  const headers: Record<string, string> = { "content-type": contentType, "cache-control": cacheControl };
  if (cacheControl === "no-cache") {
    // Revalidation is one tiny round trip instead of the whole file again.
    const etag = `W/"${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}"`;
    headers.etag = etag;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }
  const data = await readFile(filePath);
  // In-process gzip: no reverse proxy is assumed.
  if (
    data.length > 1024
    && COMPRESSIBLE.test(contentType)
    && (req.headers["accept-encoding"] ?? "").includes("gzip")
  ) {
    const mtimeMs = stat.mtimeMs;
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

/** The HTML shell with this request's auth status inlined as inert JSON.
 * Per-request (it names the caller's account), so never stored by any cache. */
const sendShellWithStatus = async (
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  status: Record<string, unknown>,
): Promise<void> => {
  const html = await readFile(filePath, "utf8");
  // `<` escaped: the JSON can never close the script element.
  const tag = `<script id="polyth-auth-status" type="application/json">${JSON.stringify(status).replace(/</g, "\\u003c")}</script>`;
  const at = html.indexOf("</head>");
  const body = Buffer.from(at < 0 ? html : `${html.slice(0, at)}${tag}\n  ${html.slice(at)}`, "utf8");
  const headers: Record<string, string> = {
    "content-type": "text/html",
    "cache-control": "no-store, private",
    vary: "cookie, accept-encoding",
  };
  if ((req.headers["accept-encoding"] ?? "").includes("gzip")) {
    headers["content-encoding"] = "gzip";
    res.writeHead(200, headers);
    res.end(gzipSync(body));
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
};

// Buffered-body ceiling: headroom over the 20MB MAX_RAW_BYTES attachment cap
// (@polyth/files) so a maximal upload survives its JSON envelope while a
// runaway client can no longer grow the heap without bound.
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function contentLengthOf(req: IncomingMessage): number | undefined {
  const raw = req.headers["content-length"];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw : [raw];
  if (value.length !== 1 || !/^\d+$/.test(value[0]!)) {
    throw Object.assign(new Error("invalid Content-Length"), { code: "invalid-input" });
  }
  return Number(value[0]);
}

const readBody = async (req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> => {
  if (!Number.isInteger(limit) || limit < 0) {
    throw Object.assign(new Error("invalid body limit"), { code: "invalid-input" });
  }
  const declared = contentLengthOf(req);
  if (declared !== undefined && declared > limit) {
    throw Object.assign(
      new Error(`request body too large (max ${limit} bytes)`),
      { code: "payload-too-large" },
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) { overflow = true; chunks.length = 0; }
    if (!overflow) chunks.push(chunk as Buffer);
  }
  if (overflow) {
    throw Object.assign(
      new Error(`request body too large (max ${limit} bytes)`),
      { code: "payload-too-large" },
    );
  }
  if (declared !== undefined && size !== declared) {
    throw Object.assign(new Error("Content-Length does not match the request body"), { code: "invalid-input" });
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
  /** Canonical auth status for this browser request, embedded in the served
   *  HTML shell so boot skips the `/api/auth/status` round trip. May set the
   *  cookies that status relies on. Null = serve the plain shell. */
  shellStatus?: (req: IncomingMessage, res: ServerResponse) => Record<string, unknown> | null;
  /** Who may use each restricted harness account; its models stay hidden
   *  from everyone else. */
  harnessAccess?: HarnessAccess;
  /** The ONLY way this gateway reaches a session or project service. There is
   *  deliberately no unscoped `sessions`/`projects` dependency here: a handler
   *  cannot use what the composition root never handed it, so "forgot to scope
   *  this route" is not an available bug. */
  spaces: SpaceGateway;
  runtimes: RuntimePool;
  /** Long-poll wake-ups for HTTP-only clients (the CLI). Optional: without it
   *  `waitMs` is accepted and simply returns immediately. */
  eventWaiters?: SessionEventWaiters;
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
  /** Access control gate: null = proceed, otherwise the denial to answer with. Applied
   *  to every /api path except the two the lock screen itself needs. */
  auth?: HttpAuth;
  /** Extra remote-access policies (package-owned). Core policy is always included. */
  remotePolicies?: () => readonly OwnedRemotePolicy[];
  /** Public listener id recorded on RequestIngress. */
  listenerId?: string;
  /** Optional request drain/fence. When set, new requests stop at shutdown
   *  and late handlers cannot keep using live services after dispose. */
  admission?: HttpAdmission;
  /** Private notification routing metadata, written after a durable session. */
  notificationRecipients?: {
    created(sessionId: string, account: { userId: string; spaceId: string }): Promise<void>;
    forked(parentSessionId: string, sessionId: string, account: { userId: string; spaceId: string }): Promise<void>;
  };
}

// Public even when a password is set: the SPA lock screen must be able to
// learn that auth is required and then mint a session.
const AUTH_PUBLIC = new Set(["/api/auth/status", "/api/auth/login"]);
/** What the control socket still answers outside `local-trusted`. */
const CONTROL_SOCKET_RESTRICTED_ALLOW = new Set(["/api/health", "/api/agent"]);

function fallbackResolution(ingress: RequestIngress, req: AuthRequestLike): AuthResolution {
  if (ingress.kind === "public-http" && ingress.loopback && isLoopbackAddress(req.socket.remoteAddress)) {
    return { principal: { kind: "local-user", trustedLoopback: true }, authenticated: true };
  }
  return { principal: { kind: "anonymous" }, authenticated: false };
}

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

function internalTokenEquals(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface TunnelIngressBinding {
  secret: string;
  lookup(connectionId: string): Extract<RequestIngress, { kind: "polyth-link" }> | null;
}

/** Dedicated unix/loopback ingress. The public listener never accepts these tokens. */
export function createTunnelIngressServer(handler: HttpHandler, binding: TunnelIngressBinding): Server {
  return createServer((req, res) => {
    const secret = headerValue(req, TUNNEL_INTERNAL_TOKEN_HEADER);
    const connectionId = headerValue(req, TUNNEL_INTERNAL_CONNECTION_HEADER);
    if (!internalTokenEquals(secret, binding.secret) || !connectionId) {
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

export interface TunnelIngressHandle {
  secret: string;
  socketPath: string;
  server: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createTunnelIngress(opts: {
  handler: HttpHandler;
  secret: string;
  socketPath: string;
  lookup(connectionId: string): Extract<RequestIngress, { kind: "polyth-link" }> | null;
  resolve: HttpServerContext["resolve"];
  attachChannels(ctx: HttpServerContext): void;
  pairedSockets?: PairedSocketRegistry;
}): TunnelIngressHandle {
  const pairedSockets = opts.pairedSockets ?? new PairedSocketRegistry();
  const server = createTunnelIngressServer(opts.handler, {
    secret: opts.secret,
    lookup: opts.lookup,
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const identity: HttpServerContext["identity"] = (request) => {
    const secret = headerValue(request, TUNNEL_INTERNAL_TOKEN_HEADER);
    const connectionId = headerValue(request, TUNNEL_INTERNAL_CONNECTION_HEADER);
    if (!internalTokenEquals(secret, opts.secret) || !connectionId) {
      return { principal: { kind: "anonymous" }, authenticated: false };
    }
    const ingress = opts.lookup(connectionId);
    if (!ingress) return { principal: { kind: "anonymous" }, authenticated: false };
    return opts.resolve(request, ingress);
  };
  const authorize: HttpServerContext["authorize"] = (request) => identity(request).authenticated;
  const refreshPrincipal: HttpServerContext["refreshPrincipal"] = (principal) => {
    if (principal.kind !== "paired-device") return principal;
    const ingress = opts.lookup(principal.connectionId);
    if (!ingress) return null;
    const resolution = opts.resolve(
      { headers: {}, socket: { remoteAddress: undefined } } as never,
      ingress,
    );
    return resolution.principal.kind === "paired-device" ? resolution.principal : null;
  };
  let closed = false;
  return {
    secret: opts.secret,
    socketPath: opts.socketPath,
    server,
    async listen() {
      mkdirSync(dirname(opts.socketPath), { recursive: true });
      try { unlinkSync(opts.socketPath); } catch { /* first boot or stale socket */ }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(opts.socketPath, () => {
          server.off("error", onError);
          resolve();
        });
      });
      opts.attachChannels({
        server,
        listenerId: "polyth-link",
        dispatch: opts.handler,
        resolve: opts.resolve,
        authorize,
        identity,
        refreshPrincipal,
        pairedSockets,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      try { unlinkSync(opts.socketPath); } catch { /* already removed */ }
    },
  };
}

export function createHttpHandler(deps: HttpDeps): HttpHandler {
  return async (req, res, ingress) => {
    if (deps.admission && !deps.admission.enter()) {
      if (!res.headersSent && !res.writableEnded) {
        writeJson(req, res, 503, { error: "unavailable", message: "server shutting down" });
      }
      return;
    }
    try {
      await dispatchHttp(deps, req, res, ingress);
    } finally {
      deps.admission?.leave();
    }
  };
}

async function dispatchHttp(
  deps: HttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  ingress: RequestIngress,
): Promise<void> {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    const aggregate = <T>(
      projects: ProjectService,
      fetch: (rt: AgentRuntime) => Promise<T[]>,
    ): Promise<T[]> =>
      aggregateRuntimes({ projects, runtimes: deps.runtimes }, fetch)
        .then((result) => result.items);
    const models = (projects: ProjectService) =>
      deps.catalog?.models() ?? aggregate<ModelDescriptor>(projects, (runtime) => runtime.models());
    const json = (target: ServerResponse, code: number, body: unknown): void => {
      if (code >= 400 && body && typeof body === "object") {
        const row = body as Record<string, unknown>;
        body = { ...httpErrorDiagnostics({ ...row, code: row.code ?? row.error }, req.method ?? "GET", requestId), ...row };
      }
      writeJson(req, target, code, body);
    };
    try {
      const rawUrl = req.url ?? "/";
      const rawPath = rawUrl.split("?")[0] || "/";
      let url: URL;
      try {
        url = new URL(rawUrl, "http://x");
      } catch {
        throw Object.assign(new Error("The requested path is invalid."), { code: "invalid-path" });
      }
      const path = url.pathname;
      const method = req.method ?? "GET";
      // Read before stripping: the resolver must see that forwarding headers
      // arrived (an unconfigured proxy) even though handlers never do.
      const reqLike: AuthRequestLike = ingress.kind === "public-http"
        ? authRequestLike(req)
        : {
          headers: { cookie: req.headers.cookie, "user-agent": Array.isArray(req.headers["user-agent"]) ? req.headers["user-agent"][0] : req.headers["user-agent"] },
          socket: { remoteAddress: req.socket?.remoteAddress },
        };
      stripUntrustedHeaders(req, ingress);
      const resolution = deps.auth?.resolve(reqLike, ingress) ?? fallbackResolution(ingress, reqLike);
      const principal = resolution.principal;

      // The filesystem-protected control socket speaks for the operator only
      // where there is exactly one trusted operator. Elsewhere every agent
      // process runs as the server's OS user and could open it, so it may
      // only report health/discovery; people use a CLI token instead.
      if (ingress.kind === "internal" && deps.spaces.deployment !== "local-trusted" && path.startsWith("/api/")
        && !(method === "GET" && CONTROL_SOCKET_RESTRICTED_ALLOW.has(path))) {
        return json(res, 403, {
          error: "forbidden",
          message: "The control socket is limited to health and discovery in this deployment; sign in with `polyth login`.",
        });
      }

      if (deps.auth && path.startsWith("/api/") && !AUTH_PUBLIC.has(path)) {
        const denial = deps.auth.gate(reqLike, ingress);
        if (denial) return json(res, denial.status, denial.body);
      }

      // --- tenancy: identity -> requested Space -> membership -> context.
      //
      // Resolved BEFORE any handler runs and before any resource is loaded, so
      // no code path can fetch a row first and check ownership afterwards. The
      // explicit header is a request, not an authority: a Space the caller does
      // not belong to answers 404 exactly like a Space that does not exist.
      const explicitSpace = headerValue(req, SPACE_HEADER) ?? null;
      const rememberedSpace = parseSpaceCookie(req.headers.cookie, deps.spaces.cookieName);
      let scoped: SpaceServices | null = null;
      const space = (): SpaceServices => {
        deps.admission?.assertLive();
        if (!scoped) {
          if (principal.kind === "access-token" && principal.spaceId && explicitSpace && explicitSpace !== principal.spaceId) {
            // A Space-pinned token cannot even learn that another Space exists.
            throw Object.assign(new Error("space not found"), { code: "not-found" });
          }
          const ctx = principal.kind === "internal-service"
            ? deps.spaces.resolveInternal(explicitSpace)
            : principal.kind === "access-token"
              ? deps.spaces.resolve(principal, { explicit: principal.spaceId ?? explicitSpace })
              : deps.spaces.resolve(principal, {
                explicit: explicitSpace,
                remembered: rememberedSpace,
              });
          scoped = deps.spaces.services(ctx);
        }
        return scoped;
      };
      /** Models on harnesses this account may use in this Space: its limits,
       *  then other users' private accounts and shared accounts not open to
       *  it removed. */
      const accountCatalog = async (): Promise<ModelDescriptor[]> => privateHarnessCatalog(
        limitedCatalog(
          await models(space().projects),
          limitsForUser(space().ctx.userId),
          harnessAllowedFor(space().ctx, deps.harnessAccess),
        ),
        space().ctx,
        deps.harnessAccess,
      );
      // Only /api needs a tenant; static assets and the lock screen do not.
      // Resolving eagerly here (rather than inside each branch) means a route
      // added later cannot forget to.
      if (path.startsWith("/api/") && !AUTH_PUBLIC.has(path)) space();

      let bodyLimit = MAX_BODY_BYTES;
      let bodyCache: Record<string, unknown> | undefined;
      const loadBody = async () => (bodyCache ??= await readBody(req, bodyLimit));

      // A guarded account gets the paired-device default-deny table for every
      // API/control path; the SPA shell and static assets stay reachable.
      const guardedApi = principalAccountGrants(principal) !== undefined
        && (path.startsWith("/api/") || path.startsWith("/internal/") || path === "/metrics" || path.startsWith("/debug"));
      if (isGrantBoundPrincipal(principal) || guardedApi) {
        if (!canonicalizeRemotePath(rawPath) || path !== rawPath) {
          throw Object.assign(new Error("The requested path is invalid."), { code: "invalid-path" });
        }
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
        const match = assertPairedHttpAllowed(principal, method, path, policies, contentLengthOf(req));
        bodyLimit = match.rule.maxBodyBytes ?? MAX_BODY_BYTES;
        if (match.rule.mutation) {
          await loadBody();
        }
      }

      const requireCapability = (capability: string) => requirePrincipalCapability(principal, capability);
      const recordNotificationRecipient = async (work: (() => Promise<void>) | undefined): Promise<void> => {
        try { await work?.(); } catch { console.warn("[polyth] notification recipient registration failed"); }
      };

      if (path === "/api/cli/whoami" && method === "GET") {
        // What the `polyth` CLI is speaking as. No secrets: token ids and
        // grants only, never token text.
        const ctx = space().ctx;
        return json(res, 200, {
          kind: principal.kind,
          userId: ctx.userId.startsWith("system:") ? null : ctx.userId,
          spaceId: ctx.spaceId,
          role: ctx.role,
          deployment: deps.spaces.deployment,
          version: deps.version,
          ...(principal.kind === "access-token"
            ? { tokenId: principal.tokenId, tokenKind: principal.tokenKind, grants: [...principal.grants], pinnedSpace: principal.spaceId ?? null }
            : {}),
          ...(principal.kind === "local-user" && principal.sessionId === "trusted-cli" ? { trustedCli: true } : {}),
        });
      }
      if (path === "/api/health" && method === "GET") {
        return json(res, 200, { ok: true, version: deps.version, capabilities: deps.capabilities() });
      }
      if (path === "/api/projects" && method === "GET") {
        const list = await space().projects.list();
        return json(res, 200, url.searchParams.get("iconRefs") === "1" ? list.map(withProjectIconRef) : list);
      }
      if (path === "/api/projects" && method === "POST") {
        const b = await loadBody();
        return json(res, 200, await space().projects.add(String(b.path), b.name ? String(b.name) : undefined));
      }
      if (path === "/api/projects/create" && method === "POST") {
        const b = await loadBody();
        return json(res, 200, await space().projects.create(String(b.path), b.name ? String(b.name) : undefined));
      }
      let m = path.match(/^\/api\/projects\/([^/]+)$/);
      if (m && method === "DELETE") { await space().projects.remove(m[1]!); return json(res, 200, { ok: true }); }

      if (path === "/api/sessions/summaries" && method === "GET") {
        const summaries = space().sessions.summaries;
        if (!summaries) throw Object.assign(new Error("session summaries unavailable"), { code: "unsupported" });
        const cursorId = url.searchParams.get("cursorId");
        const cursorTime = Number(url.searchParams.get("cursorTime"));
        if (cursorId && (!Number.isSafeInteger(cursorTime) || cursorTime < 0)) throw Object.assign(new Error("invalid summary cursor"), { code: "invalid-input" });
        for (const field of ["limit", "revision", "fromTime", "toTime"] as const) {
          if (url.searchParams.has(field) && (!Number.isSafeInteger(Number(url.searchParams.get(field))) || Number(url.searchParams.get(field)) < 0)) {
            throw Object.assign(new Error("invalid summary boundary"), { code: "invalid-input" });
          }
        }
        // `waitMs` + `updatedAfter`: hold the read until something newer than
        // the caller's high-water mark exists (CLI `polyth events --follow`).
        const waitMs = clampWaitMs(url.searchParams.get("waitMs"));
        const updatedAfterRaw = url.searchParams.get("updatedAfter");
        const updatedAfter = updatedAfterRaw === null ? undefined : Number(updatedAfterRaw);
        if (updatedAfter !== undefined && (!Number.isSafeInteger(updatedAfter) || updatedAfter < 0)) {
          throw Object.assign(new Error("invalid summary boundary"), { code: "invalid-input" });
        }
        const readSummaries = () => summaries({
          projectId: url.searchParams.get("projectId") ?? undefined,
          worktreePath: url.searchParams.get("worktreePath") ?? undefined,
          ...(url.searchParams.has("revision") ? { revision: Number(url.searchParams.get("revision")) } : {}),
          query: url.searchParams.get("query") ?? undefined,
          limit: Number(url.searchParams.get("limit") ?? 50),
          ...(cursorId ? { cursor: { id: cursorId, updatedAt: cursorTime } } : {}),
          ...(url.searchParams.has("archived") ? { archived: url.searchParams.get("archived") === "true" } : {}),
          attentionOnly: url.searchParams.get("attentionOnly") === "true",
          ...(url.searchParams.get("pinned") === "true" ? { pinned: true } : {}),
          ...(url.searchParams.has("fromTime") ? { fromTime: Number(url.searchParams.get("fromTime")) } : {}),
          ...(url.searchParams.has("toTime") ? { toTime: Number(url.searchParams.get("toTime")) } : {}),
        });
        const changed = (current: Awaited<ReturnType<typeof readSummaries>>) =>
          updatedAfter === undefined || current.sessions.some((session) => session.updatedAt > updatedAfter);
        if (waitMs === 0 || updatedAfter === undefined || !deps.eventWaiters) return json(res, 200, await readSummaries());
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        const deadline = Date.now() + waitMs;
        try {
          // Projection wakes are Space-agnostic hints: register before each
          // read, then re-read until this caller's own view changed.
          for (;;) {
            const woke = deps.eventWaiters.waitForProjection(deadline - Date.now(), abort.signal);
            const page = await readSummaries();
            if (changed(page) || abort.signal.aborted || Date.now() >= deadline) return json(res, 200, page);
            await woke;
            if (abort.signal.aborted || Date.now() >= deadline) return json(res, 200, await readSummaries());
          }
        } finally {
          abort.abort();
          res.off("close", onClose);
        }
      }
      if (path === "/api/sessions" && method === "GET") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        // Listing no longer silently adopts every backend session. The
        // @polyth/session-import package browses harness sources and publishes
        // selected conversations as canonical snapshots; the legacy
        // /api/agent/backend-sessions adoption remains available programmatically.
        return json(res, 200, await space().sessions.list(projectId));
      }
      if (path === "/api/sessions" && method === "POST") {
        const b = await loadBody();
        const harness = harnessSelectionInput(b.harness);
        const repositoryIds = repositoryIdsInput(b.repositoryIds);
        const requestedOperationId = clientOperationId(b.clientOperationId);
        const projectId = String(b.projectId);
        const create = async (id?: string) => {
          const ref = await space().sessions.create({
            projectId,
            ...(repositoryIds ? { repositoryIds } : {}),
            ...(harness ? { harness } : {}),
            ...(b.title ? { title: String(b.title) } : {}),
            ...(b.purpose !== undefined ? { purpose: b.purpose as string } : {}),
            ...(b.model ? { model: b.model as { providerID: string; modelID: string } } : {}),
            ...(b.agent ? { agent: String(b.agent) } : {}),
            ...(b.worktreePath ? { worktreePath: String(b.worktreePath) } : {}),
            // Derived from the account+Space-scoped key, never client-chosen.
            ...(id ? { id } : {}),
          });
          await recordNotificationRecipient(deps.notificationRecipients
            ? () => deps.notificationRecipients!.created(ref.id, space().ctx)
            : undefined);
          return ref;
        };
        if (!requestedOperationId) return json(res, 200, await create());
        const { ref } = await createSessionOnce(
          space().sessions,
          sessionIdForCreateOperation(requestedOperationId, space().ctx),
          projectId,
          create,
        );
        return json(res, 200, ref);
      }
      m = path.match(/^\/api\/sessions\/create-operations\/([^/]+)$/);
      if (m && method === "GET") {
        const requestedOperationId = clientOperationId(decodeURIComponent(m[1]!));
        if (!requestedOperationId) throw Object.assign(new Error("clientOperationId is required"), { code: "invalid-input" });
        return json(res, 200, await sessionCreateOperationStatus(
          space().sessions,
          sessionIdForCreateOperation(requestedOperationId, space().ctx),
        ));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (m && method === "GET") return json(res, 200, await space().sessions.snapshot(m[1]!));
      if (m && method === "DELETE") {
        const remove = space().sessions.delete;
        if (!remove) throw Object.assign(new Error("session deletion unavailable"), { code: "unsupported" });
        const expectedLastEventSeqRaw = url.searchParams.get("expectedLastEventSeq");
        let expectedLastEventSeq: number | undefined;
        if (expectedLastEventSeqRaw !== null) {
          const parsed = Number(expectedLastEventSeqRaw);
          if (!Number.isSafeInteger(parsed) || parsed < 0) {
            throw Object.assign(new Error("expectedLastEventSeq must be a non-negative integer"), { code: "invalid-input" });
          }
          expectedLastEventSeq = parsed;
        }
        await remove(m[1]!, expectedLastEventSeq === undefined ? undefined : { expectedLastEventSeq });
        return json(res, 200, { ok: true });
      }
      const workspaceMatch = path.match(/^\/api\/sessions\/([^/]+)\/workspace$/);
      if (workspaceMatch && method === "PUT") {
        const updateWorkspace = space().sessions.updateWorkspace;
        if (!updateWorkspace) throw Object.assign(new Error("session workspace updates unavailable"), { code: "unsupported" });
        const b = await loadBody();
        if (b.workspace !== undefined || b.paths !== undefined) {
          throw Object.assign(new Error("workspace updates accept repository ids, not paths"), { code: "invalid-input" });
        }
        const repositoryIds = repositoryIdsInput(b.repositoryIds);
        const relocateRepositoryIds = repositoryIdsInput(b.relocateRepositoryIds, "relocateRepositoryIds");
        const expectedRevision = b.expectedRevision;
        if (expectedRevision !== undefined && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
          throw Object.assign(new Error("expectedRevision must be a non-negative integer"), { code: "invalid-input" });
        }
        return json(res, 200, await updateWorkspace(workspaceMatch[1]!, {
          ...(repositoryIds ? { repositoryIds } : {}),
          ...(relocateRepositoryIds ? { relocateRepositoryIds } : {}),
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        }));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/activate$/);
      if (m && method === "POST") {
        const activate = space().sessions.activate;
        if (!activate) throw Object.assign(new Error("session lifecycle unavailable"), { code: "unsupported" });
        const intent = (await loadBody()).intent;
        if (intent !== undefined && intent !== "open" && intent !== "warm") {
          throw Object.assign(new Error("invalid activation intent"), { code: "invalid-input" });
        }
        await activate(m[1]!, intent ? { intent } : undefined);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/events\/forward$/);
      if (m && method === "GET") {
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0);
        const rawHighWater = url.searchParams.get("highWater");
        const highWater = rawHighWater === null ? undefined : Number(rawHighWater);
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || (highWater !== undefined && (!Number.isSafeInteger(highWater) || highWater < afterSeq))) {
          throw Object.assign(new Error("invalid replay cursor"), { code: "invalid-input" });
        }
        const replay = space().sessions.replayPage;
        if (!replay) throw Object.assign(new Error("forward replay unavailable"), { code: "unsupported" });
        const waitMs = highWater === undefined && deps.eventWaiters ? clampWaitMs(url.searchParams.get("waitMs")) : 0;
        if (waitMs === 0) return json(res, 200, await replay(m[1]!, afterSeq, highWater));
        // Long-poll: register the wake-up BEFORE reading, so an event appended
        // between the read and the park still wakes this request at once.
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        try {
          const woke = deps.eventWaiters!.waitForEvent(m[1]!, waitMs, abort.signal);
          let page = await replay(m[1]!, afterSeq);
          if (page.events.length === 0) {
            await woke;
            if (!abort.signal.aborted) page = await replay(m[1]!, afterSeq);
          }
          return json(res, 200, page);
        } finally {
          abort.abort();
          res.off("close", onClose);
        }
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
        if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) || (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0))) {
          throw Object.assign(new Error("invalid history page"), { code: "invalid-input" });
        }
        const page = (Number.isSafeInteger(beforeSeq) && beforeSeq! > 0)
          || (Number.isSafeInteger(limit) && limit! > 0)
          || prefetchRaw === "0" || prefetchRaw === "1"
          ? {
              ...(Number.isSafeInteger(beforeSeq) && beforeSeq! > 0 ? { beforeSeq: beforeSeq! } : {}),
              ...(Number.isSafeInteger(limit) && limit! > 0 ? { limit: limit! } : {}),
              ...(prefetchRaw === "0" || prefetchRaw === "1" ? { prefetch: prefetchRaw === "1" } : {}),
            }
          : undefined;
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw Object.assign(new Error("invalid history cursor"), { code: "invalid-input" });
        const sessionId = m[1]!;
        if (!page?.limit && space().sessions.replayPage) {
          const requestedSpace = space().ctx.spaceId;
          await streamHistoryResponse(res, (cursor, highWater) => {
            const current = deps.auth?.resolve(reqLike, ingress) ?? resolution;
            if (deps.auth?.gate(reqLike, ingress)) throw new AuthorizationError("forbidden", "not allowed");
            if (isGrantBoundPrincipal(current.principal) || principalAccountGrants(current.principal)) assertPairedHttpAllowed(current.principal, method, path, [{ owner: "core", policy: CORE_REMOTE_ACCESS }], contentLengthOf(req));
            const ctx = current.principal.kind === "internal-service" ? deps.spaces.resolveInternal(requestedSpace)
              : deps.spaces.resolve(current.principal, { explicit: requestedSpace, remembered: null });
            return deps.spaces.services(ctx).sessions.replayPage!(sessionId, cursor, highWater ?? (beforeSeq === undefined ? undefined : Math.max(cursor, beforeSeq - 1)));
          }, afterSeq);
          return;
        }
        return json(res, 200, await space().sessions.events(sessionId, afterSeq, page));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/memory-policy$/);
      if (m && method === "GET") {
        const memoryPolicyGet = space().sessions.memoryPolicyGet;
        if (!memoryPolicyGet) throw Object.assign(new Error("memory policy unavailable"), { code: "not-supported" });
        return json(res, 200, await memoryPolicyGet(m[1]!));
      }
      if (m && method === "PUT") {
        const memoryPolicySet = space().sessions.memoryPolicySet;
        if (!memoryPolicySet) throw Object.assign(new Error("memory policy unavailable"), { code: "not-supported" });
        const body = await loadBody();
        const rawSetting = body.memory !== undefined ? body.memory : body.setting;
        const setting = memoryNarrowingInput(rawSetting) ?? {};
        return json(res, 200, await memoryPolicySet(m[1]!, setting));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/client-mutations\/([^/]+)$/);
      if (m && method === "GET") {
        const status = space().sessions.clientMutationStatus;
        if (!status) throw Object.assign(new Error("client mutation status unavailable"), { code: "unsupported" });
        const requestedOperationId = clientOperationId(decodeURIComponent(m[2]!));
        if (!requestedOperationId) throw Object.assign(new Error("clientOperationId is required"), { code: "invalid-input" });
        return json(res, 200, await status(
          m[1]!,
          accountScopedClientOperationId(requestedOperationId, space().ctx.userId),
        ));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
      if (m && method === "POST") {
        const b = await loadBody();
        const delivery = b.delivery;
        const harness = harnessSelectionInput(b.harness);
        const memory = memoryNarrowingInput(b.memory);
        const validCommand = b.command !== undefined ? parseTurnCommand(b.command) : undefined;
        const requestedOperationId = clientOperationId(b.clientOperationId);
        const operationId = requestedOperationId
          ? accountScopedClientOperationId(requestedOperationId, space().ctx.userId)
          : undefined;
        return json(res, 200, await space().sessions.send(m[1]!, {
          text: String(b.text ?? ""),
          ...(operationId ? { clientOperationId: operationId } : {}),
          ...(validCommand ? { command: validCommand } : {}),
          ...(memory ? { memory } : {}),
          ...(b.autoTitle === true ? { autoTitle: true } : {}),
          ...(b.hiddenUserMessage === true ? { hiddenUserMessage: true } : {}),
          // sanitized + existence-checked inside the session service
          ...(Array.isArray(b.attachments) ? { attachments: b.attachments as never } : {}),
          ...(b.model ? { model: b.model as { providerID: string; modelID: string } } : {}),
          ...(b.agent ? { agent: String(b.agent) } : {}),
          ...(harness ? { harness } : {}),
          ...(delivery === "steer" || delivery === "queue" || delivery === "interrupt" || delivery === "normal"
            ? { delivery } : {}),
          ...(b.dismissPending === true ? { dismissPending: true } : {}),
          // string selects a profile, explicit null clears the stored one,
          // absent field inherits it — never conflated
          ...(b.agentProfileId !== undefined
            ? { agentProfileId: b.agentProfileId === null ? null : String(b.agentProfileId) }
            : {}),
        }));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/queue$/);
      if (m && method === "GET") return json(res, 200, await space().sessions.queueList?.(m[1]!) ?? []);
      m = path.match(/^\/api\/sessions\/([^/]+)\/queue\/order$/);
      if (m && method === "PATCH") {
        const b = await loadBody();
        const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
        return json(res, 200, await space().sessions.queueReorder?.(m[1]!, ids) ?? []);
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)$/);
      if (m && method === "PATCH") {
        const b = await loadBody();
        return json(res, 200, await space().sessions.queueEdit?.(m[1]!, m[2]!, String(b.text ?? "")));
      }
      if (m && method === "DELETE") {
        await space().sessions.queueRemove?.(m[1]!, m[2]!);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/(abort|archive|restore)$/);
      if (m && method === "POST") {
        if (m[2] === "abort") {
          const b = await loadBody();
          const source = typeof b.source === "string" && b.source.trim()
            ? b.source.trim().slice(0, 64)
            : "http";
          await space().sessions.abort(m[1]!, { source });
        } else {
          await (m[2] === "archive" ? space().sessions.archive(m[1]!) : space().sessions.restore(m[1]!));
        }
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/(pause|continue)$/);
      if (m && method === "POST") {
        const b = await loadBody();
        const source = typeof b.source === "string" && b.source.trim()
          ? b.source.trim().slice(0, 64)
          : "http";
        if (m[2] === "pause") {
          const pause = space().sessions.pause;
          if (!pause) throw Object.assign(new Error("session pause unavailable"), { code: "unsupported" });
          await pause(m[1]!, { source });
          return json(res, 200, { ok: true });
        }
        const continuePaused = space().sessions.continuePaused;
        if (!continuePaused) throw Object.assign(new Error("session pause unavailable"), { code: "unsupported" });
        return json(res, 200, await continuePaused(m[1]!, { source }));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/compact$/);
      if (m && method === "POST") {
        const compact = space().sessions.compact;
        if (!compact) throw Object.assign(new Error("session compaction unavailable"), { code: "unsupported" });
        await compact(m[1]!);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/resume\/(cancel|compact|now)$/);
      if (m && method === "POST") {
        if (m[2] === "cancel") {
          await space().sessions.cancelResume?.(m[1]!);
          return json(res, 200, { ok: true });
        }
        if (m[2] === "compact") {
          const setResumeCompact = space().sessions.setResumeCompact;
          if (!setResumeCompact) {
            throw Object.assign(new Error("rate-limit resume unavailable"), { code: "unsupported" });
          }
          const b = await loadBody();
          if (typeof b.compact !== "boolean") {
            throw Object.assign(new Error("compact must be a boolean"), { code: "invalid-input" });
          }
          await setResumeCompact(m[1]!, b.compact);
          return json(res, 200, { ok: true });
        }
        const resumeNow = space().sessions.resumeNow;
        if (!resumeNow) {
          throw Object.assign(new Error("rate-limit resume unavailable"), { code: "unsupported" });
        }
        const b = await loadBody();
        const model = modelRefInput(b.model);
        const harness = harnessSelectionInput(b.harness);
        const options: ResumeTurnOptions = {
          ...(model ? { model } : {}),
          ...(harness ? { harness } : {}),
          ...(typeof b.compact === "boolean" ? { compact: b.compact } : {}),
        };
        return json(res, 200, await resumeNow(m[1]!, options));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/fork$/);
      if (m && method === "POST") {
        const parentSessionId = m[1]!;
        const b = await loadBody();
        const forked = await space().sessions.fork(parentSessionId, b.atSeq === undefined ? undefined : Number(b.atSeq));
        await recordNotificationRecipient(deps.notificationRecipients
          ? () => deps.notificationRecipients!.forked(parentSessionId, forked.id, space().ctx)
          : undefined);
        return json(res, 200, forked);
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/rewind$/);
      if (m && method === "POST") {
        const rewind = space().sessions.rewind;
        if (!rewind) throw Object.assign(new Error("session rewind unavailable"), { code: "unsupported" });
        const b = await loadBody();
        if (b.atSeq === undefined) throw Object.assign(new Error("atSeq required"), { code: "invalid-input" });
        return json(res, 200, await rewind(m[1]!, Number(b.atSeq)));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/rewind\/clear$/);
      if (m && method === "POST") {
        const clearRewind = space().sessions.clearRewind;
        if (!clearRewind) throw Object.assign(new Error("session rewind unavailable"), { code: "unsupported" });
        return json(res, 200, await clearRewind(m[1]!));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/shell$/);
      if (m && method === "POST") {
        const runShell = space().sessions.runShell;
        if (!runShell) throw Object.assign(new Error("composer shell unavailable"), { code: "unsupported" });
        const b = await loadBody();
        if (typeof b.command !== "string") throw Object.assign(new Error("command required"), { code: "invalid-input" });
        return json(res, 200, await runShell(m[1]!, b.command));
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/permission\/([^/]+)\/delegate$/);
      if (m && method === "POST") {
        const delegatePermission = space().sessions.delegatePermission;
        if (!delegatePermission) throw Object.assign(new Error("permission delegation unavailable"), { code: "unsupported" });
        await delegatePermission(m[1]!, m[2]!);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/permission\/([^/]+)$/);
      if (m && method === "POST") {
        const b = await loadBody();
        const scope = b.scope === "session" || b.scope === "project" ? b.scope : undefined;
        await space().sessions.replyPermission(m[1]!, m[2]!, b.reply as "once" | "always" | "reject", scope);
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/secrets\/([^/]+)$/);
      if (m && method === "POST") {
        const replySecret = space().sessions.replySecret;
        if (!replySecret) throw Object.assign(new Error("Credential Vault unavailable"), { code: "unsupported" });
        const b = await loadBody();
        if (b.action === "save") {
          if (typeof b.value !== "string" || !b.value.trim()) {
            throw Object.assign(new Error("value is required"), { code: "invalid-input" });
          }
          if (b.partition !== undefined && b.partition !== "personal" && b.partition !== "space") {
            throw Object.assign(new Error("partition must be personal or space"), { code: "invalid-input" });
          }
          await replySecret(m[1]!, m[2]!, {
            action: "save",
            value: b.value,
            ...(b.partition !== undefined ? { partition: b.partition as "personal" | "space" } : {}),
          });
        } else if (b.action === "dismiss") {
          await replySecret(m[1]!, m[2]!, { action: "dismiss" });
        } else {
          throw Object.assign(new Error("action must be save or dismiss"), { code: "invalid-input" });
        }
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/question\/([^/]+)\/reject$/);
      if (m && method === "POST") {
        await space().sessions.replyQuestion(m[1]!, m[2]!, { __reject: true });
        return json(res, 200, { ok: true });
      }
      m = path.match(/^\/api\/sessions\/([^/]+)\/question\/([^/]+)$/);
      if (m && method === "POST") {
        const b = await loadBody();
        await space().sessions.replyQuestion(m[1]!, m[2]!, (b.answers ?? b) as JsonObject);
        return json(res, 200, { ok: true });
      }
      // Provider/model visibility routes must win over the plain aggregate below.
      if (deps.visibility) {
        const vis = deps.visibility;
        if (path === "/api/models" && method === "GET") {
          // Only models on the account's allowed harnesses (Settings → Users).
          const allModels = await accountCatalog();
          const guarded = guardrailsForUser(space().ctx.userId);
          // A guarded account sees exactly its owner-approved models.
          if (guarded) return json(res, 200, guardedCatalog(allModels, guarded));
          // ?all=1 → unfiltered catalog (settings); default → enabled + connected.
          // Visibility is the requesting account's own list, not a host-global one.
          if (url.searchParams.get("all") === "1") return json(res, 200, allModels);
          return json(res, 200, vis.filter(allModels, { userId: space().ctx.userId }));
        }
        if (path === "/api/providers" && method === "GET") {
          // ?refresh=1 busts the server-lifetime model cache — used while
          // actively waiting for a connect/OAuth flow to finish.
          if (url.searchParams.get("refresh") === "1") deps.catalog?.invalidateModels();
          await vis.seed();
          const guarded = guardrailsForUser(space().ctx.userId);
          const catalog = await accountCatalog();
          return json(res, 200, vis.catalog(
            guarded ? guardedCatalog(catalog, guarded) : catalog,
            space().ctx.userId,
          ));
        }
        m = path.match(/^\/api\/providers\/([^/]+)\/enabled$/);
        if (m && method === "POST") {
          const b = await loadBody();
          const state = await vis.setProviderEnabled(
            decodeURIComponent(m[1]!),
            b.enabled !== false,
            space().ctx.userId,
          );
          return json(res, 200, { ok: true, ...state });
        }
        m = path.match(/^\/api\/providers\/([^/]+)\/add$/);
        if (m && method === "POST") {
          const b = await loadBody();
          const state = await vis.addProvider(
            decodeURIComponent(m[1]!),
            typeof b.name === "string" && b.name ? b.name : undefined,
            undefined,
            undefined,
            space().ctx.userId,
          );
          return json(res, 200, { ok: true, ...state });
        }
        m = path.match(/^\/api\/providers\/([^/]+)\/remove$/);
        if (m && method === "POST") {
          const state = await vis.removeProvider(decodeURIComponent(m[1]!), space().ctx.userId);
          return json(res, 200, { ok: true, ...state });
        }
        if (path === "/api/models/enabled" && method === "POST") {
          const b = await loadBody();
          const state = await vis.setModelEnabled(
            String(b.key ?? ""),
            b.enabled !== false,
            space().ctx.userId,
          );
          return json(res, 200, { ok: true, ...state });
        }
      }

      m = path.match(/^\/api\/(models|agents)$/);
      if (m && method === "GET") {
        const guarded = m[1] === "models" ? guardrailsForUser(space().ctx.userId) : null;
        const catalog = m[1] === "models" ? await accountCatalog() : [];
        const out = m[1] === "models"
          ? guarded ? guardedCatalog(catalog, guarded) : catalog
          : privateHarnessCatalog(
            deps.catalog ? await deps.catalog.agents() : await aggregate<{ harnessId?: string }>(space().projects, (runtime) => runtime.agents()),
            space().ctx,
            deps.harnessAccess,
          );
        return json(res, 200, out);
      }

      if (deps.routes?.length) {
        const rc: RouteRequest = {
          req, res, url, path, method, ingress, principal,
          // A getter, not a value: contributed routes also see non-/api paths
          // (static assets, the SPA shell), where there is no authenticated
          // tenant to resolve. Reading `space` is what triggers resolution, so
          // a handler that declines the path never pays for it — and a handler
          // that does read it gets the same validated context as core routes.
          get space() { return space().ctx; },
          requireCapability,
          body: async () => loadBody(),
          json: (code, body) => json(res, code, body),
        };
        for (const route of deps.routes) {
          // Outside /api a contributed route is offered the SPA shell and
          // static assets, where an anonymous visitor has no tenant. A route
          // that reads `rc.space` there is simply not applicable — it must not
          // turn the lock screen into a 401 JSON body. Anything already
          // written, and every /api path, keeps the real failure.
          try {
            if (await route(rc)) return;
          } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            const denial = error instanceof AuthorizationError
              || code === "unauthorized" || code === "forbidden";
            if (!denial || path.startsWith("/api/") || res.headersSent) throw error;
          }
        }
      }

      // The native app serves its shell from the bundle inside the app and
      // proxies only /api and /ws to the host, so the host's package web
      // bundles and manifest are mirrored under /api for it (authenticated,
      // read-only; same files as the public /packages/ and manifest URLs).
      if (method === "GET" && path === "/api/package-assets/manifest") {
        await sendStaticFile(req, res, join(deps.webDist, "packages-manifest.json"));
        return;
      }
      const apiAsset = method === "GET" ? path.match(/^\/api\/package-assets\/(.+)$/) : null;
      if (path.startsWith("/api/") && !apiAsset) return json(res, 404, { error: "not-found", path });

      if (apiAsset || path.startsWith("/packages/")) {
        const asset = (apiAsset ? `/packages/${apiAsset[1]}` : path).match(/^\/packages\/([a-z0-9][a-z0-9-]*)\/(.+)$/);
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
        await sendStaticFile(req, res, filePath, currentWebBuild(deps.webDist));
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
      if (filePath === join(deps.webDist, "index.html") && method === "GET" && ingress.kind === "public-http" && deps.shellStatus) {
        const status = deps.shellStatus(req, res);
        if (status) { await sendShellWithStatus(req, res, filePath, status); return; }
      }
      await sendStaticFile(req, res, filePath, currentWebBuild(deps.webDist));
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const e = err as Error & { code?: string; cause?: unknown; field?: unknown; status?: number; details?: unknown; changes?: unknown };
      if (e instanceof AuthorizationError || e.code === "unauthorized" || e.code === "forbidden") {
        return json(res, e.status === 401 || e.code === "unauthorized" ? 401 : 403, {
          error: e.code ?? "forbidden",
          message: e.code === "unauthorized" ? "authentication required" : "not allowed",
        });
      }
      const status =
        e.code === "not-found" || e.code === "ENOENT" ? 404
        : e.code === "invalid-json" || e.code === "invalid-path" || e.code === "invalid-input" ? 400
        // A model or thinking level the runtime does not offer is the user's
        // selection to change, so its reason must reach them, not a masked 500.
        : e.code === "invalid-model" || e.code === "invalid-variant" ? 422
        // history-mismatch keeps its own code in the body so the client can
        // explain a failed exact-history branch, but shares 409 semantics.
        : e.code === "conflict" || e.code === "catalog-changed" || e.code === "draft-conflict" || e.code === "history-mismatch" || e.code === "worktree-dirty" || RECOVERY_CONFLICT_CODES.has(e.code ?? "") ? 409
        : e.code === "payload-too-large" ? 413
        // A failed git subprocess (rejected push, no upstream, auth prompt
        // disabled, diverged fetch) is the user's to fix, not a server bug.
        // Masking it as a 500 replaces "Updates were rejected…" with a useless
        // "internal server error" in the Source Control sync banner.
        : e.code === "git-failed" ? 422
        // Dependency failures (unreachable SSH host, missing remote runtime,
        // dead backend) are honest 503s with their actionable message — a
        // masked 500 would hide "install opencode on <host>" from the user.
        : e.code === "auth-rejected" ? 401
        // A harness/provider bridge that answered "no" is upstream news, not a
        // Polyth bug. Masking it as 500 replaces the actionable reason ("Polyth
        // agent-tools bridge failed to connect (Codex status:
        // authenticationRequired)") with "An internal server error occurred."
        // in the harness reconnect surface.
        : e.code === "native-failure" || e.code === "runtime-rejected" ? 502
        : e.code === "unavailable" || e.code === "unreachable"
          || e.code === "harness-transport" || e.code === "runtime-unresponsive"
          || e.code === "runtime-unavailable"
          // Backpressure, not a bug: a configuration replacement or a shutdown
          // is fencing new runtime work and the caller may retry. Surfacing
          // these as an opaque 500 hid "retry shortly" behind a server error.
          || e.code === "restart-deferred" || e.code === "shutting_down"
          || e.code === "discovery-unavailable"
          || e.code === "backend-not-ready"
          || e.code === "storage-unavailable"
          || e.code === "memory-required" ? 503
        : e.code === "invalid-response" ? 502
        : e.code === "unsupported" || e.code === "capability-unsupported" ? 501
        : typeof e.code === "string" && e.code.startsWith("AUTH_")
          ? (
            e.code === "AUTH_INPUT_INVALID" || e.code === "AUTH_CREDENTIAL_INVALID" || e.code === "AUTH_WELLKNOWN_UNSAFE" ? 400
            : e.code === "AUTH_DENIED" ? 403
            : e.code === "AUTH_RATE_LIMITED" ? 429
            : e.code === "AUTH_CAPABILITY_UNAVAILABLE" || e.code === "AUTH_METHOD_UNAVAILABLE" ? 501
            : e.code === "AUTH_PROVIDER_UNREACHABLE" || e.code === "AUTH_NETWORK_ERROR" ? 503
            : 422
          )
        : typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status
        : 500;
      const message =
        e.code === "invalid-path" ? "The requested path is invalid."
        : e.code === "invalid-json" ? e.message
        : e.code === "not-found" || e.code === "ENOENT" ? (e.message || "Not found.")
        : status === 500 ? "An internal server error occurred."
        : e.message;
      // The client only sees the generic message; the operator needs a
      // redacted cause — never raw URLs, query tokens, or secret-shaped text.
      if (status === 500) logHttp500(req.method ?? "GET", req.url, err);
      const failedSessionId = failedSessionIdOf(e);
      json(res, status, {
        ...httpErrorDiagnostics(e, req.method ?? "GET", requestId),
        error: e.code === "ENOENT" ? "not-found" : (e.code ?? "internal"),
        message,
        ...(failedSessionId ? { sessionId: failedSessionId } : {}),
        ...(e.code === "invalid-input" && typeof e.field === "string" ? { field: e.field } : {}),
        ...(typeof e.code === "string" && e.code.startsWith("AUTH_") && typeof e.field === "string" ? { field: e.field } : {}),
        ...(typeof e.code === "string" && e.code.startsWith("AUTH_") && typeof e.details === "string" ? { details: e.details } : {}),
        ...(e.code === "worktree-dirty" && typeof e.changes === "number" ? { changes: e.changes } : {}),
      });
    }
}

export function createPublicHttpServer(
  handler: HttpHandler,
  listenerId = "public",
  proxies: ProxyTrust = createProxyTrust(),
): Server {
  return createServer((req, res) => {
    const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    // Forwarded headers are stripped before any handler runs, so the one
    // trusted-proxy transport decision is made here, from the socket peer, and
    // carried as an explicit marker rather than a re-readable header.
    const proxied = !encrypted && proxies.secure(req);
    if (proxied) Object.defineProperty(req, TERMINATED_TLS, { value: true, enumerable: false });
    const ingress = publicHttpIngress(req, { listenerId, secure: encrypted || proxied, proxied });
    void handler(req, res, ingress);
  });
}

/** Filesystem-protected local ingress for the Polyth control MCP. It is not
 * exposed on the public listener and therefore never weakens UI auth. */
export function createInternalControlServer(handler: HttpHandler): Server {
  return createServer((req, res) => void handler(req, res, {
    kind: "internal",
    serviceId: "polyth-control",
  }));
}

export function createHttpServer(deps: HttpDeps): Server {
  return createPublicHttpServer(createHttpHandler(deps), deps.listenerId ?? "public");
}
