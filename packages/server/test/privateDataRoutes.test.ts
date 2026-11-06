// The instance owner's whole view of someone's private data: one size, and one
// way to erase it, which needs a recent sign-in and an account gone for good.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RouteRequest, SessionProjection } from "@polyth/contracts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { erasePrivateChats, privateDataBytes, privateDataRoutes } from "../src/routes/privateData.ts";
import { sharingFixture } from "./support/sharingFixture.ts";

const ORIGIN = "http://127.0.0.1:4400";
const PASSWORD = "owner test passphrase";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-private-data-"));
  let clock = 1_800_000_000_000;
  const security = createCanonicalSecurity({ dataDir: root, origin: ORIGIN, localOnly: true, now: () => clock });
  const binding = bindCanonicalSecurity(security);
  t.after(() => { binding.dispose(); security.close(); rmSync(root, { recursive: true, force: true }); });
  const claim = security.identity.setup.issueClaim();
  const binding_ = "ab".repeat(32);
  security.identity.setup.bindClaim(claim.token, binding_);
  const recovery = security.identity.setup.prepareRecovery(claim.token, binding_);
  const { token } = await security.identity.setup.complete({
    claimToken: claim.token, browserBinding: binding_, name: "Owner", organizationName: "Home",
    login: "owner", password: PASSWORD, recoverySetId: recovery.setId, recoveryAcknowledged: true,
  });
  const person = await security.identity.accounts.createLocal(token, { login: "olia", name: "Оля", password: "olia test passphrase" });
  const erased: string[] = [];
  let eraseFailures = 0;
  const route = privateDataRoutes({ erase: async (userId) => { erased.push(userId); return { failed: eraseFailures }; }, volume: async () => 2048 });
  const cookie = `${security.http.cookieName}=${token}`;
  const call = async (method: string, target: string, action: "private-data" | "erase-private-data", instanceOwner = true) => {
    let answer: { code: number; body: Record<string, unknown> } | undefined;
    const path = `/api/accounts/${target}/${action}`;
    await route({
      path, method, url: new URL(`${ORIGIN}${path}`),
      space: { spaceId: "s", userId: "usr_owner", instanceOwner },
      req: { headers: { cookie, host: "127.0.0.1:4400" }, socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" } } as unknown as IncomingMessage,
      json: (code: number, body: Record<string, unknown>) => { answer = { code, body }; },
    } as unknown as RouteRequest);
    return answer;
  };
  return { security, token, person, erased, call, age: (ms: number) => { clock += ms; }, failErase: (count: number) => { eraseFailures = count; } };
}

test("the owner sees a size and nothing else; nobody else sees even that", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call("GET", f.person.id, "private-data"), { code: 200, body: { bytes: 2048 } });
  await assert.rejects(f.call("GET", f.person.id, "private-data", false), { code: "forbidden" });
  await assert.rejects(f.call("GET", "usr_nobody", "private-data"), { code: "not-found" });
});

test("erasing needs an account disabled for good and a recent sign-in", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call("POST", f.person.id, "erase-private-data"), { code: "conflict" }, "a live account keeps its data");
  assert.deepEqual(f.erased, []);
  f.security.identity.accounts.setStatus(f.token, f.person.id, "disabled", f.person.revision);

  await assert.rejects(f.call("POST", f.person.id, "erase-private-data", false), { code: "forbidden" });
  assert.deepEqual(f.erased, []);

  f.age(6 * 60_000);
  const stale = await f.call("POST", f.person.id, "erase-private-data");
  assert.equal(stale?.code, 403);
  assert.equal(stale?.body.error, "reauth-required", "the page asks for the password on exactly this");
  assert.deepEqual(f.erased, [], "nothing goes without the password");

  await f.security.identity.credentials.reauthenticate(f.token, PASSWORD);
  assert.deepEqual(await f.call("POST", f.person.id, "erase-private-data"), { code: 200, body: { ok: true } });
  assert.deepEqual(f.erased, [f.person.id]);
  const audit = f.security.control.get<{ actor_id: string }>("SELECT actor_id FROM audit_events WHERE action='identity.private-data-erased' AND resource_id=?", f.person.id);
  assert.equal(audit?.actor_id, "usr_owner");
});

test("an erase that leaves something behind says so, and can be run again", async (t) => {
  const f = await fixture(t);
  f.security.identity.accounts.setStatus(f.token, f.person.id, "disabled", f.person.revision);
  f.failErase(2);
  const partial = await f.call("POST", f.person.id, "erase-private-data");
  assert.equal(partial?.code, 500);
  assert.equal(partial?.body.error, "erase-incomplete");
  const action = (name: string) => f.security.control.get<{ actor_id: string }>("SELECT actor_id FROM audit_events WHERE action=? AND resource_id=?", name, f.person.id);
  assert.equal(action("identity.private-data-erased"), undefined, "the log doesn't claim it either");
  assert.equal(action("identity.private-data-erase-incomplete")?.actor_id, "usr_owner");
  f.failErase(0);
  assert.deepEqual(await f.call("POST", f.person.id, "erase-private-data"), { code: 200, body: { ok: true } });
  assert.equal(action("identity.private-data-erased")?.actor_id, "usr_owner");
});

