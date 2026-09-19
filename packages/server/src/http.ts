// HTTP gateway composition seam. The large protocol/router implementation lives
// in httpCore.ts; security authorities that must run before route dispatch are
// composed here so they cannot accidentally fall through to legacy routes.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { RequestIngress } from "@polyth/contracts";
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
  const core = createCoreHttpHandler(coreDeps);
  if (!identityHttp) return core;

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
      const resolution = security.auth.resolve({
        headers: {
          cookie: req.headers.cookie,
          "user-agent": Array.isArray(req.headers["user-agent"])
            ? req.headers["user-agent"][0]
            : req.headers["user-agent"],
        },
        socket: { remoteAddress: req.socket?.remoteAddress },
      }, ingress);
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

    if (!path?.startsWith("/api/auth/")) return core(req, res, ingress);

    if (deps.admission && !deps.admission.enter()) {
      if (!res.headersSent && !res.writableEnded) {
        writeJson(res, 503, { error: "unavailable", message: "server shutting down" });
      }
      return;
    }
    try {
      if (ingress.kind !== "public-http") {
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
