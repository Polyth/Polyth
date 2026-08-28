import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type { IncomingMessage } from "node:http";
import type {
  MutationTransportResult,
  OpenCodeTransport,
  ReplayPolicy,
} from "@polyth/contracts";

export interface TransportHttpResponse<T = unknown> {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: T;
}

export interface OpenCodeSseEvent {
  id?: string;
  data: unknown;
}

export interface OpenCodeTransportOptions {
  baseUrl: string;
  headers?: Readonly<Record<string, string>>;
  directory?: string;
  /** Maximum query attempts inside one deadline budget. Defaults to 3. */
  queryAttempts?: number;
  /** Maximum attempts for a pinned replay-safe PUT/PATCH. Defaults to 3. */
  replayAttempts?: number;
  /** Delay before retry N, or a fixed delay. Defaults to 100ms * N. */
  retryDelayMs?: number | ((attempt: number) => number);
  /** Exact operation-specific contracts that live tests have pinned. */
  pinnedReplayContracts?: ReadonlySet<string>;
}

export class OpenCodeDeadlineError extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`OpenCode request exceeded its ${deadlineMs}ms deadline`);
    this.name = "OpenCodeDeadlineError";
    this.deadlineMs = deadlineMs;
  }
}

const abortError = (reason?: unknown): Error => {
  const error = new Error("aborted", reason === undefined ? undefined : { cause: reason });
  error.name = "AbortError";
  return error;
};

const validatePositiveInteger = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
};

const validateDeadline = (deadlineMs: number): number => {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new RangeError("deadlineMs must be a positive finite number");
  }
  return deadlineMs;
};

const mergeHeaders = (
  defaults: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> => {
  const headers = new Headers(defaults);
  for (const [name, value] of Object.entries(overrides ?? {})) {
    headers.set(name, value);
  }
  return Object.freeze(Object.fromEntries(headers.entries()));
};

const pathWithParameters = (
  path: string,
  directory?: string,
  after?: string,
): string => {
  const hashAt = path.indexOf("#");
  const hash = hashAt < 0 ? "" : path.slice(hashAt);
  const pathAndQuery = hashAt < 0 ? path : path.slice(0, hashAt);
  const queryAt = pathAndQuery.indexOf("?");
  const pathname = queryAt < 0 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const params = new URLSearchParams(queryAt < 0 ? "" : pathAndQuery.slice(queryAt + 1));
  if (directory !== undefined) params.set("directory", directory);
  if (after !== undefined) params.set("after", after);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
};

const responseHeaders = (headers: Headers): Readonly<Record<string, string>> =>
  Object.freeze(Object.fromEntries(headers.entries()));

const parseBody = (raw: string): unknown => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const consumeResponse = async (
  response: Response,
  method: string,
): Promise<TransportHttpResponse> => {
  const body =
    method === "HEAD" || response.status === 204
      ? undefined
      : parseBody(await response.text());
  return {
    status: response.status,
    headers: responseHeaders(response.headers),
    body,
  };
};

const errorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return errorCode(error.cause);
  return undefined;
};

const isTransientNetworkError = (error: unknown): boolean => {
  if (error instanceof OpenCodeDeadlineError) return true;
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  if (
    code &&
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETDOWN",
      "ENETUNREACH",
      "EPIPE",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }
  return /fetch failed|terminated|socket|connection|timed?\s*out/i.test(error.message);
};

const readableError = (error: unknown): string => {
  if (error instanceof OpenCodeDeadlineError) return error.message;
  if (error instanceof Error) {
    const code = errorCode(error);
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
};

const requestWithinDeadline = async (
  url: string,
  init: RequestInit,
  method: string,
  deadlineAt: number,
  deadlineMs: number,
): Promise<TransportHttpResponse> => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new OpenCodeDeadlineError(deadlineMs);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new OpenCodeDeadlineError(deadlineMs));
  }, remaining);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await consumeResponse(response, method);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OpenCodeDeadlineError(deadlineMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const sleepInsideBudget = async (
  delayMs: number,
  deadlineAt: number,
  deadlineMs: number,
): Promise<void> => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0 || delayMs >= remaining) {
    throw new OpenCodeDeadlineError(deadlineMs);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
};

const retryDelay = (
  configured: OpenCodeTransportOptions["retryDelayMs"],
  attempt: number,
): number => {
  const value =
    typeof configured === "function"
      ? configured(attempt)
      : configured === undefined
        ? 100 * attempt
        : configured;
  return Number.isFinite(value) ? Math.max(0, value) : 0;
};

const drainSseFrames = (
  input: string,
  onEvent: (event: OpenCodeSseEvent) => void,
): string => {
  let buffer = input;
  for (;;) {
    const separator = /\r?\n\r?\n/.exec(buffer);
    if (!separator || separator.index === undefined) return buffer;
    const frame = buffer.slice(0, separator.index);
    buffer = buffer.slice(separator.index + separator[0].length);

    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      data = raw;
    }
    onEvent({ ...(id === undefined ? {} : { id }), data });
  }
};

