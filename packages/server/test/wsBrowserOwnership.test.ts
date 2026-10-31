// Browser live view over WebSocket (Spaces §14.6): a person's browser is
// theirs alone, and a chat's browser shows only to people who can open that
// chat, as on `/api/browser/*` — knowing the id is not enough.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import type { SpaceContext } from "@polyth/contracts";
import { createWsGateway, type BrowserFrameForWs, type BrowserServiceForWs } from "../src/ws.ts";
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

test("only a browser's owner, or people who can open its chat, subscribe to its frames", async (t) => {
  const f = sharingFixture(t);
  const owner = f.ctx("usr_owner");
  const chat = await f.sessionsFor(owner).create({ projectId: "prj_one" });
  await f.sharing.update(owner, chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "collaborate" }] });
  const privateChat = await f.sessionsFor(owner).create({ projectId: "prj_one" });

  const browsers: Record<string, { sessionId?: string; owner?: string }> = {
    mine: { sessionId: chat.id, owner: "usr_owner" },
    chat: { sessionId: chat.id },
    private: { sessionId: privateChat.id },
    project: {},
  };
  const frame = (id: string): BrowserFrameForWs => ({ browserSessionId: id, revision: 1, mime: "image/jpeg", data: new Uint8Array([1]) });
  const browser = {
    get: (id: string) => browsers[id]
      ? { id, projectId: "prj_one", ...(browsers[id]!.sessionId ? { sessionId: browsers[id]!.sessionId } : {}) }
      : null,
    ownerOf: (id: string) => browsers[id]?.owner,
    onFrame: () => ({ dispose() {} }),
    onEvent: () => ({ dispose() {} }),
    latestFrame: (id: string) => frame(id),
    setViewerVisible() {},
  } satisfies BrowserServiceForWs;

  const spaces = {
    resolve: (principal: { testUser: string }) => f.ctx(principal.testUser),
    services: (ctx: SpaceContext) => ({ sessions: f.sessionsFor(ctx) }),
    spaceOfSession: (id: string) => f.projections.get(id)?.spaceId,
    cookieName: "polyth_space",
    guard: { assertProject() {}, assertSession() {} },
  };
  const gateway = createWsGateway(f.sessionsFor(f.system()), browser, undefined, spaces as never);
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

  /** What a subscription answers: a frame or not-found. */
  const subscribe = async (client: Client, id: string): Promise<"frame" | "not-found"> => {
    const before = client.messages.length;
    client.ws.send(JSON.stringify({ type: "browser/subscribe", browserSessionId: id }));
    await until(() => client.messages.slice(before).some((m) => m.type === "browser/frame" || m.type === "error"), `an answer for ${id}`);
    const answer = client.messages.slice(before).find((m) => m.type === "browser/frame" || m.type === "error")!;
    return answer.type === "browser/frame" ? "frame" : "not-found";
  };

  const asOwner = await connect(port, "usr_owner");
  const asMember = await connect(port, "usr_member");
  const asOther = await connect(port, "usr_other");
  const asAdmin = await connect(port, "usr_admin");

  assert.equal(await subscribe(asOwner, "mine"), "frame");
  assert.equal(await subscribe(asMember, "mine"), "not-found", "a collaborator in the chat still cannot watch the owner's browser");
  assert.equal(await subscribe(asOther, "mine"), "not-found");

  assert.equal(await subscribe(asMember, "chat"), "frame", "an ownerless browser follows its chat");
  assert.equal(await subscribe(asOther, "chat"), "not-found", "a member who cannot open the chat sees nothing");
  assert.equal(await subscribe(asAdmin, "private"), "not-found", "admins get no access to private chats");
  assert.equal(await subscribe(asOwner, "private"), "frame");
  assert.equal(await subscribe(asOther, "project"), "frame", "a project browser stays Space-wide");
});
