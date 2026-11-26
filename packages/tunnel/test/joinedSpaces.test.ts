import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { AuthPrincipal, RequestIngress, RouteRequest } from "@polyth/contracts";
import { isJoinedSpaceId } from "@polyth/plugins";
import { createJoinedSpaces, FORWARD_BODY_LIMIT, type JoinedSpaces } from "../src/joinedSpaces.ts";
import { joinedRoutes } from "../src/joinedRoutes.ts";
import { resolveClientBinary } from "../src/joinedClient.ts";
import { TUNNEL_REMOTE_ACCESS } from "../src/serverEntry.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-link-client.mjs");
const HOST_ID = "abcd0000000000000000000000001234";
const MAYA = "usr_maya";
const NOOR = "usr_noor";

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

interface Seen { method: string; path: string; headers: IncomingHttpHeaders; space: string; body: string }

/** The other Polyth server, as far as a paired device can tell. */
async function remoteServer(t: TestContext, spaceIds: string[] = ["spc_one", "spc_two"]) {
  const state = { active: spaceIds[0]!, viewOnly: false, activateDelayMs: 0, seen: [] as Seen[] };
  const sockets = new Set<Duplex>();
  const spaceOf = (req: IncomingMessage): string => String(req.headers["x-polyth-space"] ?? state.active);
  const spacesState = (activeSpaceId: string) => ({
    user: { id: "usr_there" },
    spaces: spaceIds.map((id, index) => ({ id, name: `Space ${index + 1}`, color: "#123456", role: "member", memberCount: 2 + index })),
    activeSpaceId,
    deployment: "personal",
    canCreate: false,
  });
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const space = spaceOf(req);
      state.seen.push({ method: req.method!, path: req.url!, headers: req.headers, space, body });
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(value));
      };
      if (!spaceIds.includes(space)) return json(404, { error: "not-found" });
      const activate = req.url!.match(/^\/api\/spaces\/([^/]+)\/activate$/);
      if (activate) {
        if (state.viewOnly) return json(403, { error: "forbidden" });
        setTimeout(() => {
          state.active = activate[1]!;
          json(200, spacesState(state.active));
        }, state.activateDelayMs);
        return;
      }
      if (req.url === "/api/spaces") return json(200, spacesState(space));
      if (req.url === "/api/package-assets/evil.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end("document.title = 'ran here'");
        return;
      }
      json(201, { space, body }, {
        "set-cookie": "remote_session=remote-secret; Path=/",
        "clear-site-data": "\"*\"",
        etag: "\"v1\"",
      });
    });
  });
  const upgrades: string[] = [];
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    upgrades.push(spaceOf(req));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: remote_session=remote-secret\r\n\r\nhello from ${spaceOf(req)};`);
    socket.on("data", (chunk) => socket.write(`echo ${chunk.toString()};`));
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close();
  });
  return { port, state, upgrades };
}

const ticket = (value: Record<string, unknown>): string =>
  `fake:${Buffer.from(JSON.stringify({ id: HOST_ID, label: "Studio", ...value })).toString("base64url")}`;

const rootFor = (t: TestContext): string => {
  const root = mkdtempSync(join(tmpdir(), "polyth-joined-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

function manager(t: TestContext, root: string, timing: Record<string, number> = {}): JoinedSpaces {
  const joined = createJoinedSpaces({
    rootDir: () => join(root, "joined"),
    deviceLabel: () => "Home server",
    env: { ...process.env, POLYTH_LINK_CLIENT: FAKE, ANTHROPIC_API_KEY: "not-for-the-client" },
    timing: { statusMs: 30, retryMinMs: 30, retryMaxMs: 200, ...timing },
  });
  joined.start();
  t.after(() => joined.stop());
  return joined;
}

const userDir = (root: string, userId: string): string =>
  join(root, "joined", createHash("sha256").update(userId).digest("hex").slice(0, 32));

const lines = (file: string): any[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];

async function pair(joined: JoinedSpaces, userId: string, value: Record<string, unknown>) {
  const { attemptId } = await joined.begin(userId, ticket(value));
  return joined.confirm(userId, attemptId);
}

/** This server's own HTTP front, handing everything to the service. */
async function front(t: TestContext, joined: JoinedSpaces) {
  const server = createServer((req, res) => {
    const [, userId, spaceId, ...rest] = req.url!.split("/");
    void joined.service.forwardHttp(userId!, spaceId!, { method: req.method!, path: `/${rest.join("/")}`, req, res });
  });
  server.on("upgrade", (req, socket, head) => {
    const [, userId, spaceId, ...rest] = req.url!.split("/");
    void joined.service.forwardUpgrade(userId!, spaceId!, { path: `/${rest.join("/")}`, req, socket, head });
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const call = (userId: string, spaceId: string, path: string, init: {
    method?: string; headers?: Record<string, string>; chunks?: string[];
  } = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/${userId}/${spaceId}${path}`, method: init.method ?? "GET", headers: init.headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: body ? (() => { try { return JSON.parse(body); } catch { return body; } })() : null }));
    });
    req.on("error", reject);
    for (const chunk of init.chunks ?? []) req.write(chunk);
    req.end();
  });

  const upgrade = (userId: string, spaceId: string) => {
    const socket = connect(port, "127.0.0.1");
    t.after(() => socket.destroy());
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("error", () => {});
    socket.write(`GET /${userId}/${spaceId}/ws HTTP/1.1\r\nHost: here.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: here=mine\r\nAuthorization: Bearer mine\r\nOrigin: https://here.example\r\nX-Forwarded-For: 203.0.113.9\r\n\r\n`);
    return { socket, received: () => received };
  };
  return { port, call, upgrade };
}