const streamRequest = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  onEvent: (event: OpenCodeSseEvent) => void,
): Promise<void> => {
  const get = url.protocol === "https:" ? httpsGet : httpGet;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };

    const request = get(
      url,
      { headers: { ...headers, accept: "text/event-stream" } },
      (incoming) => {
        response = incoming;
        if (incoming.statusCode !== 200) {
          incoming.resume();
          request.destroy();
          settle(new Error(`opencode GET ${url.pathname} → ${incoming.statusCode ?? 0}`));
          return;
        }

        incoming.setEncoding("utf8");
        let buffer = "";
        incoming.on("data", (chunk: string) => {
          if (settled) return;
          try {
            buffer += chunk;
            buffer = drainSseFrames(buffer, onEvent);
          } catch (error) {
            const eventError = error instanceof Error ? error : new Error(String(error));
            request.destroy(eventError);
            settle(eventError);
          }
        });
        incoming.on("end", () => settle());
        incoming.on("aborted", () => {
          settle(new Error("OpenCode SSE response closed before completion"));
        });
        incoming.on("error", (error) => settle(error));
        incoming.on("close", () => {
          if (!incoming.complete && !settled) {
            settle(new Error("OpenCode SSE socket closed"));
          }
        });
      },
    );

    const onAbort = () => {
      const error = abortError(signal.reason);
      settle(error);
      response?.destroy(error);
      request.destroy(error);
    };

    request.on("error", (error) => settle(error));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
};

const canReplayMutation = (
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  replay: ReplayPolicy,
  pinnedContracts: ReadonlySet<string>,
): boolean =>
  (method === "PUT" || method === "PATCH") &&
  replay.kind === "same-operation-id" &&
  pinnedContracts.has(replay.contract);

/**
 * Build the OpenCode wire boundary.
 *
 * `query<T>` resolves to `TransportHttpResponse<Body>` represented by T because
 * the provider-neutral contract leaves the query result generic. Callers should
 * instantiate T as `TransportHttpResponse<Body>`. HTTP statuses are returned,
 * never classified as operation outcomes here.
 */
export const createOpenCodeTransport = (
  options: OpenCodeTransportOptions,
): OpenCodeTransport => {
  const root = options.baseUrl.replace(/\/$/, "");
  // Authentication belongs to the endpoint lease. The compatibility client
  // supplies its legacy environment fallback explicitly; the generic
  // transport must never leak those credentials to a borrowed endpoint.
  const headers = mergeHeaders({}, options.headers);
  const queryAttempts = validatePositiveInteger(options.queryAttempts ?? 3, "queryAttempts");
  const replayAttempts = validatePositiveInteger(
    options.replayAttempts ?? 3,
    "replayAttempts",
  );
  const pinnedContracts = new Set(options.pinnedReplayContracts ?? []);

  const urlFor = (path: string, after?: string): string =>
    `${root}${pathWithParameters(path, options.directory, after)}`;

  const execute = async (
    method: string,
    path: string,
    body: string | undefined,
    deadlineAt: number,
    deadlineMs: number,
    requestHeaders?: Readonly<Record<string, string>>,
  ): Promise<TransportHttpResponse> =>
    await requestWithinDeadline(
      urlFor(path),
      {
        method,
        headers: {
          ...headers,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...requestHeaders,
        },
        body,
      },
      method,
      deadlineAt,
      deadlineMs,
    );

  return {
    async query<T>(request: {
      method: "GET" | "HEAD";
      path: string;
      deadlineMs: number;
    }): Promise<T> {
      const deadlineMs = validateDeadline(request.deadlineMs);
      const deadlineAt = Date.now() + deadlineMs;
      let lastError: unknown;

      for (let attempt = 1; attempt <= queryAttempts; attempt += 1) {
        try {
          return (await execute(
            request.method,
            request.path,
            undefined,
            deadlineAt,
            deadlineMs,
          )) as T;
        } catch (error) {
          lastError = error;
          if (attempt === queryAttempts || !isTransientNetworkError(error)) throw error;
          await sleepInsideBudget(
            retryDelay(options.retryDelayMs, attempt),
            deadlineAt,
            deadlineMs,
          );
        }
      }
      throw lastError;
    },

    async mutate<T>(request: {
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: unknown;
      operationId: string;
      deadlineMs: number;
      replay: ReplayPolicy;
    }): Promise<MutationTransportResult<T>> {
      const deadlineMs = validateDeadline(request.deadlineMs);
      const serializedBody =
        request.body === undefined ? undefined : JSON.stringify(request.body);
      const deadlineAt = Date.now() + deadlineMs;
      const replay = request.replay ?? { kind: "never" };
      const attempts = canReplayMutation(request.method, replay, pinnedContracts)
        ? replayAttempts
        : 1;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await execute(
            request.method,
            request.path,
            serializedBody,
            deadlineAt,
            deadlineMs,
            { "x-polyth-operation-id": request.operationId },
          );
          return {
            kind: "response",
            status: response.status,
            headers: response.headers,
            body: response.body as T,
          };
        } catch (error) {
          if (
            attempt < attempts &&
            isTransientNetworkError(error) &&
            Date.now() < deadlineAt
          ) {
            try {
              await sleepInsideBudget(
                retryDelay(options.retryDelayMs, attempt),
                deadlineAt,
                deadlineMs,
              );
              continue;
            } catch (deadlineError) {
              error = deadlineError;
            }
          }
          return {
            kind: "unknown",
            operationId: request.operationId,
            message: `OpenCode ${request.method} ${request.path} outcome is unknown: ${readableError(error)}`,
          };
        }
      }

      return {
        kind: "unknown",
        operationId: request.operationId,
        message: `OpenCode ${request.method} ${request.path} outcome is unknown`,
      };
    },

    stream(request): Promise<void> {
      const url = new URL(urlFor(request.path, request.after));
      return streamRequest(
        url,
        headers,
        request.signal,
        (event) => request.onEvent(event),
      );
    },
  };
};
