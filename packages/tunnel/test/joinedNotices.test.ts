// A person's notifications on a joined server reach them here: live over one
// socket per Space, caught up after being offline, withdrawn when read or
// cleared there, and gone with the connection.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationRecord } from "@polyth/contracts";
import { WebSocketServer, type WebSocket } from "ws";
import { createJoinedSpaces, joinedSpaceId } from "../src/joinedSpaces.ts";
import { NOTICE_CATCH_UP, NOTICE_MAX_AGE_MS } from "../src/joinedNotices.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-link-client.mjs");
const HOST_ID = "abcd0000000000000000000000001234";
const MAYA = "usr_maya";
const SPACES = ["spc_one", "spc_two"];

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
const pause = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

let serial = 0;
const row = (key: string, over: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: `ntf_${++serial}`, key, kind: "completed", sessionId: "ses_1", projectId: "prj_1",
  title: `Title ${key}`, body: "Done", ts: Date.now() + serial, read: false, ...over,
});

/** The other server: lists and live frames belong to one Space. */
async function remoteServer(t: TestContext) {
  const state = { active: SPACES[0]!, activations: [] as string[] };
  const inbox = new Map<string, NotificationRecord[]>(SPACES.map((id) => [id, []]));
  const sockets = new Map<WebSocket, string>();
  const spaceOf = (req: IncomingMessage) => String(req.headers["x-polyth-space"] ?? state.active);
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const space = spaceOf(req);
      const json = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const activate = req.url!.match(/^\/api\/spaces\/([^/]+)\/activate$/);
      if (activate) {
        state.active = activate[1]!;
        state.activations.push(state.active);
      }
      if (req.url!.startsWith("/api/spaces")) {
        return json({
          activeSpaceId: activate ? state.active : space,
          spaces: SPACES.map((id, index) => ({ id, name: `Space ${index + 1}`, role: "member", memberCount: 2 })),
        });
      }
      if (req.url === "/api/notifications") return json({ items: inbox.get(space), unread: 0 });
      if (req.url === "/api/notifications/read-all") {
        inbox.set(space, inbox.get(space)!.map((item) => ({ ...item, read: true })));
        return json({ updated: 1, unread: 0 });
      }
      res.writeHead(404);
      res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const space = state.active;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, space);
      ws.on("close", () => sockets.delete(ws));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const ws of sockets.keys()) ws.terminate();
    server.closeAllConnections();
    server.close();
  });
  /** Raises a notification: into the list, and live on that Space's sockets. */
  const raise = (space: string, record: NotificationRecord): NotificationRecord => {
    inbox.get(space)!.push(record);
    for (const [ws, bound] of sockets) {
      if (bound === space) ws.send(JSON.stringify({ type: "notification/added", notification: record }));
    }
    return record;
  };
  const watched = () => [...sockets.values()].sort();
  return { port: (server.address() as AddressInfo).port, state, inbox, raise, watched };
}

function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "polyth-joined-notices-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function manager(t: TestContext, root: string, timing: Record<string, number> = {}) {
  const delivered: Array<{ userId: string; record: NotificationRecord }> = [];
  const withdrawn: string[] = [];
  const joined = createJoinedSpaces({
    rootDir: () => join(root, "joined"),
    deviceLabel: () => "Home server",
    env: { ...process.env, POLYTH_LINK_CLIENT: FAKE },
    timing: { statusMs: 30, retryMinMs: 30, retryMaxMs: 200, noticeMs: 60_000, ...timing },
    notices: () => ({
      deliver: (userId, record) => { delivered.push({ userId, record }); },
      withdraw: (userId, key) => { assert.equal(userId, MAYA); withdrawn.push(key); },
    }),
  });
  joined.start();
  t.after(() => joined.stop());
  return { joined, delivered, withdrawn, keys: () => delivered.map((entry) => entry.record.key) };
}

async function pair(joined: ReturnType<typeof createJoinedSpaces>, value: Record<string, unknown>) {
  const ticket = `fake:${Buffer.from(JSON.stringify({ id: HOST_ID, label: "Studio", ...value })).toString("base64url")}`;
  const { attemptId } = await joined.begin(MAYA, ticket);
  return joined.confirm(MAYA, attemptId);
}

const ours = (key: string) => `rmt:${HOST_ID}:${key}`;

test("every joined Space is listened to and its notices arrive mapped", async (t) => {
  const remote = await remoteServer(t);
  const { joined, delivered } = manager(t, rootFor(t));
  await pair(joined, { port: remote.port });
  await until(() => remote.watched().join() === SPACES.join(), "a socket per Space");

  const first = remote.raise("spc_one", row("a", { kind: "permission" }));
  const second = remote.raise("spc_two", row("b"));
  await until(() => delivered.length === 2, "both notices");
  assert.deepEqual(delivered.find((entry) => entry.record.key === ours("a")), {
    userId: MAYA,
    record: {
      ...first, key: ours("a"),
      joinedSpace: { id: joinedSpaceId(MAYA, HOST_ID, "spc_one"), name: "Space 1", serverLabel: "Studio" },
    },
  });
  const other = delivered.find((entry) => entry.record.key === ours("b"))!;
  assert.equal(other.record.id, second.id);
  assert.equal(other.record.joinedSpace!.name, "Space 2");
});

