import test from "node:test";
import assert from "node:assert/strict";
import { rowsForReader } from "../src/sessionSharing.ts";
import { sharingFixture as fixture } from "./support/sharingFixture.ts";

test("a person's new chat is private; server work and the Space policy keep the old audience", async t => {
  const f = fixture(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const mine = await owner.create({ projectId: "prj_one" });
  assert.equal(f.security.resources.resource(mine.id)?.visibility, "private");
  await assert.rejects(f.sessionsFor(f.ctx("usr_admin")).snapshot(mine.id), { code: "not-found" });
  await assert.rejects(f.sessionsFor(f.ctx("usr_member")).events(mine.id), { code: "not-found" });
  await assert.rejects(f.sessionsFor(f.ctx("usr_member")).replayPage!(mine.id, 0), { code: "not-found" });
  assert.deepEqual((await f.sessionsFor(f.ctx("usr_member")).list("prj_one")).map((row) => row.id), []);

  const background = await f.sessionsFor(f.system()).create({ projectId: "prj_one" });
  assert.equal(f.security.resources.resource(background.id)?.visibility, "inherit");
  assert.equal((await f.sessionsFor(f.ctx("usr_member")).snapshot(background.id)).sharing?.access, "collaborate");

  f.sharing.setPolicy(f.ctx("usr_admin"), { defaultVisibility: "space" });
  const open = await owner.create({ projectId: "prj_one" });
  assert.equal(f.security.resources.resource(open.id)?.visibility, "inherit");
  assert.equal((await f.sessionsFor(f.ctx("usr_member")).snapshot(open.id)).sharing?.access, "collaborate");
});

test("view, collaborate and manage gate reading, working and administering a chat", async t => {
  const f = fixture(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const member = f.sessionsFor(f.ctx("usr_member"));
  const other = f.sessionsFor(f.ctx("usr_other"));
  const chat = await owner.create({ projectId: "prj_one" });
  await f.sharing.update(f.ctx("usr_owner"), chat.id, {
    visibility: "restricted",
    grants: [{ userId: "usr_member", access: "view" }, { userId: "usr_other", access: "collaborate" }],
  });

  const seen = await member.snapshot(chat.id);
  assert.deepEqual(seen.sharing, {
    visibility: "restricted", access: "view", owner: { userId: "usr_owner", name: "Olena" }, shared: true,
  });
  await member.markRead!(chat.id, 1);
  await assert.rejects(member.send(chat.id, { text: "hi" }), { code: "forbidden" });
  await assert.rejects(member.rename!(chat.id, "mine"), { code: "forbidden" });

  await other.send(chat.id, { text: "hi" });
  assert.deepEqual(f.sent, [chat.id]);
  await assert.rejects(other.rename!(chat.id, "ours"), { code: "forbidden" });
  await assert.rejects(other.archive(chat.id), { code: "forbidden" });
  // Forking reads the chat; the fork is the forker's own private chat.
  const fork = await member.fork(chat.id);
  assert.equal(f.security.resources.resource(fork.id)?.ownerPrincipalId, "usr_member");
  assert.equal(f.security.resources.resource(fork.id)?.visibility, "private");
  await assert.rejects(owner.snapshot(fork.id), { code: "not-found" });

  await owner.rename!(chat.id, "Renamed");
  await owner.archive(chat.id);
  assert.equal((await owner.snapshot(chat.id)).status, "archived");
  assert.equal((await owner.snapshot(chat.id)).sharing?.owner, undefined, "a reader is never shown as someone else");
});

test("a subagent follows its parent chat and needs collaborate access to be started", async t => {
  const f = fixture(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const parent = await owner.create({ projectId: "prj_one" });
  await assert.rejects(
    f.sessionsFor(f.ctx("usr_member")).create({ projectId: "prj_one", parentId: parent.id }),
    { code: "not-found" },
  );
  const child = await owner.create({ projectId: "prj_one", parentId: parent.id });
  const resource = f.security.resources.resource(child.id)!;
  assert.equal(resource.visibility, "inherit");
  assert.equal(resource.accessParentId, parent.id);
  await assert.rejects(f.sessionsFor(f.ctx("usr_member")).snapshot(child.id), { code: "not-found" });

  await f.sharing.update(f.ctx("usr_owner"), parent.id, { visibility: "space" });
  const view = (await f.sessionsFor(f.ctx("usr_member")).snapshot(child.id)).sharing;
  assert.equal(view?.inherited, true);
  assert.equal(view?.visibility, "space");
  assert.equal(view?.access, "collaborate");
  assert.deepEqual(f.changed.at(-1)?.map((row) => row.id), [parent.id, child.id], "readers of the subtree are told");
  await assert.rejects(
    f.sharing.update(f.ctx("usr_owner"), child.id, { visibility: "private" }),
    { code: "conflict" },
    "a subagent is shared through its parent",
  );
  assert.equal(f.sharing.state(f.ctx("usr_member"), child.id).parentSessionId, parent.id);
});

test("sharing state, Space policy limits and foreign-Space isolation", async t => {
  const f = fixture(t);
  const chat = await f.sessionsFor(f.ctx("usr_owner")).create({ projectId: "prj_one" });
  const state = f.sharing.state(f.ctx("usr_owner"), chat.id);
  assert.equal(state.visibility, "private");
  assert.equal(state.canShare, true);
  assert.deepEqual(state.allowedVisibilities, ["private", "restricted", "space"]);
  assert.equal(state.maxGrant, "manage");
  assert.deepEqual(state.people.map((person) => person.userId), ["usr_admin", "usr_member", "usr_other", "usr_viewer"]);

  // A foreign Space never learns the chat exists, whoever asks.
  assert.throws(() => f.sharing.state(f.ctx("usr_outside", "spc_work"), chat.id), { code: "not-found" });
  await assert.rejects(f.sharing.update(f.ctx("usr_outside", "spc_work"), chat.id, { visibility: "space" }), { code: "not-found" });
  assert.throws(() => f.sharing.state(f.ctx("usr_member"), chat.id), { code: "not-found" });

  await assert.rejects(
    f.sharing.update(f.ctx("usr_owner"), chat.id, { visibility: "restricted", grants: [{ userId: "usr_outside", access: "view" }] }),
    { code: "invalid-input" },
  );
  await assert.rejects(
    f.sharing.update(f.ctx("usr_owner"), chat.id, { grants: [{ userId: "usr_member", access: "view" }] }),
    { code: "invalid-input" },
    "people cannot be added to a chat that stays private",
  );

  f.sharing.setPolicy(f.ctx("usr_admin"), { maxMemberAccess: "collaborate", allowSpaceVisibility: false });
  assert.throws(() => f.sharing.setPolicy(f.ctx("usr_member"), { membersMayShare: false }), { code: "forbidden" });
  await assert.rejects(f.sharing.update(f.ctx("usr_owner"), chat.id, { visibility: "space" }), { code: "forbidden" });
  await assert.rejects(
    f.sharing.update(f.ctx("usr_owner"), chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "manage" }] }),
    { code: "forbidden" },
  );
  const shared = await f.sharing.update(f.ctx("usr_owner"), chat.id, {
    visibility: "restricted", grants: [{ userId: "usr_member", access: "collaborate" }], expectedRevision: state.revision,
  });
  assert.deepEqual(shared.grants, [{ userId: "usr_member", name: "Marta", access: "collaborate" }]);
  assert.deepEqual(shared.allowedVisibilities, ["private", "restricted"]);
  await assert.rejects(
    f.sharing.update(f.ctx("usr_owner"), chat.id, { visibility: "private", expectedRevision: state.revision }),
    { code: "conflict" },
  );

  // Members who may not share can still narrow what they shared before.
  f.sharing.setPolicy(f.ctx("usr_admin"), { membersMayShare: false });
  assert.equal(f.sharing.state(f.ctx("usr_owner"), chat.id).maxGrant, null);
  await assert.rejects(
    f.sharing.update(f.ctx("usr_owner"), chat.id, { grants: [{ userId: "usr_member", access: "collaborate" }, { userId: "usr_other", access: "view" }] }),
    { code: "forbidden" },
  );
  const narrowed = await f.sharing.update(f.ctx("usr_owner"), chat.id, { visibility: "private" });
  assert.deepEqual(narrowed.grants, []);
  assert.deepEqual(f.changed.at(-1)?.map((row) => row.id), [chat.id]);
});

