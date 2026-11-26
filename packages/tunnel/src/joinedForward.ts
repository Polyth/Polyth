// Talking to one Link client's loopback proxy: claiming its proxy session,
// and carrying requests and WebSocket upgrades to the other server. Only the
// proxy cookie ever authenticates these; nothing the browser sent to this
// server (cookie, authorization, CSRF, forwarding headers) crosses.
import { request, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

const LOOPBACK = "127.0.0.1";
const BOOTSTRAP_PREFIX = "/__polyth_boot/";
const JSON_LIMIT = 4 * 1024 * 1024;
const UPGRADE_HEAD_LIMIT = 32 * 1024;
const HALF_CLOSE_GRACE_MS = 5_000;

/** The same names the Link transport lets through, plus nothing of ours. */
const REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "range",
] as const;

const UPGRADE_HEADERS = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
] as const;

/** Hop-by-hop headers, and headers that would act on this server's origin. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "alt-svc", "clear-site-data", "connection", "content-security-policy",
  "content-security-policy-report-only", "keep-alive", "link", "proxy-authenticate",
  "proxy-authorization", "refresh", "service-worker-allowed", "set-cookie", "set-cookie2",
  "strict-transport-security", "te", "trailer", "transfer-encoding", "upgrade",
]);

export interface ProxySession {
  port: number;
  /** `name=value` of the proxy session cookie. */
  cookie: string;
}

const failure = (code: string): Error => Object.assign(new Error(code), { code });

/** Consumes the one-shot nonce of a bootstrap URL: its POST answers with the
 *  proxy session cookie. */
export function claimProxySession(bootstrapUrl: unknown, timeoutMs: number): Promise<ProxySession> {
  const url = typeof bootstrapUrl === "string" ? URL.parse(bootstrapUrl) : null;
  const port = Number(url?.port);
  if (!url || url.protocol !== "http:" || url.hostname !== LOOPBACK || !port || !url.pathname.startsWith(BOOTSTRAP_PREFIX)) {
    return Promise.reject(failure("proxy-bootstrap-invalid"));
  }
  return new Promise((resolve, reject) => {
    const claim = request({
      host: LOOPBACK, port, method: "POST", path: url.pathname, agent: false,
      headers: { "content-length": "0" }, signal: AbortSignal.timeout(timeoutMs),
    });
    claim.once("response", (answer) => {
      answer.resume();
      const cookie = answer.headers["set-cookie"]?.[0]?.split(";")[0]?.trim();
      if ((answer.statusCode ?? 500) >= 300 || !cookie) reject(failure("proxy-bootstrap-invalid"));
      else resolve({ port, cookie });
    });
    claim.once("error", () => reject(failure("transport-unavailable")));
    claim.end();
  });
}

/** One small request of this package's own through the proxy. */
export function proxyJson(session: ProxySession, input: {
  method?: "GET" | "POST";
  path: string;
  spaceId?: string;
  timeoutMs: number;
}): Promise<{ status: number; body: unknown }> {
  const method = input.method ?? "GET";
  return new Promise((resolve, reject) => {
    const call = request({
      host: LOOPBACK, port: session.port, method, path: input.path, agent: false,
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: {
        accept: "application/json",
        cookie: session.cookie,
        ...(input.spaceId ? { "x-polyth-space": input.spaceId } : {}),
        ...(method === "GET" ? {} : { "content-length": "0" }),
      },
    });
    call.once("response", (answer) => {
      const chunks: Buffer[] = [];
      let size = 0;
      answer.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > JSON_LIMIT) answer.destroy(failure("request-too-large"));
        else chunks.push(chunk);
      });
      answer.once("error", () => reject(failure("transport-unavailable")));
      answer.once("end", () => {
        let body: unknown = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
        resolve({ status: answer.statusCode ?? 502, body });
      });
    });
    call.once("error", () => reject(failure("transport-unavailable")));
    call.end();
  });
}