test("what was raised offline is caught up once, bounded, without echoes", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const downFile = join(root, "link-down");
  const { joined, delivered, keys } = manager(t, root, { noticeMs: 40 });
  await pair(joined, { port: remote.port, downFile });
  await until(() => remote.watched().length === 2, "the sockets");

  writeFileSync(downFile, "");
  await until(() => joined.service.list(MAYA)[0]?.online === false, "offline");
  await until(() => remote.watched().length === 0, "the sockets to close");
  const list = remote.inbox.get("spc_one")!;
  list.push(
    row("old", { ts: Date.now() - NOTICE_MAX_AGE_MS - 1_000 }),
    row("seen", { read: true }),
    row("third-server", { joinedSpace: { id: "rmt_x", name: "Far", serverLabel: "Far" } }),
    row("turn", { body: "first turn" }),
    row("turn", { body: "second turn" }),
  );
  for (let i = 0; i < NOTICE_CATCH_UP - 1; i++) remote.inbox.get("spc_two")!.push(row(`many-${i}`));
  remote.inbox.get("spc_two")!.unshift(row("beyond-a", { ts: Date.now() - 60_000 }), row("beyond-b", { ts: Date.now() - 50_000 }));
  await pause(100);
  assert.equal(delivered.length, 0);

  rmSync(downFile);
  await until(() => delivered.length === NOTICE_CATCH_UP + 1, "the catch-up");
  await pause();
  assert.equal(delivered.length, NOTICE_CATCH_UP + 1, "later reads repeat nothing");
  assert.deepEqual(delivered.filter((entry) => entry.record.key === ours("turn")).map((entry) => entry.record.body), ["second turn"]);
  for (const key of ["old", "seen", "third-server", "beyond-a"]) assert.equal(keys().includes(ours(key)), false, key);
});

test("read or cleared there withdraws here, also after a restart", async (t) => {
  const remote = await remoteServer(t);
  const root = rootFor(t);
  const first = manager(t, root, { noticeMs: 40 });
  const { spaces } = await pair(first.joined, { port: remote.port });
  const read = remote.raise("spc_one", row("read"));
  remote.raise("spc_one", row("cleared"));
  remote.raise("spc_two", row("later"));
  remote.raise("spc_one", row("turn"));
  const latest = remote.raise("spc_one", row("turn"));
  await until(() => new Set(first.keys()).size === 4, "the notices");

  read.read = true;
  remote.inbox.set("spc_one", remote.inbox.get("spc_one")!.filter((item) => item.key !== "cleared" && item.id !== latest.id));
  await until(() => first.withdrawn.length === 2, "the withdrawals");
  await pause();
  assert.deepEqual(first.withdrawn.sort(), [ours("cleared"), ours("read")], "a key with an unread row stays");

  await first.joined.stop();
  assert.equal(first.withdrawn.length, 2, "disabling withdraws nothing");
  remote.inbox.set("spc_two", []);
  const again = manager(t, root, { noticeMs: 40 });
  await until(() => again.withdrawn.includes(ours("later")), "the withdrawal after a restart");
  assert.equal(again.withdrawn.includes(ours("turn")), false);
  assert.equal(spaces.length, 2);
});

test("reading through this server withdraws without waiting for the next read", async (t) => {
  const remote = await remoteServer(t);
  const { joined, delivered, withdrawn } = manager(t, rootFor(t));
  const { spaces } = await pair(joined, { port: remote.port });
  remote.raise("spc_two", row("here"));
  await until(() => delivered.length === 1, "the notice");
  await pause();
  const front = createServer((req, res) => {
    void joined.service.forwardHttp(MAYA, spaces[1]!.id, { method: "POST", path: "/api/notifications/read-all", req, res });
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  t.after(() => { front.closeAllConnections(); front.close(); });
  await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/`, { method: "POST" });
  await until(() => withdrawn.includes(ours("here")), "the withdrawal");
});

test("leaving the server withdraws its notices and stops listening", async (t) => {
  const remote = await remoteServer(t);
  const { joined, delivered, withdrawn } = manager(t, rootFor(t), { noticeMs: 40 });
  await pair(joined, { port: remote.port });
  await until(() => remote.watched().length === 2, "the sockets");
  remote.raise("spc_one", row("bye"));
  await until(() => delivered.length === 1, "the notice");

  await joined.remove(MAYA, HOST_ID);
  assert.deepEqual(withdrawn, [ours("bye")]);
  await until(() => remote.watched().length === 0, "the sockets to close");
  remote.raise("spc_one", row("after"));
  await pause();
  assert.equal(delivered.length, 1);
});

test("account removal stops the relay", async (t) => {
  const remote = await remoteServer(t);
  const { joined, delivered } = manager(t, rootFor(t), { noticeMs: 40 });
  await pair(joined, { port: remote.port });
  await until(() => remote.watched().length === 2, "the sockets");
  await joined.removeAccount(MAYA);
  await until(() => remote.watched().length === 0, "the sockets to close");
  remote.raise("spc_one", row("after"));
  await pause();
  assert.equal(delivered.length, 0);
});

test("an older server's selected Space is listened to and never moved", async (t) => {
  const remote = await remoteServer(t);
  const { joined, delivered } = manager(t, rootFor(t), { noticeMs: 40 });
  await pair(joined, { port: remote.port, legacy: true });
  await until(() => remote.watched().length === 1, "one socket");
  remote.raise("spc_two", row("unreachable"));
  remote.raise("spc_one", row("selected"));
  await until(() => delivered.length > 0, "the notice");
  await pause();
  assert.deepEqual(delivered.map((entry) => entry.record.key), [ours("selected")]);
  assert.deepEqual(remote.watched(), ["spc_one"]);
  assert.deepEqual(remote.state.activations, []);
});
