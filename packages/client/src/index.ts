// Client for the Polyth Client API v1. No runtime dependencies: `fetch`, web
// streams and `crypto.randomUUID` are all it needs, in Node and in a browser.
// The server enforces every rule; this module only speaks HTTP. For any other
// language, docs/api/client-v1.openapi.json describes the same API.
import type {
  ClientAccount,
  ClientCreateSession,
  ClientEvent,
  ClientEventPage,
  ClientModel,
  ClientPendingRequest,
  ClientProject,
  ClientSendMessage,
  ClientSendResult,
  ClientSession,
  ClientSessionPage,
} from "@polyth/contracts/client-api";

export type {
  ClientAccount,
  ClientCreateSession,
  ClientEvent,
  ClientEventPage,
  ClientModel,
  ClientPendingRequest,
  ClientProject,
  ClientSendMessage,
  ClientSendResult,
  ClientSession,
  ClientSessionPage,
} from "@polyth/contracts/client-api";

type Fetch = typeof globalThis.fetch;

/** A refused request, or one whose outcome is unknown (`status` 0: the
 *  connection failed). Retry a send only with the same `operationId`. */
export class PolythApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly operationId?: string;

  constructor(message: string, status: number, code: string, operationId?: string) {
    super(message);
    this.name = "PolythApiError";
    this.status = status;
    this.code = code;
    if (operationId) this.operationId = operationId;
  }
}

/** A token must not cross a network in clear: the server would refuse it, but
 *  only after it has already travelled. Loopback is the one exception. */
function baseUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new PolythApiError("Polyth needs an https:// address (http:// only on this machine)", 0, "insecure-url");
  }
  return url.origin;
}

async function failure(response: Response, operationId?: string): Promise<PolythApiError> {
  const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown; message?: unknown };
  const code = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : `http-${response.status}`;
  return new PolythApiError(typeof body.message === "string" ? body.message : `HTTP ${response.status}`, response.status, code, operationId);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

export interface SignInCode {
  /** Show this to the person. They confirm it in Polyth, Settings → Apps. */
  userCode: string;
  /** Opens that page with the code filled in. */
  verificationUrl: string;
  expiresIn: number;
}

export interface SignInOptions {
  url: string;
  /** The name the person reads before deciding. */
  name: string;
  /** `read` watches, `control` also starts and steers work, `approve` also
   *  answers agents' permission requests, if the instance owner says yes. */
  access?: "read" | "control" | "approve";
  onCode(code: SignInCode): void;
  signal?: AbortSignal;
  fetch?: Fetch;
}

/** Ask a person for access. Resolves with the app's token once they confirm;
 *  store it like a password. Not available from a web page in this version. */
export async function signIn(options: SignInOptions): Promise<string> {
  const base = baseUrl(options.url);
  const call = options.fetch ?? globalThis.fetch;
  const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (options.signal) init.signal = options.signal;
    const response = await call(`${base}${path}`, init);
    if (!response.ok) throw await failure(response);
    return await response.json() as Record<string, unknown>;
  };
  const start = await post("/api/auth/cli/device", { kind: "app", label: options.name, profile: options.access ?? "control" });
  const userCode = String(start.userCode);
  options.onCode({
    userCode,
    verificationUrl: `${base}${String(start.verificationPath)}&code=${encodeURIComponent(userCode)}`,
    expiresIn: Number(start.expiresIn),
  });
  const intervalMs = Math.max(1, Number(start.interval) || 3) * 1000;
  for (;;) {
    await sleep(intervalMs, options.signal);
    options.signal?.throwIfAborted();
    const result = await post("/api/auth/cli/device/token", { deviceCode: start.deviceCode });
    if (result.status === "issued") return String(result.token);
  }
}

export interface ClientOptions {
  url: string;
  token: string;
  /** Ask for this Space, when the token is not pinned to one. */
  spaceId?: string;
  fetch?: Fetch;
}

export interface StreamOptions {
  /** Resume after this `seq`. Default: the whole history. */
  afterSeq?: number;
  signal?: AbortSignal;
}

const enc = encodeURIComponent;

/** Split a finished server-sent-events frame into its fields. */
function parseFrame(frame: string): { event: string; data: string } {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: data.join("\n") };
}

