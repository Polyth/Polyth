import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { TRUSTED_SETUP_CLAIM } from "@polyth/identity/http";
import type { CanonicalSecurity } from "./canonicalSecurity.ts";

export const DESKTOP_SETUP_CLAIM_COOKIE = "polyth_desktop_setup_claim";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface SetupServerOptions {
  security: CanonicalSecurity;
  webDist: string;
  version: string;
  /** Operator-issued native claim; never exposed to renderer JavaScript. */
  desktopSetupClaimToken?: string;
}

export interface SetupServerHandle {
  server: Server;
  /** Resolves only after setup completed and its HTTP response finished. */
  completed: Promise<void>;
  shutdown(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
};

const cookieValue = (req: IncomingMessage, name: string): string | null => {
  const cookie = req.headers.cookie;
  if (!cookie || cookie.length > 16_384) return null;
  const matches = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
};

const desktopClaimMatches = (req: IncomingMessage, expected: string): boolean => {
  const actual = cookieValue(req, DESKTOP_SETUP_CLAIM_COOKIE);
  return !!actual
    && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
};

const inside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

async function staticFile(root: string, pathname: string): Promise<{ data: Buffer; type: string } | null> {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes("\0")) return null;
  const candidate = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  const chosen = inside(root, candidate) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : resolve(root, "index.html");
  if (!inside(root, chosen) || !existsSync(chosen) || !statSync(chosen).isFile()) return null;
  return { data: await readFile(chosen), type: MIME[extname(chosen)] ?? "application/octet-stream" };
}

/**
 * Minimal authority-only server used before installation setup completes.
 * It deliberately exposes no project/session/package runtime and owns no
 * application stores. A completed setup requires a process restart before the
 * full composition root is admitted.
 */
export function createSetupServer(options: SetupServerOptions): SetupServerHandle {
  const root = resolve(options.webDist);
  let resolveCompleted!: () => void;
  let completionSignaled = false;
  const completed = new Promise<void>((resolveCompletion) => { resolveCompleted = resolveCompletion; });
  if (options.desktopSetupClaimToken && !/^[a-f0-9]{64}$/.test(options.desktopSetupClaimToken)) {
    throw new Error("Invalid native desktop setup claim");
  }
  // The trusted, shipped shell contains the React import map and small inline
  // bootstrap scripts. 'self' alone blocks them, leaving a fresh install blank.
  // Hash only this build-owned document, never arbitrary requested HTML. Keep
  // every other inline script/event handler blocked; do not use unsafe-inline.
  const shellPath = resolve(root, "index.html");
  const shell = existsSync(shellPath) ? readFileSync(shellPath, "utf8") : "";
  const scriptHashes = new Set<string>();
  for (const [, body] of shell.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!body.trim()) continue;
    // HTML parsing normalizes CRLF and bare CR before CSP checks script text.
    const hash = createHash("sha256").update(body.replace(/\r\n?/g, "\n")).digest("base64");
    scriptHashes.add(`'sha256-${hash}'`);
  }
  const scriptSources = ["'self'", ...scriptHashes].join(" ");
  const contentSecurityPolicy = `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src ${scriptSources}; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
  const server = createServer((req, res) => {
    void (async () => {
      let url: URL;
      try { url = new URL(req.url ?? "/", "http://setup.invalid"); }
      catch { json(res, 400, { error: "invalid-path" }); return; }
      const path = url.pathname;

      if (req.method === "GET" && path === "/api/health") {
        json(res, 200, {
          ok: true,
          version: options.version,
          setup: true,
          state: options.security.control.installation().state,
          capabilities: [],
        });
        return;
      }
      if (path.startsWith("/api/auth/")) {
        const nativeClaim = options.desktopSetupClaimToken;
        if (nativeClaim && desktopClaimMatches(req, nativeClaim)) {
          (req as unknown as Record<symbol, unknown>)[TRUSTED_SETUP_CLAIM] = nativeClaim;
        }
        res.setHeader("X-Polyth-Bootstrap", "setup");
        if (await options.security.http.handle(req, res)) return;
        json(res, 404, { error: "not-found" });
        return;
      }
      if (path.startsWith("/api/")) {
        json(res, 503, { error: "setup-required" });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { error: "method-not-allowed" });
        return;
      }
      const asset = await staticFile(root, path);
      if (!asset) { json(res, 404, { error: "not-found" }); return; }
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": path === "/" || path.endsWith(".html") ? "no-store" : "public, max-age=3600",
        "x-content-type-options": "nosniff",
        "content-security-policy": contentSecurityPolicy,
      });
      res.end(req.method === "HEAD" ? undefined : asset.data);
    })().catch(() => {
      if (!res.headersSent && !res.writableEnded) json(res, 500, { error: "internal-error" });
      else res.destroy();
    });
  });

  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
  });

  let closed = false;
  return {
    server,
    completed,
    async shutdown() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => {
        if (!server.listening) { resolveClose(); return; }
        const timer = setTimeout(resolveClose, 2_000);
        server.close(() => { clearTimeout(timer); resolveClose(); });
      });
    },
  };
}
