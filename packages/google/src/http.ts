// One HTTP seam for every Google REST call. It attaches the account's access
// token, refreshes it once on 401, retries only where a retry cannot repeat a
// side effect, bounds response size, and translates Google's error envelope
// into stable Polyth error codes. Tokens never appear in errors or logs.

export type GoogleErrorCode =
  | "not-configured"
  | "not-connected"
  | "account-ambiguous"
  | "authorization-required"
  | "authorization-revoked"
  | "insufficient-scope"
  | "invalid-credentials"
  | "rate-limited"
  | "network-error"
  | "not-found"
  | "permission-denied"
  | "conflict"
  | "invalid-request"
  | "too-large"
  | "cancelled"
  | "google-unavailable"
  | "mutation-outcome-unknown"
  | "invalid-state";

export class GoogleError extends Error {
  readonly code: GoogleErrorCode;
  readonly status?: number;
  /** Google's own reason string (for example `fileNotDownloadable`), when present. */
  readonly reason?: string;
  readonly retryAfterMs?: number;

  constructor(code: GoogleErrorCode, message: string, extra: { status?: number; reason?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "GoogleError";
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

export const googleError = (
  code: GoogleErrorCode,
  message: string,
  extra?: { status?: number; reason?: string; retryAfterMs?: number },
): never => {
  throw new GoogleError(code, message, extra);
};

/** HTTP status for a Polyth route that surfaces a Google error. */
export function googleErrorStatus(code: string | undefined): number {
  switch (code) {
    case "not-found": return 404;
    case "permission-denied": return 403;
    case "not-configured":
    case "not-connected":
    case "authorization-required":
    case "authorization-revoked":
    case "insufficient-scope":
    case "invalid-credentials":
    case "conflict":
    case "mutation-outcome-unknown":
    case "invalid-state": return 409;
    case "rate-limited": return 429;
    case "too-large": return 413;
    case "network-error":
    case "google-unavailable": return 502;
    default: return 400;
  }
}

export const GOOGLE_API_ORIGINS: ReadonlySet<string> = new Set([
  "https://gmail.googleapis.com",
  "https://www.googleapis.com",
]);

export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface GoogleRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Absolute URL on a Google API origin. */
  url: string;
  query?: Record<string, QueryValue>;
  /** JSON body (serialized with `application/json`). */
  json?: unknown;
  /** Raw body; requires `contentType`. */
  body?: Uint8Array | string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Response byte cap. Defaults to 16 MiB. */
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Set for non-GET calls that are safe to repeat (for example a read-only POST such as freeBusy). */
  idempotent?: boolean;
}

export interface GoogleResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface GoogleClient {
  /** JSON response (or undefined for an empty body). */
  json<T>(request: GoogleRequest): Promise<T>;
  /** Raw response bytes and the response headers. */
  raw(request: GoogleRequest): Promise<GoogleResponse>;
}

/** Supplies a current access token for one Google account. `refresh` forces a
 * new token after Google rejected the previous one. */
export interface GoogleTokenSource {
  accessToken(options?: { refresh?: boolean }): Promise<string>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GoogleClientOptions {
  tokens: GoogleTokenSource;
  fetch?: FetchLike;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Total attempts for retryable failures. */
  attempts?: number;
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 20_000;

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);
const QUOTA_REASONS = new Set(["dailyLimitExceeded", "quotaExceeded"]);
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new GoogleError("cancelled", "The Google request was cancelled.")); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new GoogleError("cancelled", "The Google request was cancelled.")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

export function buildUrl(base: string, query?: Record<string, QueryValue>): URL {
  const url = new URL(base);
  if (!GOOGLE_API_ORIGINS.has(url.origin) || url.username || url.password) {
    return googleError("invalid-request", "Google request URL is not on a Google API origin.");
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return googleError("too-large", `The Google response is larger than the ${Math.round(maxBytes / 1024 / 1024)} MiB limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return googleError("too-large", `The Google response is larger than the ${Math.round(maxBytes / 1024 / 1024)} MiB limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

interface GoogleErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
    details?: Array<{ reason?: string }>;
  } | string;
  error_description?: string;
}

const clip = (text: string, max = 300): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;

function parseEnvelope(body: Uint8Array): { message?: string; reason?: string } {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as GoogleErrorEnvelope;
    if (typeof parsed.error === "string") return { reason: parsed.error, ...(parsed.error_description ? { message: parsed.error_description } : {}) };
    const error = parsed.error;
    if (!error) return {};
    const reason = error.errors?.find((item) => typeof item.reason === "string")?.reason
      ?? error.details?.find((item) => typeof item.reason === "string")?.reason
      ?? error.status;
    return {
      ...(typeof error.message === "string" ? { message: error.message } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
    };
  } catch {
    return {};
  }
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Classify a non-2xx Google response. */
export function classifyGoogleFailure(status: number, headers: Headers, body: Uint8Array, mutating: boolean): GoogleError {
  const { message, reason } = parseEnvelope(body);
  const detail = message ? `: ${clip(message)}` : "";
  const extra = { status, ...(reason ? { reason } : {}) };
  const wwwAuth = headers.get("www-authenticate") ?? "";
  if (status === 401) {
    if (/insufficient_scope/i.test(wwwAuth) || /missing authorization for the requested scopes/i.test(message ?? "")) {
      return new GoogleError("insufficient-scope", "The Google account has not granted the access this operation needs. Authorize it in Settings → Google.", extra);
    }
    return new GoogleError("invalid-credentials", "Google rejected the account's credentials. Reconnect the account in Settings → Google.", extra);
  }
  if (status === 429 || (status === 403 && reason && RATE_REASONS.has(reason))) {
    const wait = retryAfter(headers);
    return new GoogleError("rate-limited", "Google rate limit reached; try again shortly.", { ...extra, ...(wait !== undefined ? { retryAfterMs: wait } : {}) });
  }
  if (status === 403) {
    if (reason && QUOTA_REASONS.has(reason)) return new GoogleError("rate-limited", `Google quota exhausted${detail}`, extra);
    if ((reason && SCOPE_REASONS.has(reason)) || /insufficient_scope/i.test(wwwAuth)) {
      return new GoogleError("insufficient-scope", "The Google account has not granted the access this operation needs. Authorize it in Settings → Google.", extra);
    }
    return new GoogleError("permission-denied", `Google denied this operation${detail}`, extra);
  }
  if (status === 404 || status === 410) return new GoogleError("not-found", `Google resource not found${detail}`, extra);
  if (status === 409 || status === 412) return new GoogleError("conflict", `Google reported a conflict${detail}`, extra);
  if (status === 413) return new GoogleError("too-large", `Google rejected the request size${detail}`, extra);
  if (status >= 500) {
    return mutating
      ? new GoogleError("mutation-outcome-unknown", "Google failed while applying the change; it may or may not have been applied. Check the resource before trying again.", extra)
      : new GoogleError("google-unavailable", "Google is temporarily unavailable; try again shortly.", extra);
  }
  return new GoogleError("invalid-request", `Google rejected the request${detail}`, extra);
}

export function createGoogleClient(options: GoogleClientOptions): GoogleClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const attempts = Math.max(1, options.attempts ?? 3);

  const raw = async (request: GoogleRequest): Promise<GoogleResponse> => {
    const method = request.method ?? "GET";
    const mutating = method !== "GET" && !request.idempotent;
    const url = buildUrl(request.url, request.query).toString();
    const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
    let body: BodyInit | undefined;
    const headers: Record<string, string> = { accept: "application/json", ...request.headers };
    if (request.json !== undefined) {
      body = JSON.stringify(request.json);
      headers["content-type"] = "application/json; charset=UTF-8";
    } else if (request.body !== undefined) {
      if (!request.contentType) return googleError("invalid-request", "A raw Google request body needs a content type.");
      body = typeof request.body === "string" ? request.body : new Blob([request.body as Uint8Array<ArrayBuffer>]);
      headers["content-type"] = request.contentType;
    }
    let refreshed = false;
    for (let attempt = 1; ; attempt += 1) {
      if (request.signal?.aborted) return googleError("cancelled", "The Google request was cancelled.");
      const token = await options.tokens.accessToken({ refresh: refreshed });
      const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: { ...headers, authorization: `Bearer ${token}` },
          ...(body !== undefined ? { body } : {}),
          signal,
          redirect: method === "GET" ? "follow" : "manual",
        });
      } catch {
        if (request.signal?.aborted) return googleError("cancelled", "The Google request was cancelled.");
        if (mutating) {
          return googleError("mutation-outcome-unknown", "The connection to Google failed while applying the change; it may or may not have been applied. Check the resource before trying again.");
        }
        if (attempt < attempts) { await sleep(backoff(attempt, random), request.signal); continue; }
        return googleError("network-error", "Could not reach Google. Check the network connection and try again.");
      }
      const ok = response.status >= 200 && response.status < 300 || response.status === 308;
      if (ok) {
        try {
          return { status: response.status, headers: response.headers, body: await readBounded(response, maxBytes) };
        } catch (error) {
          if (error instanceof GoogleError) throw error;
          if (mutating) return googleError("mutation-outcome-unknown", "Google applied the change but the response could not be read. Check the resource before trying again.");
          if (attempt < attempts) { await sleep(backoff(attempt, random), request.signal); continue; }
          return googleError("network-error", "The Google response could not be read.");
        }
      }
      const errorBody = await readBounded(response, 256 * 1024).catch(() => new Uint8Array());
      const failure = classifyGoogleFailure(response.status, response.headers, errorBody, mutating);
      if (response.status === 401 && failure.code === "invalid-credentials" && !refreshed) {
        // A 401 means the request was not executed; retrying with a fresh token is safe.
        refreshed = true;
        continue;
      }
      // A rate-limit rejection was not executed, so even a write may be retried.
      const retryable = failure.code === "rate-limited" && !(failure.reason && QUOTA_REASONS.has(failure.reason))
        || failure.code === "google-unavailable";
      if (retryable && attempt < attempts) {
        const wait = failure.retryAfterMs !== undefined
          ? Math.min(failure.retryAfterMs, MAX_RETRY_AFTER_MS)
          : backoff(attempt, random);
        await sleep(wait, request.signal);
        continue;
      }
      throw failure;
    }
  };

  return {
    raw,
    async json<T>(request: GoogleRequest): Promise<T> {
      const response = await raw(request);
      if (!response.body.byteLength) return undefined as T;
      try {
        return JSON.parse(new TextDecoder().decode(response.body)) as T;
      } catch {
        const mutating = (request.method ?? "GET") !== "GET" && !request.idempotent;
        return mutating
          ? googleError("mutation-outcome-unknown", "Google applied the change but returned an unreadable response. Check the resource before trying again.")
          : googleError("google-unavailable", "Google returned an unreadable response.");
      }
    },
  };
}

const backoff = (attempt: number, random: () => number): number =>
  Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(random() * 500);