test("the size adds up their folders and notes without following links", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-private-size-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const room = join(root, "room");
  mkdirSync(join(room, "nested"), { recursive: true });
  writeFileSync(join(room, "a.txt"), "x".repeat(100));
  writeFileSync(join(room, "nested", "b.txt"), "y".repeat(50));
  const bytes = await privateDataBytes("usr_olia", {
    projects: { privateProjectsOwnedBy: () => [{ id: "r", name: "r", path: room, createdAt: 0 }] },
    sessions: { list: async () => [] },
    store: {},
    measures: [() => 7, async () => { throw new Error("a package failed"); }],
  });
  assert.equal(bytes, 157, "a failing package never hides the rest");
});

test("erasing takes their private chats and what they attached, and nothing of anyone else's", async (t) => {
  const f = sharingFixture(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const mine = await owner.create({ projectId: "prj_one" });
  const child = await owner.create({ projectId: "prj_one", parentId: mine.id });
  const stuck = await owner.create({ projectId: "prj_one" });
  const open = await owner.create({ projectId: "prj_one" });
  await f.sharing.update(f.ctx("usr_owner"), open.id, { visibility: "space" });
  const theirs = await f.sessionsFor(f.ctx("usr_member")).create({ projectId: "prj_one" });

  const folder = mkdtempSync(join(tmpdir(), "polyth-erase-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, "_inbox"));
  for (const name of ["mine.png", "forked-from-someone.png", "in-a-shared-chat.png", "stuck.png"]) writeFileSync(join(folder, "_inbox", name), "x");
  writeFileSync(join(folder, "outside.txt"), "x");

  const row = (id: string): SessionProjection => ({ id, projectId: "prj_one", spaceId: "spc_home" }) as SessionProjection;
  const says = (author: string, ...paths: string[]) => ({ seq: 1, type: "user/message", data: { author: { userId: author }, attachments: paths.map((path) => ({ path })) } });
  const events: Record<string, unknown[]> = {
    [mine.id]: [says("usr_owner", "_inbox/mine.png", "_inbox/../outside.txt", "_inbox/", "src/app.ts"), says("usr_member", "_inbox/forked-from-someone.png")],
    [stuck.id]: [says("usr_owner", "_inbox/stuck.png")],
    [open.id]: [says("usr_owner", "_inbox/in-a-shared-chat.png")],
  };
  const deleted: string[] = [];
  const result = await erasePrivateChats("usr_owner", {
    projects: { projectById: () => ({ id: "prj_one", name: "One", path: folder, createdAt: 0 }), privateProjectsOwnedBy: () => [] } as never,
    deleteChat: async ({ id }) => {
      if (id === child.id) throw Object.assign(new Error("gone in an earlier try"), { code: "not-found" });
      if (id === stuck.id) throw Object.assign(new Error("database is locked"), { code: "unavailable" });
      deleted.push(id);
    },
    store: {
      projections: async () => [row(mine.id), row(child.id), row(stuck.id), row(open.id), row(theirs.id)],
      eventsOfTypes: async (id: string) => (events[id] ?? []) as never,
    },
    removeProject: async () => {},
  });

  assert.deepEqual(deleted, [mine.id], "not the shared chat, and not someone else's");
  assert.deepEqual(result, { chats: 1, rooms: 0, failed: 1 }, "a chat already gone is no failure");
  assert.equal(existsSync(join(folder, "_inbox", "mine.png")), false);
  assert.equal(existsSync(join(folder, "_inbox", "forked-from-someone.png")), true, "another person's message in a fork");
  assert.equal(existsSync(join(folder, "_inbox", "in-a-shared-chat.png")), true);
  assert.equal(existsSync(join(folder, "_inbox", "stuck.png")), true, "kept until its chat really goes, so a retry still finds it");
  assert.equal(existsSync(join(folder, "outside.txt")), true, "a message's path can't aim the delete elsewhere");
});

test("erasing goes through the canonical service: subagents first, and no resource is left to block a room", async (t) => {
  const f = sharingFixture(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const parent = await owner.create({ projectId: "prj_one" });
  const child = await owner.create({ projectId: "prj_one", parentId: parent.id });
  const system = f.sessionsFor(f.system());
  const order: string[] = [];
  const rows = await system.list();
  const result = await erasePrivateChats("usr_owner", {
    projects: { projectById: () => undefined, privateProjectsOwnedBy: () => [] } as never,
    deleteChat: async ({ id }) => { order.push(id); await system.delete!(id); },
    store: { projections: async () => rows },
    removeProject: async () => {},
  });
  assert.deepEqual(result, { chats: 2, rooms: 0, failed: 0 });
  assert.deepEqual(order, [child.id, parent.id]);
  for (const id of [parent.id, child.id]) assert.equal(f.security.resources.resource(id)?.lifecycle, "deleted");
});