/** Reads a whole request body, because the proxy accepts only a declared
 *  length. A body that did not fully arrive is never forwarded. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too-large" | "aborted"> {
  if (Number(req.headers["content-length"] ?? 0) > limit) {
    req.resume();
    return Promise.resolve("too-large");
  }
  if (req.readableEnded) return Promise.resolve(Buffer.alloc(0));
  if (req.destroyed) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (result: Buffer | "too-large" | "aborted"): void => {
      req.off("data", onData).off("end", onEnd).off("close", onClose);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        done("too-large");
        req.resume();
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = (): void => done(Buffer.concat(chunks));
    const onClose = (): void => done("aborted");
    req.on("error", () => done("aborted"));
    req.on("data", onData).once("end", onEnd).once("close", onClose);
  });
}

export function forwardedRequestHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const name of REQUEST_HEADERS) {
    const value = headers[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** The other server's bytes are served from this server's origin, so a page
 *  among them must never run as this origin: sandbox, and no type sniffing. */
function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name) || name.startsWith("access-control-")) continue;
    out[name] = value;
  }
  out["content-security-policy"] = "sandbox";
  out["x-content-type-options"] = "nosniff";
  // A sandbox policy does not stop a module import or a stylesheet: code or
  // styles from the other server would run as this origin. Such bytes arrive
  // as opaque data instead, which nosniff keeps from executing.
  const type = String(out["content-type"] ?? "").toLowerCase();
  if (EXECUTABLE_TYPE.test(type)) out["content-type"] = "application/octet-stream";
  return out;
}

/** Response types a page on this origin would run or apply. */
const EXECUTABLE_TYPE = /^\s*(?:(?:text|application)\/(?:x-)?(?:javascript|ecmascript|jscript|livescript)|text\/css|application\/wasm|text\/xsl|application\/xslt\+xml)\b/;

export function sendError(res: ServerResponse, status: number, error: string, message: string): void {
  if (res.destroyed || res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error, message }));
}

/** Sends one prepared request and streams the answer into `res`. */
export function relayHttp(session: ProxySession, input: {
  method: string;
  path: string;
  headers: OutgoingHttpHeaders;
  body: Buffer | null;
  res: ServerResponse;
  /** Set while other forwards wait behind this one: the longest wait for the
   *  answer. A caller that leaves does not end that wait early, because the
   *  request may still be on its way to the other server. */
  headerTimeoutMs?: number;
  /** Once, when the answer's status is known, or with 0 when there is none. */
  answered(status: number): void;
  /** Registers a way to cut the exchange; returns its removal. */
  track(cut: () => void): () => void;
  unavailable: string;
}): Promise<void> {
  const { res } = input;
  return new Promise((resolve) => {
    let settled = false;
    const answered = (status: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.answered(status);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (res.destroyed) {
      answered(0);
      resolve();
      return;
    }
    let upstream: ReturnType<typeof request>;
    try {
      upstream = request({
        host: LOOPBACK, port: session.port, method: input.method, path: input.path, agent: false,
        headers: { ...input.headers, cookie: session.cookie },
      });
    } catch {
      sendError(res, 400, "invalid-input", "That request cannot be forwarded.");
      answered(0);
      resolve();
      return;
    }
    if (input.headerTimeoutMs) {
      timer = setTimeout(() => upstream.destroy(failure("transport-timeout")), input.headerTimeoutMs);
    }
    const untrack = input.track(() => {
      upstream.destroy();
      if (res.headersSent) res.destroy();
      else sendError(res, 503, "unavailable", input.unavailable);
    });
    upstream.once("close", () => {
      answered(0);
      untrack();
    });
    res.once("close", () => {
      if (!res.writableFinished && (settled || !input.headerTimeoutMs)) upstream.destroy();
      resolve();
    });
    upstream.once("response", (incoming) => {
      answered(incoming.statusCode ?? 502);
      incoming.on("error", () => res.destroy());
      incoming.once("close", () => { if (!incoming.complete) res.destroy(); });
      if (res.destroyed || res.headersSent) {
        incoming.destroy();
        return;
      }
      res.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers));
      incoming.pipe(res);
    });
    upstream.on("error", () => {
      answered(0);
      // A cut exchange already has its whole answer on the way.
      if (!res.writableEnded) sendError(res, 503, "unavailable", input.unavailable);
    });
    upstream.end(input.body ?? undefined);
  });
}

