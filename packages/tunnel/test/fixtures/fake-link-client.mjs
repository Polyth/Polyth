#!/usr/bin/env node
// A stand-in for `polyth-link-client stdio <dataDir>`: the same JSON-lines
// requests, a loopback proxy whose session cookie is claimed by a POST of the
// bootstrap URL, and the Link transport's header rules. The "other server" is
// an HTTP server of the test; the pairing ticket carries its port.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [, , mode, dataDir] = process.argv;
if (mode !== "stdio") process.exit(2);
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "pid"), String(process.pid));
writeFileSync(join(dataDir, "env.json"), JSON.stringify(Object.keys(process.env)));
const note = (file, value) => appendFileSync(join(dataDir, file), `${JSON.stringify(value)}\n`);

const store = join(dataDir, "connections.json");
const saved = () => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : []);
const write = (list) => writeFileSync(store, JSON.stringify(list));
const find = (id) => saved().find((item) => item.id === id);

const REQUEST_ALLOW = [
  "accept", "accept-encoding", "accept-language", "content-type", "cache-control",
  "if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "if-range", "range",
];
const RESPONSE_ALLOW = [
  "content-type", "cache-control", "etag", "last-modified", "content-range", "accept-ranges",
  "content-disposition", "content-encoding", "vary", "x-content-type-options",
];

const sessions = new Map();
const attempts = new Map();
const failure = (code) => Object.assign(new Error(code), { code });
/** The test's switch for a lost link: a file that exists while it is down. */
const down = (item) => Boolean(item.downFile && existsSync(item.downFile));

function forwardHeaders(item, headers) {
  // `legacy` is the transport before it let the Space choice cross.
  const allow = item.legacy ? REQUEST_ALLOW : [...REQUEST_ALLOW, "x-polyth-space"];
  return Object.fromEntries(Object.entries(headers).filter(([name]) => allow.includes(name)));
}

