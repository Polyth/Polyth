// HTTP gateway composition seam. The large protocol/router implementation lives
// in httpCore.ts; security authorities that must run before route dispatch are
// composed here so they cannot accidentally fall through to legacy routes.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { principalHasFullAccess, type RequestIngress } from "@polyth/contracts";
import { UNTRUSTED_INGRESS_HEADERS } from "./auth.ts";
import { canonicalSecurity } from "./runtimeSecurity.ts";
import {
  createHttpHandler as createCoreHttpHandler,
  createPublicHttpServer,
  type HttpDeps as CoreHttpDeps,
  type HttpHandler,
} from "./httpCore.ts";

export * from "./httpCore.ts";

/** Narrow adapter seam for the canonical account authority. Keeping this
 * structural prevents the HTTP gateway from depending on identity internals. */
export interface IdentityHttpHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** The auth status to embed in the HTML shell (see httpCore `shellStatus`). */
  shellStatus?(req: IncomingMessage, res: ServerResponse): Record<string, unknown> | null;
  /** Read-only account views (`GET /api/auth/accounts`, `/api/auth/me`) for
   *  an account this gateway authenticated: a full-access paired device. */
  handlePairedRead?(req: IncomingMessage, res: ServerResponse, userId: string): boolean;
}

export interface HttpDeps extends CoreHttpDeps {
  /** Once present, this adapter exclusively owns /api/auth/* and is reachable
   * only through the browser/public HTTP ingress. */
  identityHttp?: IdentityHttpHandler;
}

const writeJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Mirror the public-ingress sanitization performed by the core before handing
 * a request to the canonical identity adapter. Cookie/Authorization remain
 * browser credentials; transport-internal identity headers never do. */
const sanitizePublicIdentityHeaders = (req: IncomingMessage): void => {
  for (const name of UNTRUSTED_INGRESS_HEADERS) {
    if (name === "cookie" || name === "authorization") continue;
    delete req.headers[name];
  }
  for (const key of Object.keys(req.headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-polyth-link-") || lower.startsWith("x-polyth-internal-")) {
      delete req.headers[key];
    }
  }
};

const authRequestOf = (req: IncomingMessage) => ({
  headers: {
    cookie: req.headers.cookie,
    "user-agent": Array.isArray(req.headers["user-agent"])
      ? req.headers["user-agent"][0]
      : req.headers["user-agent"],
  },
  socket: { remoteAddress: req.socket?.remoteAddress },
});

const requestPath = (req: IncomingMessage): string | null => {
  try { return new URL(req.url ?? "/", "http://x").pathname; }
  catch { return null; }
};

const instanceGlobalVisibilityMutation = (path: string | null, method: string | undefined): boolean => {
  if (method !== "POST" || !path) return false;
  if (path === "/api/models/enabled") return true;
  return /^\/api\/providers\/[^/]+\/(?:enabled|add|remove)$/.test(path);
};

export function createHttpHandler(deps: HttpDeps): HttpHandler {
  const security = canonicalSecurity();
  const boundIdentity = security?.http;
  const identityHttp = deps.identityHttp ?? boundIdentity;
  const { identityHttp: _explicitIdentityHttp, ...coreDeps } = deps;
  if (!identityHttp) return createCoreHttpHandler(coreDeps);
  const core = createCoreHttpHandler({
    ...coreDeps,
    ...(identityHttp.shellStatus ? { shellStatus: identityHttp.shellStatus.bind(identityHttp) } : {}),
  });
  /** The account of a Link device its owner granted full access; undefined
   *  for every other caller. Resolved per request, so a revoked or downgraded
   *  device (or a guarded account) loses it on the next call. */
  const pairedFullAccessUser = (req: IncomingMessage, ingress: RequestIngress): string | undefined => {
    const auth = deps.auth;
    if (ingress.kind !== "polyth-link" || !auth?.userIdForPrincipal) return undefined;
    const { principal, authenticated } = auth.resolve(authRequestOf(req), ingress);
    return authenticated && principalHasFullAccess(principal) ? auth.userIdForPrincipal(principal) : undefined;
  };

  return async (req, res, ingress: RequestIngress) => {
    const path = requestPath(req);
    // Desktop/native readiness probes must not need a browser credential. The
    // response contains no tenant data and cannot mutate authority.
    if (path === "/api/health" && req.method === "GET") {
      writeJson(res, 200, { ok: true, version: deps.version, capabilities: deps.capabilities() });
      return;
    }

    // Provider/model visibility is stored in one host-global OpenCode config.
    // The large core router owns these historical routes, so enforce the
    // canonical installation authority here before they can reach it. Core
    // still performs its normal auth, Space and remote-capability checks.
    if (security && instanceGlobalVisibilityMutation(path, req.method)) {
      const resolution = security.auth.resolve(authRequestOf(req), ingress);
      if (!resolution.authenticated) {
        writeJson(res, 401, { error: "unauthorized", message: "authentication required" });
        return;
      }
      const userId = security.auth.userIdForPrincipal(resolution.principal);
      const owner = userId && security.control.get(
        `SELECT 1 FROM instance_roles r JOIN principals p ON p.id=r.user_id
          WHERE r.user_id=? AND r.role='owner' AND p.status='active'`,
        userId,
      );
      if (!owner) {
        writeJson(res, 403, { error: "forbidden", message: "not allowed" });
        return;
      }
    }

    // A paired device still needs its own grant-bound status, answered by the
    // core route behind the remote policy. Browser identity stays public-only.
    const pairedStatus = ingress.kind === "polyth-link" && path === "/api/auth/status" && req.method === "GET";
    if (!path?.startsWith("/api/auth/") || pairedStatus) return core(req, res, ingress);

    if (deps.admission && !deps.admission.enter()) {
      if (!res.headersSent && !res.writableEnded) {
        writeJson(res, 503, { error: "unavailable", message: "server shutting down" });
      }
      return;
    }
    try {
      if (ingress.kind !== "public-http") {
        // A device its owner trusts like this computer may read its own
        // account (Settings → Users). Changes still need browser identity.
        const userId = pairedFullAccessUser(req, ingress);
        if (userId && identityHttp.handlePairedRead?.(req, res, userId)) return;
        writeJson(res, 403, { error: "forbidden", message: "not allowed" });
        return;
      }
      sanitizePublicIdentityHeaders(req);
      if (await identityHttp.handle(req, res)) return;
      writeJson(res, 404, { error: "not-found", path });
    } finally {
      deps.admission?.leave();
    }
  };
}

/** Keep callers that use the convenience server constructor on the same
 * canonical wrapper rather than the raw core handler. */
export function createHttpServer(deps: HttpDeps): Server {
  return createPublicHttpServer(createHttpHandler(deps), deps.listenerId ?? "public");
}