test("the client binary override wins and a missing one resolves to nothing", () => {
  assert.equal(resolveClientBinary({ env: { POLYTH_LINK_CLIENT: FAKE } }), FAKE);
  assert.equal(resolveClientBinary({ env: {}, exists: () => false }), null);
  assert.equal(
    resolveClientBinary({ env: {}, resourcesDir: "/res", platform: "linux", exists: (path) => path.startsWith("/res") }),
    join("/res", "polyth-link", "polyth-link-client"),
  );
});

test("the newer local build wins, so a months-old release build cannot shadow today's debug build", () => {
  const release = join("/repo", "target", "release", "polyth-link-client");
  const debug = join("/repo", "target", "debug", "polyth-link-client");
  const lookup = (times: Record<string, number>, resourcesDir?: string) => resolveClientBinary({
    env: {}, platform: "linux", repoRoot: "/repo", ...(resourcesDir ? { resourcesDir } : {}),
    exists: (path) => path in times, modifiedAt: (path) => times[path] ?? 0,
  });
  assert.equal(lookup({ [release]: 100, [debug]: 200 }), debug);
  assert.equal(lookup({ [release]: 300, [debug]: 200 }), release);
  assert.equal(lookup({ [release]: 200, [debug]: 200 }), release);
  assert.equal(lookup({ [debug]: 200 }), debug);
  const packaged = join("/res", "polyth-link", "polyth-link-client");
  assert.equal(lookup({ [packaged]: 1, [release]: 100, [debug]: 200 }, "/res"), packaged);
});

test("a client that ends before answering is this server's problem, not the other server's", async (t) => {
  const root = rootFor(t);
  // What a client built before `stdio` existed does.
  const stale = join(root, "stale-link-client");
  writeFileSync(stale, "#!/bin/sh\necho \"unknown command $1\" >&2\nexit 2\n", { mode: 0o755 });
  const joined = createJoinedSpaces({
    rootDir: () => join(root, "joined"),
    deviceLabel: () => "Home server",
    env: { ...process.env, POLYTH_LINK_CLIENT: stale },
  });
  joined.start();
  t.after(() => joined.stop());
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });

  const answer = await call(joined, "POST", "/api/tunnel/joined/pair/parse", { body: { ticket: ticket({ port: 1 }) } });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error, "link-client-start-failed");
  assert.match(answer.body.message, /Link client on this server could not start/);
  assert.doesNotMatch(answer.body.message, /not reachable/);
  assert.match(String(logged.at(-1)?.[0]), /ended before answering \(exit code 2\)/);
});