export function refuseUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed || socket.writableEnded) return;
  const reason = status === 404 ? "Not Found" : status === 403 ? "Forbidden" : "Service Unavailable";
  socket.on("error", () => {});
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  setTimeout(() => socket.destroy(), HALF_CLOSE_GRACE_MS).unref();
}

/** Opens the upgrade on the proxy and, once it answers 101, pipes both ways.
 *  Resolves when the answer is in (or there will be none). */
export function relayUpgrade(session: ProxySession, input: {
  path: string;
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  timeoutMs: number;
  track(cut: () => void): () => void;
}): Promise<void> {
  const { socket } = input;
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const upstream = createConnection({ host: LOOPBACK, port: session.port });
    let open = false;
    let buffered = Buffer.alloc(0);
    const cut = (): void => {
      upstream.destroy();
      if (open) socket.destroy();
      else refuseUpgrade(socket, 503);
    };
    const untrack = input.track(cut);
    const timer = setTimeout(() => { cut(); }, input.timeoutMs);
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const closed = (): void => {
      untrack();
      settle();
    };
    socket.on("error", () => { upstream.destroy(); socket.destroy(); });
    socket.once("close", () => { upstream.destroy(); closed(); });
    upstream.on("error", () => cut());
    upstream.once("close", () => {
      if (open) setTimeout(() => socket.destroy(), HALF_CLOSE_GRACE_MS).unref();
      else refuseUpgrade(socket, 503);
      closed();
    });
    upstream.once("connect", () => {
      const lines = [
        `GET ${input.path} HTTP/1.1`,
        `Host: ${LOOPBACK}:${session.port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Cookie: ${session.cookie}`,
      ];
      for (const name of UPGRADE_HEADERS) {
        const value = input.req.headers[name];
        if (typeof value === "string") lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    const onAnswer = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > UPGRADE_HEAD_LIMIT) cut();
        return;
      }
      upstream.off("data", onAnswer);
      const [statusLine = "", ...headers] = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      if (status !== 101 || socket.destroyed) {
        refuseUpgrade(socket, status === 403 || status === 404 ? status : 503);
        upstream.destroy();
        settle();
        return;
      }
      open = true;
      const kept = headers.filter((line) => !/^set-cookie2?\s*:/i.test(line));
      socket.write(`${[statusLine, ...kept].join("\r\n")}\r\n\r\n`, "latin1");
      const rest = buffered.subarray(end + 4);
      if (rest.length) socket.write(rest);
      if (input.head.length) upstream.write(input.head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.once("end", () => setTimeout(() => socket.destroy(), HALF_CLOSE_GRACE_MS).unref());
      settle();
    };
    upstream.on("data", onAnswer);
  });
}

/** Orders changes of the other server's remembered Space against requests that
 *  depend on it: any number of `shared` holders, or one `exclusive`, first
 *  come first served. Each returns its release. */
export function createSpaceGate(): {
  shared(): Promise<() => void>;
  exclusive(): Promise<() => void>;
} {
  let writers: Promise<void> = Promise.resolve();
  let readers = new Set<Promise<void>>();
  const hold = (): { held: Promise<void>; release: () => void } => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    return { held, release };
  };
  return {
    async shared() {
      const before = writers;
      const mine = hold();
      const group = readers;
      group.add(mine.held);
      await before;
      return () => {
        group.delete(mine.held);
        mine.release();
      };
    },
    async exclusive() {
      const before = writers;
      const ahead = readers;
      readers = new Set();
      const mine = hold();
      writers = before.then(() => mine.held);
      await before;
      await Promise.all(ahead);
      return mine.release;
    },
  };
}
