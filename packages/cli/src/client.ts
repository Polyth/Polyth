// One request path for every target: HTTP over the control socket (Unix
// socket / Windows named pipe) or over the network. Errors carry the server's
// stable code so commands can map them to exit codes and hints.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Target } from "./target.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Client-side deadline. Long-polls pass their own (wait + margin). */
  timeoutMs?: number;
  /** Space override for this call (`X-Polyth-Space`). */
  space?: string;
}

export class PolythError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (hint) this.hint = hint;
  }
}

export const CLI_USER_AGENT = "polyth-cli/0.1";

export interface Client {
  readonly target: Target;
  request<T = unknown>(method: Method, path: string, opts?: RequestOptions): Promise<T>;
  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
}

const withQuery = (path: string, query: RequestOptions["query"]): string => {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value));
  const text = params.toString();
  return text ? `${path}${path.includes("?") ? "&" : "?"}${text}` : path;
};

function errorFrom(status: number, body: unknown, target: Target): PolythError {
  const row = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const code = typeof row.code === "string" ? row.code : typeof row.error === "string" ? row.error : `http-${status}`;
  const message = typeof row.message === "string" && row.message
    ? row.message
    : typeof body === "string" && body.trim() ? body.trim().slice(0, 400) : `request failed (${status})`;
  let hint: string | undefined;
  if (status === 401) {
    hint = target.kind === "http"
      ? (target.token ? "The token is invalid, expired or revoked. Run `polyth login` again." : "Sign in with `polyth login`, or ask the owner to enable the no-token CLI mode.")
      : undefined;
  } else if (status === 403 && target.kind === "http" && target.token) {
    hint = "This token does not include that permission.";
  }
  return new PolythError(status, code, message, hint);
}

function viaSocket(target: Extract<Target, { kind: "socket" }>, method: Method, path: string, opts: RequestOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest({
      socketPath: target.socketPath,
      path,
      method,
      headers: {
        "user-agent": CLI_USER_AGENT,
        accept: "application/json",
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...(opts.space ? { "x-polyth-space": opts.space } : {}),
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let value: unknown = text;
        try { value = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        const status = response.statusCode ?? 500;
        if (status >= 400) reject(errorFrom(status, value, target));
        else resolve(value);
      });
      response.on("error", reject);
    });
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })));
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.name === "AbortError") return reject(error);
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        reject(new PolythError(0, "unreachable", `Polyth is not running at ${target.socketPath}`,
          target.name === "desktop" ? "Start Polyth Desktop." : "Start the server (npm start / npm run watch)."));
      } else if (error.code === "EACCES") {
        reject(new PolythError(0, "forbidden", `No permission to open ${target.socketPath}`, "Run as the user that owns the Polyth data directory."));
      } else reject(error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export interface RawResponse { status: number; text: string }

/**
 * Plain node:http(s) request. Deliberately not `fetch`: undici adds the
 * browser provenance header `sec-fetch-mode`, and the server treats any
 * browser-looking request as "not a command-line client".
 */
export function rawRequest(url: string, opts: {
  method: Method; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<RawResponse> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(target, {
      method: opts.method,
      headers: {
        "user-agent": CLI_USER_AGENT,
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(opts.body) } : {}),
        ...opts.headers,
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new PolythError(status, "redirect", `${target.origin} answered with a redirect to ${response.headers.location ?? "?"}; use that address`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })));
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.name === "AbortError" || opts.signal?.aborted) return reject(error);
      reject(new PolythError(0, "unreachable", `Cannot reach ${target.origin}${error.code ? ` (${error.code})` : ""}`));
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const parseBody = (text: string): unknown => {
  try { return text ? JSON.parse(text) : null; } catch { return text; }
};

async function viaHttp(target: Extract<Target, { kind: "http" }>, method: Method, path: string, opts: RequestOptions): Promise<unknown> {
  const space = opts.space ?? target.space;
  const response = await rawRequest(`${target.url}${path}`, {
    method,
    headers: {
      // A token is the whole credential; without one, ask for the
      // owner-enabled no-token mode (the server decides).
      ...(target.token ? { authorization: `Bearer ${target.token}` } : { "x-polyth-cli": "1" }),
      ...(space ? { "x-polyth-space": space } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const value = parseBody(response.text);
  if (response.status >= 400) throw errorFrom(response.status, value, target);
  return value;
}

export function createClient(target: Target): Client {
  const request = async <T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> => {
    const full = withQuery(path, opts.query);
    const value = target.kind === "socket"
      ? await viaSocket(target, method, full, { timeoutMs: 60_000, ...opts })
      : await viaHttp(target, method, full, { timeoutMs: 60_000, ...opts });
    return value as T;
  };
  return {
    target,
    request,
    get: (path, opts) => request("GET", path, opts),
    post: (path, body, opts) => request("POST", path, { ...opts, body: body ?? {} }),
  };
}

/** Process exit status for an error, stable for scripts. */
export function exitCodeFor(error: unknown): number {
  if ((error as { code?: string })?.code === "usage") return 2;
  if (error instanceof PolythError) {
    if (error.status === 401 || error.status === 403 || error.code === "forbidden") return 3;
    if (error.status === 404) return 4;
    if (error.code === "unreachable" || error.status === 503) return 5;
    if (error.status === 409 || error.status === 428) return 6;
    return 1;
  }
  if ((error as { code?: string })?.code === "timeout") return 7;
  return 1;
}