test("pairing lists the other server's Spaces under derived ids", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const joined = manager(t, root);

  const parsed = await joined.parse(MAYA, ticket({ port: remote.port }));
  assert.equal(parsed.hostLabel, "Studio");
  const begun = await joined.begin(MAYA, ticket({ port: remote.port }));
  assert.deepEqual(begun.safetyPhrase, ["amber", "river", "stone"]);
  assert.equal(JSON.stringify(begun).includes("fake:"), false);
  const { server, spaces } = await joined.confirm(MAYA, begun.attemptId);

  assert.deepEqual(server, { connectionId: HOST_ID, label: "Studio", fingerprint: "abcd…1234", online: true });
  const expected = `rmt_${createHash("sha256").update(`${MAYA}\0${HOST_ID}\0spc_two`).digest("hex").slice(0, 24)}`;
  assert.equal(spaces[1]!.id, expected);
  assert.ok(spaces.every((space) => isJoinedSpaceId(space.id)));
  assert.deepEqual(spaces[1], {
    id: expected, name: "Space 2", color: "#123456", role: "member", memberCount: 3,
    serverLabel: "Studio", connectionId: HOST_ID, online: true, remoteUserId: "usr_there",
  });
  assert.deepEqual(joined.service.list(MAYA), spaces);
  assert.deepEqual(joined.service.get(MAYA, expected), spaces[1]);

  const dir = userDir(root, MAYA);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "client")).mode & 0o777, 0o700);
  const env = JSON.parse(readFileSync(join(dir, "client", "env.json"), "utf8")) as string[];
  assert.equal(env.some((name) => name === "ANTHROPIC_API_KEY" || name.startsWith("POLYTH_")), false);
  assert.deepEqual(lines(join(dir, "client", "labels.jsonl")), ["Home server"]);
});

test("another person sees nothing and cannot use the first person's attempt or ids", async (t) => {
  const remote = await remoteServer(t);
  const joined = manager(t, rootFor(t));
  const [space] = (await pair(joined, MAYA, { port: remote.port })).spaces;
  const pending = await joined.begin(MAYA, ticket({ port: remote.port, id: `ffff${HOST_ID.slice(4)}` }));
  const web = await front(t, joined);

  assert.deepEqual(joined.overview(NOOR), { servers: [], spaces: [] });
  assert.deepEqual(joined.service.list(NOOR), []);
  assert.equal(joined.service.get(NOOR, space!.id), undefined);
  await assert.rejects(joined.confirm(NOOR, pending.attemptId), { status: 404 });
  await assert.rejects(joined.cancel(NOOR, pending.attemptId), { status: 404 });
  await assert.rejects(joined.rename(NOOR, HOST_ID, "mine"), { status: 404 });
  await assert.rejects(joined.remove(NOOR, HOST_ID), { status: 404 });
  // Even with a client of their own, Noor's lookups never reach Maya's.
  await joined.begin(NOOR, ticket({ port: remote.port }));
  await assert.rejects(joined.confirm(NOOR, pending.attemptId), { status: 404 });
  const before = remote.state.seen.length;
  assert.equal((await web.call(NOOR, space!.id, "/api/echo")).status, 404);
  const foreign = web.upgrade(NOOR, space!.id);
  await until(() => foreign.received().startsWith("HTTP/1.1 404"), "the refused upgrade");
  assert.equal(remote.state.seen.length, before);

  await joined.cancel(MAYA, pending.attemptId);
  await assert.rejects(joined.confirm(MAYA, pending.attemptId), { status: 404 });
});