async function open(item) {
  const known = sessions.get(item.id);
  if (known) {
    known.nonce = randomBytes(32).toString("hex");
    return known;
  }
  const session = { nonce: randomBytes(32).toString("hex"), secret: randomBytes(32).toString("hex") };
  const allowed = (req) => req.headers.host === `127.0.0.1:${session.port}`
    && (req.headers.origin === undefined || req.headers.origin === session.origin);
  const signedIn = (req) => (req.headers.cookie ?? "").split(";")
    .some((part) => part.trim() === `polyth_link_proxy_${session.port}=${session.secret}`);
  const server = createServer((req, res) => {
    const plain = (status, extra = {}) => { res.writeHead(status, { ...extra, connection: "close" }); res.end(); };
    if (!allowed(req)) return plain(403);
    if (req.url.startsWith("/__polyth_boot/")) {
      if (req.method === "GET") return plain(200);
      if (req.method !== "POST" || req.url !== `/__polyth_boot/${session.nonce}`) return plain(400);
      session.nonce = null;
      return plain(204, { "set-cookie": `polyth_link_proxy_${session.port}=${session.secret}; Path=/; HttpOnly; SameSite=Strict` });
    }
    if (!signedIn(req)) return plain(401);
    note("requests.jsonl", { method: req.method, path: req.url, headers: req.headers });
    if (req.headers["transfer-encoding"]) return plain(400);
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (mutation && req.headers["content-length"] === undefined) return plain(411);
    if (down(item)) return plain(502);
    const upstream = request({
      host: "127.0.0.1", port: item.port, method: req.method, path: req.url, agent: false,
      headers: {
        ...forwardHeaders(item, req.headers),
        host: "polyth.local",
        "content-length": req.headers["content-length"] ?? "0",
      },
    });
    upstream.on("response", (answer) => {
      // `leaky` passes every header back, to prove the caller strips them too.
      res.writeHead(answer.statusCode, item.leaky ? answer.headers
        : Object.fromEntries(Object.entries(answer.headers).filter(([name]) => RESPONSE_ALLOW.includes(name))));
      answer.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (!allowed(req) || !signedIn(req) || req.headers["sec-websocket-version"] !== "13" || !req.headers["sec-websocket-key"]) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    note("requests.jsonl", { method: "UPGRADE", path: req.url, headers: req.headers });
    const upstream = connect(item.port, "127.0.0.1", () => {
      // Only the path and protocols cross the link.
      const protocols = req.headers["sec-websocket-protocol"];
      upstream.write(`GET ${req.url} HTTP/1.1\r\nHost: polyth.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${req.headers["sec-websocket-key"]}\r\n${protocols ? `Sec-WebSocket-Protocol: ${protocols}\r\n` : ""}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    session.sockets.add(socket);
  });
  session.sockets = new Set();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  session.port = server.address().port;
  session.origin = `http://127.0.0.1:${session.port}`;
  session.server = server;
  sessions.set(item.id, session);
  return session;
}

function close(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  for (const socket of session.sockets) socket.destroy();
  session.server.close();
  session.server.closeAllConnections();
}

const opened = (id, session) => {
  const bootstrapUrl = `${session.origin}/__polyth_boot/${session.nonce}`;
  return { connectionId: id, origin: session.origin, bootstrap: bootstrapUrl, bootstrapUrl };
};

const parse = (ticket) => {
  if (typeof ticket !== "string" || !ticket.startsWith("fake:")) throw failure("pairing-invalid");
  return JSON.parse(Buffer.from(ticket.slice(5), "base64url").toString("utf8"));
};

const methods = {
  "pairing.parse": ({ ticket }) => {
    const parsed = parse(ticket);
    return { hostLabel: parsed.label, hostFingerprint: `${parsed.id.slice(0, 4)}…${parsed.id.slice(-4)}`, expiresAt: 4102444800000 };
  },
  "pairing.begin": ({ ticket, label }) => {
    const parsed = parse(ticket);
    const attemptId = randomBytes(8).toString("hex");
    attempts.set(attemptId, parsed);
    note("labels.jsonl", label);
    return { attemptId, safetyPhrase: ["amber", "river", "stone"], state: "safety-ready" };
  },
  "pairing.confirm": async ({ attemptId }) => {
    const parsed = attempts.get(attemptId);
    if (!parsed) throw failure("pairing-invalid");
    attempts.delete(attemptId);
    close(parsed.id);
    const item = { ...parsed, customLabel: "", revoked: false };
    write([...saved().filter((other) => other.id !== item.id), item]);
    return opened(item.id, await open(item));
  },
  "pairing.cancel": ({ attemptId }) => {
    attempts.delete(attemptId);
    return { ok: true };
  },
  "connections.list": () => saved().map((item) => ({
    id: item.id, hostEndpointId: item.id, hostLabel: item.customLabel || item.label, revoked: item.revoked,
  })),
  "connections.rename": ({ connectionId, label }) => {
    const item = find(connectionId);
    if (!item) throw failure("device-unknown");
    write(saved().map((other) => (other.id === connectionId ? { ...other, customLabel: label } : other)));
    return { ok: true, hostLabel: label || item.label };
  },
  connect: async ({ connectionId }) => {
    const item = find(connectionId);
    if (!item) throw failure("device-unknown");
    if (down(item)) throw failure("transport-unavailable");
    return opened(connectionId, await open(item));
  },
  status: ({ connectionId }) => {
    const session = sessions.get(connectionId);
    if (!session) return { state: "disconnected" };
    return { state: "connected", reconnecting: down(find(connectionId)), origin: session.origin, connectionId };
  },
  disconnect: ({ connectionId }) => {
    close(connectionId);
    return { ok: true };
  },
  forget: ({ connectionId }) => {
    close(connectionId);
    write(saved().filter((item) => item.id !== connectionId));
    return { ok: true };
  },
};

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  note("calls.jsonl", method);
  let response;
  try {
    if (!methods[method]) throw failure("pairing-invalid");
    response = { id, result: await methods[method](params) };
  } catch (error) {
    response = { id, error: { code: error.code ?? "pairing-invalid" } };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
lines.on("close", () => process.exit(0));
