import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BUG_REPORT_LIMITS, bugReportStatus } from "@polyth/contracts/bug-report";

import type { ReportRelay } from "./index.ts";

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
    if (request.method === "GET" && request.url === "/v1/health") {
      respond(response, 200, relay.health());
      relay.logRequest("health", "ok", 200, elapsed());
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/report") {
      respond(response, 404, { error: "not-found" });
      relay.logRequest("not-found", "not-found", 404, elapsed());
      return;
    }
    if (!JSON_TYPE.test(request.headers["content-type"] ?? "")) {
      respond(response, 400, { result: "invalid" });
      relay.logRequest("report", "invalid", 400, elapsed());
      return;
    }
    const declared = request.headers["content-length"];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > BUG_REPORT_LIMITS.bodyBytes)) {
      request.resume();
      respond(response, 400, { result: "invalid" });
      relay.logRequest("report", "invalid", 400, elapsed());
      return;
    }
    const body = await readBody(request, BUG_REPORT_LIMITS.bodyBytes);
    if (body === null) {
      respond(response, 400, { result: "invalid" });
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