export function createPolythClient(options: ClientOptions) {
  const base = baseUrl(options.url);
  const call = options.fetch ?? globalThis.fetch;
  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${options.token}`,
    ...(options.spaceId ? { "x-polyth-space": options.spaceId } : {}),
  });

  const request = async <T>(method: string, path: string, body?: unknown, operationId?: string): Promise<T> => {
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: { ...headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await call(`${base}${path}`, init);
    } catch (cause) {
      throw new PolythApiError(cause instanceof Error ? cause.message : "connection failed", 0, "outcome-unknown", operationId);
    }
    if (!response.ok) throw await failure(response, operationId);
    return await response.json() as T;
  };

  /** Every event after `afterSeq`, then live, until aborted. Reconnects on its
   *  own from the last event seen, so nothing is skipped or repeated. Ends with
   *  an error when access is withdrawn. */
  async function* stream(sessionId: string, streamOptions: StreamOptions = {}): AsyncGenerator<ClientEvent> {
    const { signal } = streamOptions;
    let cursor = streamOptions.afterSeq ?? 0;
    let failures = 0;
    while (!signal?.aborted) {
      let response: Response | undefined;
      try {
        const init: RequestInit = {
          headers: { ...headers(), accept: "text/event-stream", "last-event-id": String(cursor) },
        };
        if (signal) init.signal = signal;
        response = await call(`${base}/api/v1/sessions/${enc(sessionId)}/events`, init);
      } catch {
        if (signal?.aborted) return;
      }
      if (response && !response.ok) {
        if (response.status >= 500 || response.status === 429) await response.body?.cancel();
        else throw await failure(response);
      }
      if (response?.ok && response.body) {
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            failures = 0;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let end = buffer.indexOf("\n\n");
            while (end !== -1) {
              const frame = parseFrame(buffer.slice(0, end));
              buffer = buffer.slice(end + 2);
              end = buffer.indexOf("\n\n");
              if (frame.event === "end") {
                const reason = (JSON.parse(frame.data) as { reason?: string }).reason ?? "";
                if (reason === "unauthorized") throw new PolythApiError("Access to this chat was withdrawn", 401, "unauthorized");
                if (reason === "not-found") throw new PolythApiError("This chat no longer exists", 404, "not-found");
              } else if (frame.data) {
                const event = JSON.parse(frame.data) as ClientEvent;
                if (event.seq <= cursor) continue;
                cursor = event.seq;
                yield event;
              }
            }
          }
        } catch (cause) {
          if (cause instanceof PolythApiError) throw cause;
          if (signal?.aborted) return;
        } finally {
          reader.releaseLock();
        }
      }
      if (signal?.aborted) return;
      failures += 1;
      await sleep(Math.min(250 * 2 ** Math.min(failures, 7), 30_000), signal);
    }
  }

  return {
    me: () => request<ClientAccount>("GET", "/api/v1/me"),
    projects: async () => (await request<{ projects: ClientProject[] }>("GET", "/api/v1/projects")).projects,
    models: async () => (await request<{ models: ClientModel[] }>("GET", "/api/v1/models")).models,
    /** Withdraw this token. Every later call is refused. */
    revoke: async (): Promise<void> => {
      await request("POST", "/api/auth/cli/logout", {});
    },
    sessions: {
      list(query: { projectId?: string; archived?: boolean; limit?: number; cursor?: string } = {}): Promise<ClientSessionPage> {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
        const suffix = params.size ? `?${params}` : "";
        return request<ClientSessionPage>("GET", `/api/v1/sessions${suffix}`);
      },
      /** Safe to retry with the same `clientOperationId`. */
      create(input: ClientCreateSession): Promise<ClientSession> {
        const clientOperationId = input.clientOperationId ?? crypto.randomUUID();
        return request<ClientSession>("POST", "/api/v1/sessions", { ...input, clientOperationId }, clientOperationId);
      },
      get: (sessionId: string) => request<ClientSession>("GET", `/api/v1/sessions/${enc(sessionId)}`),
      /** Safe to retry with the same `clientOperationId`; the error of a failed
       *  send carries it as `operationId`. Never resend without it. */
      send(sessionId: string, input: ClientSendMessage): Promise<ClientSendResult> {
        const clientOperationId = input.clientOperationId ?? crypto.randomUUID();
        return request<ClientSendResult>("POST", `/api/v1/sessions/${enc(sessionId)}/messages`, { ...input, clientOperationId }, clientOperationId);
      },
      abort: async (sessionId: string): Promise<void> => {
        await request("POST", `/api/v1/sessions/${enc(sessionId)}/abort`, {});
      },
      /** One page of history; pass `waitMs` to long-poll instead of streaming. */
      events(sessionId: string, query: { afterSeq?: number; waitMs?: number } = {}): Promise<ClientEventPage> {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
        const suffix = params.size ? `?${params}` : "";
        return request<ClientEventPage>("GET", `/api/v1/sessions/${enc(sessionId)}/events${suffix}`);
      },
      stream,
      /** What the agent is waiting on. */
      requests: async (sessionId: string) =>
        (await request<{ requests: ClientPendingRequest[] }>("GET", `/api/v1/sessions/${enc(sessionId)}/requests`)).requests,
      /** Allow one action, once. Needs the owner's permission for this app. */
      approve: async (sessionId: string, requestId: string): Promise<void> => {
        await request("POST", `/api/v1/sessions/${enc(sessionId)}/permissions/${enc(requestId)}/approve`, {});
      },
      reject: async (sessionId: string, requestId: string): Promise<void> => {
        await request("POST", `/api/v1/sessions/${enc(sessionId)}/permissions/${enc(requestId)}/reject`, {});
      },
      answer: async (sessionId: string, requestId: string, answers: Record<string, unknown>): Promise<void> => {
        await request("POST", `/api/v1/sessions/${enc(sessionId)}/questions/${enc(requestId)}/answer`, { answers });
      },
      rejectQuestion: async (sessionId: string, requestId: string): Promise<void> => {
        await request("POST", `/api/v1/sessions/${enc(sessionId)}/questions/${enc(requestId)}/reject`, {});
      },
    },
  };
}

export type PolythClient = ReturnType<typeof createPolythClient>;
