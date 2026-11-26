import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BUG_REPORT_LIMITS, bugReportStatus } from "@polyth/contracts/bug-report";
import { FEEDBACK_LIMITS, feedbackStatus } from "@polyth/contracts/feedback";

import type { ReportRelay } from "./index.ts";
import { INBOX_PAGE, INBOX_PAGE_HEADERS } from "./inboxPage.ts";

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export interface ReportRelayHttpOptions {
  testMode?: boolean;
  /** Explicit only: a reverse proxy is responsible for TLS before this HTTP listener. */
  tlsTerminated?: boolean;
  /** The proxy's address as this listener sees it: only its `X-Forwarded-For`
   *  names the sender for the per-source limit. */
  trustedProxy?: string;
}

export interface ReportRelayListenOptions extends ReportRelayHttpOptions {
  host: string;
  port: number;
}

function guard(options: ReportRelayHttpOptions): void {
  if (!options.testMode && !options.tlsTerminated) throw new Error("relay requires TLS termination");
}

export function createReportRelayHttpServer(relay: ReportRelay, options: ReportRelayHttpOptions = {}): Server {
  guard(options);
  const server = createServer((request, response) => { void route(relay, options, request, response); });
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 256;
  server.maxHeadersCount = 32;
  return server;
}

export async function startReportRelayHttpServer(relay: ReportRelay, options: ReportRelayListenOptions): Promise<Server> {
  guard(options);
  const loopback = options.host === "127.0.0.1" || options.host === "::1" || options.host === "localhost";
  if (options.testMode && !loopback) throw new Error("relay requires TLS termination; test mode binds loopback only");
  const server = createReportRelayHttpServer(relay, options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); });
  });
  return server;
}

/** The proxy appends the address it accepted the connection from, so only the
 *  last `X-Forwarded-For` entry is trusted; nothing here reaches the log. */
function sourceOf(request: IncomingMessage, trustedProxy: string | undefined): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  const forwarded = request.headers["x-forwarded-for"];
  if (!trustedProxy || peer.replace(/^::ffff:/, "") !== trustedProxy || typeof forwarded !== "string") return peer;
  const last = forwarded.split(",").at(-1)?.trim() ?? "";
  return /^[0-9A-Fa-f.:]{2,45}$/.test(last) ? last : peer;
}

async function route(relay: ReportRelay, options: ReportRelayHttpOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  try {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const path = url.pathname;
    if (request.method === "GET" && path === "/v1/health") {
      respond(response, 200, relay.health());
      relay.logRequest("health", "ok", 200, elapsed());
      return;
    }
    if (request.method === "GET" && path === "/inbox") {
      // The page itself is public and holds nothing; every read it makes needs the token.
      for (const [name, value] of Object.entries(INBOX_PAGE_HEADERS)) response.setHeader(name, value);
      response.statusCode = 200;
      response.setHeader("content-length", INBOX_PAGE.length);
      response.end(INBOX_PAGE);
      relay.logRequest("inbox", "page", 200, elapsed());
      return;
    }
    if (path === "/v1/feedback" || path === "/v1/feedback/forget") {
      await routeFeedback(relay, request, response, path, elapsed);
      return;
    }
    if (path === "/v1/inbox" || path.startsWith("/v1/inbox/")) {
      await routeInbox(relay, options, request, response, url, elapsed);
      return;
    }
    if (request.method !== "POST" || path !== "/v1/report") {
      respond(response, 404, { error: "not-found" });
      relay.logRequest("not-found", "not-found", 404, elapsed());
      return;
    }
    const body = await readJsonBody(request, response, BUG_REPORT_LIMITS.bodyBytes);
    if (body === null) {
      relay.logRequest("report", "invalid", 400, elapsed());
      return;
    }
    const result = await relay.report(body, sourceOf(request, options.trustedProxy), request.headers.authorization);
    const status = bugReportStatus(result.result);
    respond(response, status, result);
    relay.logRequest("report", result.result, status, elapsed());
  } catch {
    if (response.destroyed || response.writableEnded) return;
    respond(response, 503, { result: "unavailable" });
    relay.logRequest("report", "unavailable", 503, elapsed());
  }
}

/** The JSON body of a POST, or null after answering `400 invalid` itself:
 *  wrong content type, a declared or streamed size over the limit. */
async function readJsonBody(request: IncomingMessage, response: ServerResponse, limit: number): Promise<string | null> {
  if (!JSON_TYPE.test(request.headers["content-type"] ?? "")) {
    respond(response, 400, { result: "invalid" });
    return null;
  }
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    request.resume();
    respond(response, 400, { result: "invalid" });
    return null;
  }
  const body = await readBody(request, limit);
  if (body === null) respond(response, 400, { result: "invalid" });
  return body;
}

/** `POST /v1/feedback` takes feedback from anyone (no password, no account);
 *  `POST /v1/feedback/forget` erases what one install pseudonym sent. */