test("forwarded requests carry only the proxy session and the remote Space", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const joined = manager(t, root);
  const { spaces } = await pair(joined, MAYA, { port: remote.port, leaky: true });
  const web = await front(t, joined);

  // No content-length from the caller: the body is sent with one.
  const answer = await web.call(MAYA, spaces[1]!.id, "/api/echo?x=1", {
    method: "POST",
    chunks: ["streamed ", "body"],
    headers: {
      "content-type": "text/plain",
      cookie: "polyth_auth=here",
      authorization: "Bearer here",
      "x-polyth-csrf": "csrf",
      "x-polyth-space": "spc_local",
      origin: "https://here.example",
      referer: "https://here.example/",
      forwarded: "for=203.0.113.9",
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.9",
      via: "1.1 here",
    },
  });
  assert.equal(answer.status, 201);
  assert.deepEqual(answer.body, { space: "spc_two", body: "streamed body" });
  assert.equal(answer.headers["set-cookie"], undefined);
  assert.equal(answer.headers["clear-site-data"], undefined);
  assert.equal(answer.headers["content-security-policy"], "sandbox");
  assert.equal(answer.headers["x-content-type-options"], "nosniff");
  assert.equal(answer.headers.etag, "\"v1\"");

  // A sandbox policy does not stop a module import: script from the other
  // server arrives as opaque bytes, which nosniff keeps from running here.
  const script = await web.call(MAYA, spaces[1]!.id, "/api/package-assets/evil.js", { method: "GET" });
  assert.equal(script.headers["content-type"], "application/octet-stream");
  assert.equal(script.headers["x-content-type-options"], "nosniff");

  const sent = lines(join(userDir(root, MAYA), "client", "requests.jsonl")).find((entry) => entry.path === "/api/echo?x=1");
  assert.match(sent.headers.cookie, /^polyth_link_proxy_\d+=[0-9a-f]{64}$/);
  assert.equal(sent.headers["x-polyth-space"], "spc_two");
  assert.equal(sent.headers["content-length"], "13");
  assert.match(sent.headers.host, /^127\.0\.0\.1:\d+$/);
  for (const name of ["authorization", "x-polyth-csrf", "origin", "referer", "forwarded", "x-forwarded-for", "x-real-ip", "via", "transfer-encoding"]) {
    assert.equal(sent.headers[name], undefined, name);
  }

  assert.equal((await web.call(MAYA, spaces[0]!.id, "/api/echo", { method: "DELETE" })).status, 201);
  const empty = lines(join(userDir(root, MAYA), "client", "requests.jsonl")).find((entry) => entry.method === "DELETE");
  assert.equal(empty.headers["content-length"], "0");

  const before = remote.state.seen.length;
  const large = await web.call(MAYA, spaces[0]!.id, "/api/echo", {
    method: "POST", headers: { "content-length": String(FORWARD_BODY_LIMIT + 1) },
  }).catch((error) => error);
  assert.equal(large.status, 413);
  assert.equal((await web.call(MAYA, spaces[0]!.id, "/__polyth/client-context")).status, 404);
  assert.equal((await web.call(MAYA, `rmt_${"0".repeat(24)}`, "/api/echo")).status, 404);
  assert.equal(remote.state.seen.length, before);
});

test("an upgrade selects the remote Space, then pipes both ways", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const joined = manager(t, root);
  const { spaces } = await pair(joined, MAYA, { port: remote.port });
  const web = await front(t, joined);

  const ws = web.upgrade(MAYA, spaces[1]!.id);
  await until(() => ws.received().includes("hello from spc_two;"), "the remote greeting");
  assert.match(ws.received(), /^HTTP\/1\.1 101 /);
  assert.doesNotMatch(ws.received(), /set-cookie/i);
  ws.socket.write("ping");
  await until(() => ws.received().includes("echo ping;"), "the echo");
  const activation = remote.state.seen.findLast((entry) => entry.method === "POST")!;
  assert.equal(activation.path, "/api/spaces/spc_two/activate");
  const sent = lines(join(userDir(root, MAYA), "client", "requests.jsonl")).find((entry) => entry.method === "UPGRADE");
  assert.match(sent.headers.cookie, /^polyth_link_proxy_/);
  for (const name of ["authorization", "origin", "x-forwarded-for"]) assert.equal(sent.headers[name], undefined, name);

  // Two Spaces at once: each socket lands in its own.
  remote.state.activateDelayMs = 40;
  const first = web.upgrade(MAYA, spaces[0]!.id);
  const second = web.upgrade(MAYA, spaces[1]!.id);
  await until(() => first.received().includes("hello from spc_one;") && second.received().includes("hello from spc_two;"), "both greetings");

  // A view-only device cannot switch, but may use the Space already selected.
  remote.state.viewOnly = true;
  const same = web.upgrade(MAYA, spaces[1]!.id);
  await until(() => same.received().includes("hello from spc_two;"), "the selected Space");
  const other = web.upgrade(MAYA, spaces[0]!.id);
  await until(() => other.received().startsWith("HTTP/1.1 403"), "the refusal");

  await joined.remove(MAYA, HOST_ID);
  await until(() => ws.socket.readableEnded || ws.socket.destroyed, "the socket to close with the connection");
});

