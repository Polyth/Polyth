import { createHash, createPrivateKey, sign } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";

import {
  type DeliveryInput, type Destination, type ProviderAdapter, type ProviderClass, type ProviderReply, ProviderTransportError,
} from "./types.ts";

const APNS_ORIGIN = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;
const FCM_ORIGIN = "https://fcm.googleapis.com";
const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com/token";
const PROVIDER_TIMEOUT_MS = 5_000;

const providerDeadline = (external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const abortExternal = () => controller.abort(external?.reason);
  if (external?.aborted) abortExternal();
  else external?.addEventListener("abort", abortExternal, { once: true });
  // A referenced timer is intentional: an otherwise idle relay process must
  // still release the per-subscription delivery gate at the deadline.
  const timer = setTimeout(() => controller.abort(new ProviderTransportError("timeout")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener("abort", abortExternal);
    },
  };
};

const b64u = (value: string | Buffer): string => Buffer.from(value).toString("base64url");
const nowSeconds = () => Math.floor(Date.now() / 1_000);
const messageFor = (kind: DeliveryInput["kind"]): { title: string; body: string; channel: "polyth_activity" | "polyth_attention" } => {
  switch (kind) {
    case "completed": return { title: "Polyth", body: "A task completed", channel: "polyth_activity" };
    case "failed": return { title: "Polyth", body: "A task needs attention", channel: "polyth_attention" };
    case "question": return { title: "Polyth", body: "A task has a question", channel: "polyth_attention" };
    case "permission": return { title: "Polyth", body: "A task needs permission", channel: "polyth_attention" };
    case "subagent": return { title: "Polyth", body: "A delegated task changed", channel: "polyth_activity" };
  }
};
const collapseId = (tag: string): string => createHash("sha256").update(tag).digest("base64url").slice(0, 32);

export interface ApnsRequest {
  origin: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal?: AbortSignal;
}

export interface ApnsTransport {
  send(request: ApnsRequest): Promise<ProviderReply>;
  close?(): void;
}

/** Persistent, fixed-origin h2 client. The provider owns the single GOAWAY retry. */
export class Http2ApnsTransport implements ApnsTransport {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private readonly goaway = new Set<string>();

  send(request: ApnsRequest): Promise<ProviderReply> { return this.sendOnce(request); }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private session(origin: string): ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    this.goaway.delete(origin);
    const next = connect(origin);
    next.on("goaway", () => {
      this.goaway.add(origin);
      if (this.sessions.get(origin) === next) this.sessions.delete(origin);
    });
    next.on("close", () => {
      if (this.sessions.get(origin) === next) this.sessions.delete(origin);
    });
    next.on("error", () => { /* active stream receives the classified error */ });
    this.sessions.set(origin, next);
    return next;
  }

  private sendOnce(request: ApnsRequest): Promise<ProviderReply> {
    const session = this.session(request.origin);
    return new Promise((resolve, reject) => {
      let status = 0;
      let total = 0;
      let settled = false;
      const chunks: Buffer[] = [];
      const stream = session.request({ ":method": "POST", ":path": request.path, ...request.headers });
      const settle = (work: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        work();
      };
      const fail = (error: unknown) => {
        settle(() => {
          if (this.goaway.has(request.origin)) reject(new ProviderTransportError("goaway"));
          else if (error instanceof ProviderTransportError) reject(error);
          else reject(new ProviderTransportError("network"));
        });
      };
      const abort = () => { stream.close(constants.NGHTTP2_CANCEL); fail(new ProviderTransportError("network")); };
      const timer = setTimeout(abort, 5_000);
      request.signal?.addEventListener("abort", abort, { once: true });
      stream.on("response", (headers) => { status = Number(headers[":status"] ?? 0); });
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total <= 1024) chunks.push(chunk);
      });
      stream.on("error", fail);
      stream.on("aborted", () => fail(new ProviderTransportError("network")));
      stream.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let reason: string | undefined;
        try {
          const parsed = JSON.parse(body) as { reason?: unknown };
          if (typeof parsed.reason === "string" && parsed.reason.length <= 80) reason = parsed.reason;
        } catch { /* response content remains untrusted */ }
        settle(() => resolve({ status, ...(reason ? { reason } : {}) }));
      });
      stream.end(request.body);
    });
  }
}

export interface ApnsProviderOptions {
  teamId: string;
  keyId: string;
  p8: string;
  topic: string;
  transport?: ApnsTransport;
  nowSeconds?: () => number;
}

export class ApnsProvider implements ProviderAdapter {
  private readonly options: ApnsProviderOptions;
  private readonly transport: ApnsTransport;
  private readonly now: () => number;
  private cached?: { issuedAt: number; token: string };