async function routeFeedback(
  relay: ReportRelay, request: IncomingMessage, response: ServerResponse, path: string, elapsed: () => number,
): Promise<void> {
  if (request.method !== "POST") {
    respond(response, 404, { error: "not-found" });
    relay.logRequest("not-found", "not-found", 404, elapsed());
    return;
  }
  const intake = relay.feedback;
  if (!intake) {
    respond(response, 503, { result: "unavailable" });
    relay.logRequest("feedback", "unavailable", 503, elapsed());
    return;
  }
  const body = await readJsonBody(request, response, FEEDBACK_LIMITS.bodyBytes);
  if (body === null) {
    relay.logRequest("feedback", "invalid", 400, elapsed());
    return;
  }
  if (path === "/v1/feedback/forget") {
    const outcome = intake.forget(body);
    const status = outcome.result === "forgotten" ? 200 : outcome.result === "invalid" ? 400 : 503;
    respond(response, status, outcome);
    relay.logRequest("feedback", outcome.result, status, elapsed());
    return;
  }
  const outcome = relay.off ? { result: "unavailable" as const } : intake.receive(body);
  const status = feedbackStatus(outcome.result);
  respond(response, status, outcome);
  relay.logRequest("feedback", outcome.result, status, elapsed());
}

const INBOX_REF = /^\/v1\/inbox\/(\d{1,9})(\/screenshot|\/github)?$/;

/** The team's read side: every route needs the inbox token. The public proxy
 *  does not forward these paths; the team server reaches the relay on its
 *  private address. */
async function routeInbox(
  relay: ReportRelay, options: ReportRelayHttpOptions, request: IncomingMessage, response: ServerResponse,
  url: URL, elapsed: () => number,
): Promise<void> {
  const finish = (status: number, body: unknown, result: string) => {
    respond(response, status, body);
    relay.logRequest("inbox", result, status, elapsed());
  };
  const intake = relay.feedback;
  if (!intake) return finish(503, { result: "unavailable" }, "unavailable");
  const auth = intake.authorize(request.headers.authorization, sourceOf(request, options.trustedProxy));
  if (auth === "denied") { request.resume(); return finish(401, { result: "token" }, "token"); }
  if (auth === "rate") { request.resume(); return finish(429, { result: "rate" }, "rate"); }
  if (auth === "unavailable") { request.resume(); return finish(503, { result: "unavailable" }, "unavailable"); }

  const path = url.pathname;
  if (request.method === "GET" && path === "/v1/inbox") {
    const page = intake.list(url.searchParams);
    return page ? finish(200, page, "ok") : finish(400, { result: "invalid" }, "invalid");
  }
  if (request.method === "GET" && path === "/v1/inbox/summary") {
    const summary = intake.summary(url.searchParams);
    return summary ? finish(200, summary, "ok") : finish(400, { result: "invalid" }, "invalid");
  }
  const match = INBOX_REF.exec(path);
  if (!match) return finish(404, { error: "not-found" }, "not-found");
  const ref = Number(match[1]);
  const tail = match[2];

  if (request.method === "GET" && tail === undefined) {
    const item = intake.get(ref);
    return item ? finish(200, item, "ok") : finish(404, { error: "not-found" }, "not-found");
  }
  if (request.method === "GET" && tail === "/screenshot") {
    const image = intake.screenshot(ref);
    if (!image) return finish(404, { error: "not-found" }, "not-found");
    response.statusCode = 200;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "image/jpeg");
    response.setHeader("content-length", image.length);
    response.end(image);
    relay.logRequest("inbox", "ok", 200, elapsed());
    return;
  }
  if (request.method === "POST" && tail === "/github") {
    request.resume();
    const filed = await intake.fileToGithub(ref);
    if (filed.ok) return finish(200, { result: "filed", issue: filed.issue }, "ok");
    return filed.reason === "not-found" ? finish(404, { error: "not-found" }, "not-found") : finish(503, { result: "unavailable" }, "unavailable");
  }
  if (request.method === "POST" && tail === undefined) {
    const body = await readJsonBody(request, response, 8_192);
    if (body === null) { relay.logRequest("inbox", "invalid", 400, elapsed()); return; }
    const updated = intake.update(ref, body);
    if (updated.ok) return finish(200, updated.item, "ok");
    return updated.reason === "not-found" ? finish(404, { error: "not-found" }, "not-found") : finish(400, { result: "invalid" }, "invalid");
  }
  return finish(404, { error: "not-found" }, "not-found");
}

/** Reads the body, keeping at most `limit` bytes. A body over the limit is
 *  drained (not destroyed) so the client still receives the 400 rather than a
 *  connection reset, and `null` says the request was refused. */
async function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  return await new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      if (over) return;
      bytes += chunk.length;
      if (bytes > limit) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(over ? null : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new Error("body")));
    request.on("aborted", () => reject(new Error("aborted")));
  });
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(json));
  response.end(json);
}