test("an older other server only serves the Space it has selected", async (t) => {
  const remote = await remoteServer(t);
  const joined = manager(t, rootFor(t));
  const { spaces } = await pair(joined, MAYA, { port: remote.port, legacy: true });
  const web = await front(t, joined);
  const [one, two] = spaces;

  assert.equal((await web.call(MAYA, one!.id, "/api/echo")).body.space, "spc_one");
  const refused = await web.call(MAYA, two!.id, "/api/echo", { method: "POST" });
  assert.equal(refused.status, 503);
  assert.deepEqual(refused.body, {
    error: "unavailable", message: "The other Polyth server needs an update to open this Space here.",
  });
  assert.equal(remote.state.seen.some((entry) => entry.path === "/api/echo" && entry.method === "POST"), false);

  // A request for the old Space waits out the switch and is then refused,
  // never delivered into the new one.
  remote.state.activateDelayMs = 80;
  const ws = web.upgrade(MAYA, two!.id);
  await until(() => remote.state.seen.some((entry) => entry.path.endsWith("/spc_two/activate")), "the activation");
  const held = await web.call(MAYA, one!.id, "/api/late", { method: "POST" });
  assert.equal(held.status, 503);
  assert.equal(remote.state.seen.some((entry) => entry.path === "/api/late"), false);
  await until(() => ws.received().includes("hello from spc_two;"), "the greeting");
  assert.equal((await web.call(MAYA, two!.id, "/api/echo")).body.space, "spc_two");
});

test("a single remote Space needs no header support", async (t) => {
  const remote = await remoteServer(t, ["spc_only"]);
  const joined = manager(t, rootFor(t));
  const { spaces } = await pair(joined, MAYA, { port: remote.port, legacy: true });
  const web = await front(t, joined);
  assert.equal((await web.call(MAYA, spaces[0]!.id, "/api/echo")).status, 201);
  assert.equal(remote.state.seen.filter((entry) => entry.path === "/api/spaces").length, 1);
});

test("offline answers 503 without the other server, and the list survives a restart", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const downFile = join(root, "link-down");
  const joined = manager(t, root);
  const { spaces } = await pair(joined, MAYA, { port: remote.port, downFile });
  const web = await front(t, joined);

  writeFileSync(downFile, "");
  await until(() => joined.service.list(MAYA)[0]?.online === false, "offline");
  const before = remote.state.seen.length;
  const answer = await web.call(MAYA, spaces[0]!.id, "/api/echo", { method: "POST", chunks: ["x"] });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error, "unavailable");
  const ws = web.upgrade(MAYA, spaces[0]!.id);
  await until(() => ws.received().startsWith("HTTP/1.1 503"), "the refused upgrade");
  assert.equal(remote.state.seen.length, before);

  await joined.stop();
  assert.deepEqual(joined.service.list(MAYA), []);
  const again = manager(t, root);
  assert.deepEqual(again.service.list(MAYA), spaces.map((space) => ({ ...space, online: false })));
  rmSync(downFile);
  await until(() => again.service.list(MAYA)[0]?.online === true, "the connection to come back on its own");
});

test("a client that dies is started again", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const joined = manager(t, root, { retryMinMs: 150 });
  await pair(joined, MAYA, { port: remote.port });
  const pidFile = join(userDir(root, MAYA), "client", "pid");
  const first = Number(readFileSync(pidFile, "utf8"));
  process.kill(first, "SIGKILL");
  await until(() => joined.service.list(MAYA)[0]?.online === false, "offline");
  await until(() => joined.service.list(MAYA)[0]?.online === true, "online again");
  assert.notEqual(Number(readFileSync(pidFile, "utf8")), first);
});

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("removing an account stops its client and deletes its keys", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const joined = manager(t, root);
  await pair(joined, MAYA, { port: remote.port });
  await pair(joined, NOOR, { port: remote.port });
  const pid = Number(readFileSync(join(userDir(root, MAYA), "client", "pid"), "utf8"));
  assert.equal(alive(pid), true);

  await joined.removeAccount(MAYA);
  assert.equal(alive(pid), false);
  assert.equal(existsSync(userDir(root, MAYA)), false);
  assert.deepEqual(joined.service.list(MAYA), []);
  // Nothing brings it back while the account is going, and others stay.
  await assert.rejects(joined.parse(MAYA, ticket({ port: remote.port })), { status: 503 });
  assert.equal(existsSync(userDir(root, MAYA)), false);
  assert.equal(joined.service.list(NOOR).length, 2);
});

function call(joined: JoinedSpaces, method: string, path: string, init: {
  userId?: string; body?: Record<string, unknown>; principal?: AuthPrincipal; ingress?: RequestIngress;
} = {}) {
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const rc = {
    method,
    path,
    principal: init.principal ?? { kind: "ui-session", sessionId: "s", rememberedDeviceId: "d" },
    ingress: init.ingress ?? { kind: "public-http", listenerId: "public", loopback: false, secure: true },
    space: { userId: init.userId ?? MAYA },
    body: async () => init.body ?? {},
    json(status: number, body: unknown) { out.status = status; out.body = body; },
  } as unknown as RouteRequest;
  return Promise.resolve(joinedRoutes(joined)(rc)).then((handled) => ({ handled, ...out }));
}