  constructor(options: ApnsProviderOptions) {
    this.options = options;
    this.transport = options.transport ?? new Http2ApnsTransport();
    this.now = options.nowSeconds ?? nowSeconds;
  }

  close(): void { this.transport.close?.(); }

  async deliver(destination: Destination, input: DeliveryInput, signal?: AbortSignal): Promise<ProviderClass> {
    if (destination.platform !== "ios" || !destination.environment) return "config";
    let authorization: string;
    try { authorization = `bearer ${this.jwt()}`; } catch { return "config"; }
    const notice = messageFor(input.kind);
    const request: ApnsRequest = {
      origin: APNS_ORIGIN[destination.environment],
      path: `/3/device/${encodeURIComponent(destination.providerToken)}`,
      headers: {
        authorization,
        "apns-topic": this.options.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(this.now() + 300),
        "apns-collapse-id": collapseId(input.tag),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        aps: { alert: { title: notice.title, body: notice.body }, sound: "default" },
        version: input.version,
        subscriptionId: input.subscriptionId,
        notificationId: input.notificationId,
        kind: input.kind,
        tag: input.tag,
      }),
      signal,
    };
    try {
      return classifyApns(await this.transport.send(request));
    } catch (error) {
      // A fresh h2 session is selected by the transport after GOAWAY. No other
      // failure retries, and a second GOAWAY remains a bounded transient result.
      if (error instanceof ProviderTransportError && error.code === "goaway") {
        try { return classifyApns(await this.transport.send(request)); } catch { return "transient"; }
      }
      return "transient";
    }
  }

  private jwt(): string {
    const now = this.now();
    if (this.cached && now - this.cached.issuedAt < 55 * 60) return this.cached.token;
    if (!/^[A-Za-z0-9]{1,32}$/.test(this.options.teamId) || !/^[A-Za-z0-9]{1,32}$/.test(this.options.keyId)
      || !/^[A-Za-z0-9.-]{1,255}$/.test(this.options.topic)) throw new Error("invalid apns config");
    const header = b64u(JSON.stringify({ alg: "ES256", kid: this.options.keyId }));
    const payload = b64u(JSON.stringify({ iss: this.options.teamId, iat: now }));
    const input = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(input), { key: createPrivateKey(this.options.p8), dsaEncoding: "ieee-p1363" });
    const token = `${input}.${b64u(signature)}`;
    this.cached = { issuedAt: now, token };
    return token;
  }
}

export const classifyApns = (reply: ProviderReply): ProviderClass => {
  if (reply.status >= 200 && reply.status < 300) return "success";
  if (["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(reply.reason ?? "")) return "permanent";
  if (reply.status === 401 || reply.status === 403) return "auth";
  if (reply.status === 429) return "rate";
  if (reply.status >= 500 || reply.status === 0) return "transient";
  return "config";
};

export interface AccessToken { accessToken: string; expiresAt: number; }
/** Workload identity / ADC is supplied through this seam rather than embedded in relay state. */
export interface AccessTokenProvider { getAccessToken(signal?: AbortSignal): Promise<AccessToken>; }
export interface FcmRequest { url: string; bearer: string; body: string; signal?: AbortSignal; }
export interface FcmTransport { send(request: FcmRequest): Promise<ProviderReply>; }

export class FetchFcmTransport implements FcmTransport {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(timeoutMs = PROVIDER_TIMEOUT_MS, fetchFn: typeof fetch = fetch) {
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
  }

  async send(request: FcmRequest): Promise<ProviderReply> {
    const deadline = providerDeadline(request.signal, this.timeoutMs);
    try {
      const response = await this.fetchFn(request.url, {
        method: "POST",
        headers: { authorization: `Bearer ${request.bearer}`, "content-type": "application/json" },
        body: request.body,
        signal: deadline.signal,
        redirect: "error",
      });
      const text = (await response.text()).slice(0, 1024);
      let reason: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: { status?: unknown } };
        if (typeof parsed.error?.status === "string" && parsed.error.status.length <= 80) reason = parsed.error.status;
      } catch { /* response body is never logged */ }
      return { status: response.status, ...(reason ? { reason } : {}) };
    } catch { throw new ProviderTransportError("network"); }
    finally { deadline.dispose(); }
  }
}

export interface FcmProviderOptions {
  project: string;
  accessTokenProvider: AccessTokenProvider;
  transport?: FcmTransport;
  now?: () => number;
}

