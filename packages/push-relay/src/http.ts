import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { PushRelay } from "./index.ts";
import { RelayFault } from "./types.ts";

const MAX_BODY = 8 * 1024;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export interface RelayHttpOptions {
  testMode?: boolean;
  /** Explicit only: a reverse proxy is responsible for TLS before this HTTP listener. */
  tlsTerminated?: boolean;
}

export interface RelayListenOptions extends RelayHttpOptions {
  host: string;
  port: number;
}

export function createRelayHttpServer(relay: PushRelay, options: RelayHttpOptions = {}): Server {
  if (!options.testMode && !options.tlsTerminated) throw new Error("relay requires TLS termination");
  const server = createServer((request, response) => { void route(relay, request, response); });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
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

async function route(relay: PushRelay, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const sourceIp = request.socket.remoteAddress ?? "unknown";
  const abort = new AbortController();
  request.once("aborted", () => abort.abort());
  response.once("close", () => { if (!response.writableEnded) abort.abort(); });
  try {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    if (url.search) throw new RelayFault("invalid");
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "POST" && url.pathname === "/v1/registrations") {
      respond(response, 201, relay.register(await json(request), sourceIp));
      return;
    }
    if (parts.length === 3 && parts[0] === "v1" && parts[1] === "registrations") {
      const subscriptionId = parts[2]!;
      const manage = bearer(request);
      if (request.method === "PUT") {
        await relay.rotate(subscriptionId, manage, await json(request));
        respond(response, 204);
        return;
      }
      if (request.method === "DELETE") {
        await relay.revoke(subscriptionId, manage);
        respond(response, 204);
        return;
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/claims/redeem") {
      respond(response, 200, relay.redeem(await json(request), sourceIp));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/deliver") {
      respond(response, 202, await relay.deliver(bearer(request), await json(request), sourceIp, abort.signal));
      return;
    }
    if (parts.length === 3 && parts[0] === "v1" && parts[1] === "senders" && request.method === "DELETE") {
      await relay.revokeSender(parts[2]!, bearer(request));
      respond(response, 204);
      return;
    }
    throw new RelayFault("not-found");
  } catch (error) {
    // IncomingMessage may already report destroyed after a fully consumed body;
    // only the outgoing socket determines whether an error can still be sent.
    if (response.destroyed || response.writableEnded) return;
    const fault = error instanceof RelayFault ? error : new RelayFault("unavailable");
    const status = fault.code === "invalid" ? 400
      : fault.code === "unauthorized" ? 401
        : fault.code === "not-found" ? 404
          : fault.code === "rate" ? 429
            : fault.code === "storage" ? 503 : 503;
    respond(response, status, { error: errorCode(fault) });
  }
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (typeof value !== "string") throw new RelayFault("unauthorized");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) throw new RelayFault("unauthorized");
  return match[1]!;
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

function respond(response: ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  if (body === undefined) { response.end(); return; }
  const json = JSON.stringify(body);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(json));
  response.end(json);
}

const errorCode = (fault: RelayFault): string => {
  switch (fault.code) {
    case "invalid": return "invalid-request";
    case "unauthorized": return "unauthorized";
    case "not-found": return "not-found";
    case "rate": return "rate-limited";
    case "storage": return "unavailable";
    case "unavailable": return "unavailable";
  }
};
