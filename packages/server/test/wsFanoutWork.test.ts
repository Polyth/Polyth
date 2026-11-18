// Live fan-out re-reads a socket's Space membership before it delivers
// anything (several control-plane queries per read). With many sockets and a
// streaming chat that read must be paid only for the sockets a frame is for:
// a session event for the readers of that session, a projection for the
// sockets of its Space. These tests count the membership reads, and check
// that the fence itself did not move: a removed member receives nothing and
// its socket is closed the next time its Space publishes.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import type { SessionProjection, SpaceContext } from "@polyth/contracts";
import { createWsGateway } from "../src/ws.ts";
import { sharingFixture } from "./support/sharingFixture.ts";

type Client = { ws: WebSocket; messages: Record<string, unknown>[]; raw: string[] };

function connect(port: number, user: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { "x-test-user": user } });
  const messages: Record<string, unknown>[] = [];
  const raw: string[] = [];
  ws.on("message", (data) => { raw.push(String(data)); messages.push(JSON.parse(String(data)) as Record<string, unknown>); });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, messages, raw }));
    ws.on("error", reject);
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const quietPeriod = () => new Promise((resolve) => setTimeout(resolve, 120));

const eventsOf = (client: Client, sessionId: string) => client.messages
  .flatMap((m) => m.type === "event" ? [m.event as { sessionId: string; seq: number }]
    : m.type === "events" ? m.events as { sessionId: string; seq: number }[] : [])
  .filter((event) => event.sessionId === sessionId);

async function rig(t: Parameters<typeof sharingFixture>[0]) {
  const f = sharingFixture(t);
  const resolved: string[] = [];
  const removed = new Set<string>();
  const spaces = {
    resolve: (principal: { testUser: string }) => {
      resolved.push(principal.testUser);
      if (removed.has(principal.testUser)) throw Object.assign(new Error("not a member"), { code: "forbidden" });
      return f.ctx(principal.testUser);
    },
    services: (ctx: SpaceContext) => ({ sessions: f.sessionsFor(ctx) }),
    spaceOfSession: (id: string) => f.projections.get(id)?.spaceId,
    cookieName: "polyth_space",
    guard: { assertProject() {}, assertSession() {} },
  };
  const gateway = createWsGateway(f.sessionsFor(f.system()), undefined, undefined, spaces as never);
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  gateway.attach(server, {
    identity: (req) => ({
      authenticated: true,
      principal: { kind: "local-user", trustedLoopback: true, testUser: String(req.headers["x-test-user"]) } as never,
    }),
  });
  server.listen(0);
  await once(server, "listening");
  t.after(() => { gateway.close(); server.close(); });
  const port = (server.address() as { port: number }).port;
  return { f, gateway, port, resolved, removed };
}

const event = (sessionId: string, seq: number) => ({
  id: `e${seq}`, sessionId, seq, time: Date.now(), type: "assistant/message", data: { text: `m${seq}` }, v: 1,
}) as never;