test("navigator pages skip chats the reader cannot open and refill from later pages", async t => {
  const f = fixture(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const visible: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const chat = await owner.create({ projectId: "prj_one", title: `chat ${index}` });
    if (index % 3 === 0) {
      await f.sharing.update(f.ctx("usr_owner"), chat.id, { visibility: "restricted", grants: [{ userId: "usr_member", access: "view" }] });
      visible.unshift(chat.id);
    }
  }
  const member = f.sessionsFor(f.ctx("usr_member"));
  const first = await member.summaries!({ spaceId: "spc_home", limit: 2 });
  assert.deepEqual(first.sessions.map((row) => row.id), visible.slice(0, 2));
  assert.equal(first.complete, false);
  assert.ok(first.sessions.every((row) => row.sharing?.access === "view"));
  const rest = await member.summaries!({ spaceId: "spc_home", limit: 2, cursor: first.next! });
  assert.deepEqual(rest.sessions.map((row) => row.id), visible.slice(2));
  assert.equal(rest.complete, true);
  assert.equal((await owner.summaries!({ spaceId: "spc_home", limit: 50 })).sessions.length, 7);
});

test("rows for a reader hide what they cannot open and say who else can", async t => {
  const f = fixture(t);
  const owner = f.sessionsFor(f.ctx("usr_owner"));
  const privateChat = await owner.create({ projectId: "prj_one" });
  const spaceChat = await owner.create({ projectId: "prj_one" });
  await f.sharing.update(f.ctx("usr_owner"), spaceChat.id, { visibility: "space" });
  const rows = [...f.projections.values()];

  const forOwner = rowsForReader(rows, "usr_owner", "spc_home");
  assert.deepEqual(forOwner.map((row) => [row.id, row.sharing?.shared]), [[privateChat.id, false], [spaceChat.id, true]]);
  const forMember = rowsForReader(rows, "usr_member", "spc_home");
  assert.deepEqual(forMember.map((row) => row.id), [spaceChat.id]);
  assert.deepEqual(forMember[0]!.sharing?.owner, { userId: "usr_owner", name: "Olena" });
  assert.equal(rowsForReader(rows, "usr_outside", "spc_home").length, 0);
  assert.equal(rowsForReader(rows, "system:polyth-runtime", "spc_home").length, 2);
});
