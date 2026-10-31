// Live fan-out follows session sharing (Spaces §14.3): a socket only hears
// about chats its person can open, each with that person's sharing view, and
// losing access removes the row and ends the socket's live history of it.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import type { SessionProjection, SpaceContext } from "@polyth/contracts";
import { createWsGateway } from "../src/ws.ts";
import { sharingFixture } from "./support/sharingFixture.ts";

type Client = { ws: WebSocket; messages: Record<string, unknown>[] };

function connect(port: number, user: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { "x-test-user": user } });
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (raw) => { messages.push(JSON.parse(String(raw)) as Record<string, unknown>); });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, messages }));
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

const rowsIn = (client: Client, id: string): SessionProjection[] => client.messages
  .flatMap((m) => m.type === "projections" ? m.sessions as SessionProjection[] : m.type === "projection" ? [m.session as SessionProjection] : [])
  .filter((row) => row.id === id);

test("sockets hear only about chats their person can open, and losing access removes them", async (t) => {
  const f = sharingFixture(t);
  const chat = await f.sessionsFor(f.ctx("usr_owner")).create({ projectId: "prj_one" });
  await f.sharing.update(f.ctx("usr_owner"), chat.id, {
    visibility: "restricted", grants: [{ userId: "usr_member", access: "view" }],
  });

  const spaces = {
    resolve: (principal: { testUser: string }) => f.ctx(principal.testUser),
    services: (ctx: SpaceContext) => ({ sessions: f.sessionsFor(ctx) }),
    spaceOfSession: (id: string) => f.projections.get(id)?.spaceId,
    cookieName: "polyth_space",
    guard: { assertProject() {}, assertSession() {} },
  };
  const gateway = createWsGateway(f.sessionsFor(f.system()), undefined, undefined, spaces as never);
  f.onAccessChanged((rows, formerReaders) => gateway.sessionAccessChanged(rows, formerReaders));
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

  const owner = await connect(port, "usr_owner");
  const member = await connect(port, "usr_member");
  const other = await connect(port, "usr_other");
  for (const client of [owner, member, other]) client.ws.send(JSON.stringify({ type: "subscribe", sessionId: null }));
  await until(() => rowsIn(owner, chat.id).length > 0 && rowsIn(member, chat.id).length > 0, "the initial lists");
  await quietPeriod();
  assert.equal(rowsIn(other, chat.id).length, 0, "the initial list hides chats the person cannot open");
  assert.equal(rowsIn(member, chat.id)[0]!.sharing?.access, "view");
  assert.equal(rowsIn(owner, chat.id)[0]!.sharing?.shared, true);

  // Live projections follow the same rule, each with the reader's own view.
  gateway.projection(f.projections.get(chat.id)!);
  await until(() => rowsIn(member, chat.id).length === 2 && rowsIn(owner, chat.id).length === 2, "the live projection");
  await quietPeriod();
  assert.equal(rowsIn(other, chat.id).length, 0);
  assert.deepEqual(rowsIn(member, chat.id)[1]!.sharing?.owner, { userId: "usr_owner", name: "Olena" });

  // A chat whose create has not settled is still announced to its creator.
  const fresh = "ses_fresh";
  f.security.resources.begin({
    operationId: "op_fresh", resourceId: fresh, kind: "session", orgId: "org_home", spaceId: "spc_home",
    parentId: "prj_one", ownerPrincipalId: "usr_owner", createdBy: "usr_owner", visibility: "private",
  });
  gateway.projection({ ...f.projections.get(chat.id)!, id: fresh, title: "fresh" });
  await until(() => rowsIn(owner, fresh).length === 1, "the creator's provisioning chat");
  await quietPeriod();
  assert.equal(rowsIn(member, fresh).length + rowsIn(other, fresh).length, 0);

  member.ws.send(JSON.stringify({ type: "subscribe", sessionId: chat.id }));
  await quietPeriod();
  assert.equal(member.messages.some((m) => m.type === "session/removed"), false);

  // The owner takes the chat back: the member's row goes, its live history ends.
  await f.sharing.update(f.ctx("usr_owner"), chat.id, { visibility: "private" });
  await until(() => member.messages.some((m) => m.type === "session/removed" && m.sessionId === chat.id), "the removal");
  await until(() => rowsIn(owner, chat.id).length === 3, "the owner's refreshed row");
  assert.equal(rowsIn(owner, chat.id).at(-1)!.sharing?.shared, false);
  await quietPeriod();
  assert.equal(other.messages.some((m) => m.type === "session/removed"), false, "nobody else learns the chat existed");

  const before = member.messages.length;
  gateway.event({
    id: "e1", sessionId: chat.id, seq: 1, time: Date.now(), type: "assistant/message", data: { text: "secret" }, v: 1,
  } as never);
  gateway.projection(f.projections.get(chat.id)!);
  await quietPeriod();
  assert.equal(member.messages.length, before, "no event or row reaches a person who lost access");

  // Resubscribing to it answers with the removal once and keeps the socket.
  member.ws.send(JSON.stringify({ type: "subscribe", sessionId: chat.id }));
  await until(() => member.messages.filter((m) => m.type === "session/removed").length === 2, "the resubscribe removal");
  await quietPeriod();
  assert.equal(member.ws.readyState, WebSocket.OPEN);
  for (const client of [owner, member, other]) client.ws.close();
});
