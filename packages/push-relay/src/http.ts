import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { PushRelay } from "./index.ts";
import { RelayFault } from "./types.ts";

const MAX_BODY = 8 * 1024;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export interface RelayHttpOptions {
  testMode?: boolean;
  /** Explicit only: a reverse proxy is responsible for TLS before this HTTP listener. */
  tlsTerminated?: boolean;
  /** The proxy's address as this listener sees it: only its `X-Forwarded-For`
   *  names the sender for the per-source limit. */
  trustedProxy?: string;
}

export interface RelayListenOptions extends RelayHttpOptions {
  host: string;
  port: number;
}

export function createRelayHttpServer(relay: PushRelay, options: RelayHttpOptions = {}): Server {
  if (!options.testMode && !options.tlsTerminated) throw new Error("relay requires TLS termination");
  const server = createServer((request, response) => { void route(relay, options, request, response); });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 512;
  server.maxHeadersCount = 32;
  return server;
}

export async function startRelayHttpServer(relay: PushRelay, options: RelayListenOptions): Promise<Server> {
  const loopback = options.host === "127.0.0.1" || options.host === "::1" || options.host === "localhost";
  if ((!options.testMode && !options.tlsTerminated) || (options.testMode && !loopback)) {
    throw new Error("relay requires TLS termination; test mode binds loopback only");
  }
  const server = createRelayHttpServer(relay, options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); });
  });
  return server;
}

/** The proxy appends the address it accepted the connection from, so only the last entry is trusted. */
function sourceOf(request: IncomingMessage, trustedProxy: string | undefined): string {
  const peer = request.socket.remoteAddress ?? "unknown";
  const forwarded = request.headers["x-forwarded-for"];
  if (!trustedProxy || peer.replace(/^::ffff:/, "") !== trustedProxy || typeof forwarded !== "string") return peer;
  const last = forwarded.split(",").at(-1)?.trim() ?? "";
  return /^[0-9A-Fa-f.:]{2,45}$/.test(last) ? last : peer;
}

async function route(relay: PushRelay, options: RelayHttpOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const abort = new AbortController();
  request.once("aborted", () => abort.abort());
  response.once("close", () => { if (!response.writableEnded) abort.abort(); });
  try {
    if (request.method === "GET" && request.url === "/v1/health") { respond(response, 200, { ok: true }); return; }
    if (request.method !== "POST" || request.url !== "/v1/send") throw new RelayFault("not-found");
    respond(response, 200, await relay.send(await json(request), sourceOf(request, options.trustedProxy), abort.signal));
  } catch (error) {
    // IncomingMessage may already report destroyed after a fully consumed body;
    // only the outgoing socket determines whether an error can still be sent.
    if (response.destroyed || response.writableEnded) return;
    const fault = error instanceof RelayFault ? error : new RelayFault("unavailable");
    const status = fault.code === "invalid" ? 400 : fault.code === "not-found" ? 404 : fault.code === "rate" ? 429 : 503;
    respond(response, status, { error: fault.code === "invalid" ? "invalid-request" : fault.code === "rate" ? "rate-limited" : fault.code });
  }
}

async function json(request: IncomingMessage): Promise<unknown> {
  if (!JSON_TYPE.test(request.headers["content-type"] ?? "")) throw new RelayFault("invalid");
  const contentLength = request.headers["content-length"];
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY)) throw new RelayFault("invalid");
  const chunks: Buffer[] = [];
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    request.on("aborted", () => reject(new RelayFault("invalid")));
    request.on("error", () => reject(new RelayFault("invalid")));
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        request.destroy();
        reject(new RelayFault("invalid"));
      } else chunks.push(chunk);
    });
    request.on("end", resolve);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new RelayFault("invalid"); }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(json));
  response.end(json);
}