test("routes pair, rename and forget a server for the signed-in person", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const joined = manager(t, root);
  const value = ticket({ port: remote.port });

  assert.equal((await call(joined, "POST", "/api/tunnel/joined/pair/parse", { body: { ticket: value } })).body.hostLabel, "Studio");
  const invalid = await call(joined, "POST", "/api/tunnel/joined/pair/parse", { body: { ticket: "nope" } });
  assert.deepEqual([invalid.status, invalid.body.error], [400, "pairing-invalid"]);
  const begun = (await call(joined, "POST", "/api/tunnel/joined/pair/begin", { body: { ticket: value } })).body;
  const foreign = await call(joined, "POST", "/api/tunnel/joined/pair/confirm", { userId: NOOR, body: { attemptId: begun.attemptId } });
  assert.equal(foreign.status, 404);
  const confirmed = await call(joined, "POST", "/api/tunnel/joined/pair/confirm", { body: { attemptId: begun.attemptId } });
  assert.equal(confirmed.body.spaces.length, 2);

  const renamed = await call(joined, "PATCH", `/api/tunnel/joined/${HOST_ID}`, { body: { label: "Work" } });
  assert.equal(renamed.body.server.label, "Work");
  const overview = (await call(joined, "GET", "/api/tunnel/joined")).body;
  assert.equal(overview.servers[0].label, "Work");
  assert.equal(overview.spaces[0].serverLabel, "Work");
  assert.equal((await call(joined, "DELETE", `/api/tunnel/joined/${HOST_ID}`, { userId: NOOR })).status, 404);

  const pid = Number(readFileSync(join(userDir(root, MAYA), "client", "pid"), "utf8"));
  assert.deepEqual((await call(joined, "DELETE", `/api/tunnel/joined/${HOST_ID}`)).body, { ok: true });
  assert.ok(lines(join(userDir(root, MAYA), "client", "calls.jsonl")).includes("forget"));
  assert.deepEqual((await call(joined, "GET", "/api/tunnel/joined")).body, { servers: [], spaces: [] });
  assert.equal(alive(pid), false);
  assert.equal((await call(joined, "GET", "/api/tunnel/status")).handled, false);
});

test("joined routes are for a signed-in person on this server only", async (t) => {
  const root = rootFor(t);
  const joined = manager(t, root);
  const paired: AuthPrincipal = {
    kind: "paired-device", deviceId: "d", deviceEndpointId: "e", connectionId: "c",
    transport: "direct", grants: ["*"], grantRevision: 1,
  };
  const refused: Array<{ principal?: AuthPrincipal; ingress?: RequestIngress }> = [
    { principal: paired },
    { principal: paired, ingress: { kind: "polyth-link", connectionId: "c", transport: "direct" } },
    { principal: { kind: "access-token", tokenId: "t" } as unknown as AuthPrincipal },
    { principal: { kind: "internal-service", serviceId: "s" } as unknown as AuthPrincipal },
    { ingress: { kind: "polyth-link", connectionId: "c", transport: "direct" } },
    { principal: { kind: "local-user", trustedLoopback: true } },
  ];
  for (const init of refused) {
    for (const [method, path] of [["GET", ""], ["POST", "/pair/begin"], ["DELETE", `/${HOST_ID}`]] as const) {
      await assert.rejects(call(joined, method, `/api/tunnel/joined${path}`, init), { code: "forbidden" });
    }
  }
  await assert.rejects(call(joined, "GET", "/api/tunnel/joined", { principal: { kind: "anonymous" } }), { code: "unauthorized" });
  const local = await call(joined, "GET", "/api/tunnel/joined", {
    principal: { kind: "local-user", trustedLoopback: true },
    ingress: { kind: "public-http", listenerId: "public", loopback: true, secure: false },
  });
  assert.equal(local.status, 200);
  assert.equal(existsSync(join(root, "joined")), false);
  assert.equal(TUNNEL_REMOTE_ACCESS.http.some((rule) => rule.path.startsWith("/api/tunnel/joined")), false);
});