test("a session event re-reads membership only for the sockets that read that session", async (t) => {
  const { f, gateway, port, resolved } = await rig(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const watched = await owner.create({ projectId: "prj_one" });
  const elsewhere = await owner.create({ projectId: "prj_one" });

  const reader = await connect(port, "usr_owner");
  const secondTab = await connect(port, "usr_owner");
  const otherChat = await connect(port, "usr_owner");
  const listOnly = await connect(port, "usr_owner");
  reader.ws.send(JSON.stringify({ type: "subscribe", sessionId: watched.id }));
  secondTab.ws.send(JSON.stringify({ type: "subscribe", sessionId: watched.id }));
  otherChat.ws.send(JSON.stringify({ type: "subscribe", sessionId: elsewhere.id }));
  listOnly.ws.send(JSON.stringify({ type: "subscribe", sessionId: null }));
  await until(() => [reader, secondTab, otherChat, listOnly].every((c) => c.messages.some((m) => m.type === "projections")), "the initial lists");
  await quietPeriod();

  resolved.length = 0;
  gateway.event(event(watched.id, 1));
  assert.equal(resolved.length, 2, "one membership read per reader of the session, none for the other two sockets");
  await until(() => eventsOf(reader, watched.id).length === 1 && eventsOf(secondTab, watched.id).length === 1, "the event");
  await quietPeriod();
  assert.equal(eventsOf(otherChat, watched.id).length + eventsOf(listOnly, watched.id).length, 0);
  // Both readers got the same bytes: the frame is serialized once.
  assert.equal(reader.raw.at(-1), secondTab.raw.at(-1));

  resolved.length = 0;
  gateway.toolProgress(watched.id, "call_1", Date.now());
  assert.equal(resolved.length, 2, "a tool pulse is as narrow as an event");
  for (const client of [reader, secondTab, otherChat, listOnly]) client.ws.close();
});

test("a removed member receives nothing, and the next projection of the Space closes the socket", async (t) => {
  const { f, gateway, port, removed } = await rig(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const watched = await owner.create({ projectId: "prj_one" });
  const elsewhere = await owner.create({ projectId: "prj_one" });
  for (const chat of [watched, elsewhere]) {
    await f.sharing.update(f.ctx("usr_owner"), chat.id, {
      visibility: "restricted", grants: [{ userId: "usr_member", access: "view" }],
    });
  }

  const reader = await connect(port, "usr_member");
  const idle = await connect(port, "usr_member");
  const stays = await connect(port, "usr_owner");
  reader.ws.send(JSON.stringify({ type: "subscribe", sessionId: watched.id }));
  idle.ws.send(JSON.stringify({ type: "subscribe", sessionId: elsewhere.id }));
  stays.ws.send(JSON.stringify({ type: "subscribe", sessionId: watched.id }));
  await until(() => [reader, idle, stays].every((c) => c.messages.some((m) => m.type === "projections")), "the initial lists");
  await quietPeriod();

  removed.add("usr_member");
  const before = { reader: reader.messages.length, idle: idle.messages.length };
  gateway.event(event(watched.id, 1));
  await until(() => reader.ws.readyState !== WebSocket.OPEN, "the reader's socket to close on the event meant for it");
  await until(() => eventsOf(stays, watched.id).length === 1, "the remaining member's event");
  assert.equal(reader.messages.length, before.reader, "nothing was delivered after the removal");

  // The second socket read another chat, so that event never concerned it.
  // Its Space's next projection fences it before anything is delivered.
  gateway.projection(f.projections.get(watched.id) as SessionProjection);
  await until(() => idle.ws.readyState !== WebSocket.OPEN, "the idle socket to close on its Space's projection");
  assert.equal(idle.messages.length, before.idle, "nothing was delivered after the removal");
  assert.equal(stays.ws.readyState, WebSocket.OPEN);
  stays.ws.close();
});

test("two tabs of one person receive the same projection frame", async (t) => {
  const { f, gateway, port } = await rig(t);
  const chat = await f.sessionsFor(f.ctx("usr_owner")).create({ projectId: "prj_one" });
  const a = await connect(port, "usr_owner");
  const b = await connect(port, "usr_owner");
  for (const client of [a, b]) client.ws.send(JSON.stringify({ type: "subscribe", sessionId: null }));
  await until(() => [a, b].every((c) => c.messages.some((m) => m.type === "projections")), "the initial lists");
  await quietPeriod();

  gateway.projection(f.projections.get(chat.id) as SessionProjection);
  await until(() => [a, b].every((c) => c.messages.at(-1)?.type === "projection"), "the live projection");
  // The frame is built once per view and shape and reused.
  assert.equal(a.raw.at(-1), b.raw.at(-1));
  assert.equal((a.messages.at(-1)!.session as SessionProjection).id, chat.id);
  for (const client of [a, b]) client.ws.close();
});