export class FcmProvider implements ProviderAdapter {
  private readonly options: FcmProviderOptions;
  private readonly transport: FcmTransport;
  private readonly now: () => number;
  private cached?: AccessToken;

  constructor(options: FcmProviderOptions) {
    this.options = options;
    this.transport = options.transport ?? new FetchFcmTransport();
    this.now = options.now ?? Date.now;
  }

  async deliver(destination: Destination, input: DeliveryInput, signal?: AbortSignal): Promise<ProviderClass> {
    if (destination.platform !== "android" || !/^[A-Za-z0-9._-]{1,128}$/.test(this.options.project)) return "config";
    const token = await this.access(signal).catch(() => undefined);
    if (!token) return "auth";
    const notice = messageFor(input.kind);
    // The locally built message is shape-valid, so INVALID_ARGUMENT is a permanent token result.
    const body = JSON.stringify({ message: {
      token: destination.providerToken,
      notification: { title: notice.title, body: notice.body },
      data: {
        version: "1",
        subscriptionId: input.subscriptionId,
        notificationId: input.notificationId,
        kind: input.kind,
        tag: input.tag,
      },
      // Native alerts are short-lived hints. The canonical inbox remains the
      // durable source, and the notification tag replaces a duplicate display
      // of this exact transition instead of stacking another tray entry.
      android: { ttl: "300s", notification: { channel_id: notice.channel, tag: input.tag } },
    } });
    try {
      return classifyFcm(await this.transport.send({
        url: `${FCM_ORIGIN}/v1/projects/${encodeURIComponent(this.options.project)}/messages:send`, bearer: token, body, signal,
      }), true);
    } catch { return "transient"; }
  }

  private async access(signal?: AbortSignal): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt - now > 60_000) return this.cached.accessToken;
    const next = await this.options.accessTokenProvider.getAccessToken(signal);
    if (!/^[!-~]{8,4096}$/.test(next.accessToken) || !Number.isSafeInteger(next.expiresAt) || next.expiresAt <= now) throw new Error("invalid token");
    this.cached = next;
    return next.accessToken;
  }
}

export const classifyFcm = (reply: ProviderReply, validPayload: boolean): ProviderClass => {
  if (reply.status >= 200 && reply.status < 300) return "success";
  if (reply.reason === "UNREGISTERED" || reply.reason === "NOT_FOUND") return "permanent";
  if (reply.reason === "INVALID_ARGUMENT" && validPayload) return "permanent";
  if (reply.status === 401 || reply.status === 403 || reply.reason === "UNAUTHENTICATED") return "auth";
  if (reply.status === 429 || reply.reason === "RESOURCE_EXHAUSTED") return "rate";
  if (reply.status >= 500 || reply.status === 0 || reply.reason === "UNAVAILABLE") return "transient";
  return "config";
};

export interface ServiceAccountTokenOptions { serviceAccountJson: string; fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number; }
/** Minimal OAuth2 service-account exchange; no ambient credential files are read. */
export class ServiceAccountAccessTokenProvider implements AccessTokenProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cached?: AccessToken;
  private readonly email: string;
  private readonly key: string;

  constructor(options: ServiceAccountTokenOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
    let parsed: { client_email?: unknown; private_key?: unknown; token_uri?: unknown };
    try { parsed = JSON.parse(options.serviceAccountJson) as typeof parsed; } catch { throw new Error("invalid service account"); }
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string"
      || (parsed.token_uri !== undefined && parsed.token_uri !== GOOGLE_TOKEN_ORIGIN)) throw new Error("invalid service account");
    this.email = parsed.client_email;
    this.key = parsed.private_key;
  }

  async getAccessToken(signal?: AbortSignal): Promise<AccessToken> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt - now > 60_000) return this.cached;
    const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64u(JSON.stringify({ iss: this.email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: GOOGLE_TOKEN_ORIGIN, iat: Math.floor(now / 1_000), exp: Math.floor(now / 1_000) + 3600 }));
    const assertionInput = `${header}.${payload}`;
    const assertion = `${assertionInput}.${b64u(sign("RSA-SHA256", Buffer.from(assertionInput), createPrivateKey(this.key)))}`;
    const deadline = providerDeadline(signal, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(GOOGLE_TOKEN_ORIGIN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: deadline.signal,
        redirect: "error",
      });
    } finally {
      deadline.dispose();
    }
    if (!response.ok) throw new Error("oauth failure");
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_in)) throw new Error("oauth response");
    const next = { accessToken: data.access_token, expiresAt: now + Math.min(Math.max(60, Number(data.expires_in)), 3600) * 1_000 };
    this.cached = next;
    return next;
  }
}
