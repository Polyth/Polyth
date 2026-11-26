// `server.person-notices`: a notice from a Space joined on another server is
// one inbox row for its person, in whichever of their Spaces is open, and
// reaches nobody else.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationRecord } from "@polyth/contracts";
import type { DeviceUse } from "../src/devicePresence.ts";
import { createNotificationStore, NOTIFICATION_CAP, type JoinedNotice, type NotificationAccount } from "../src/notifications.ts";
import { createPersonNotices } from "../src/notificationsPersonNotices.ts";
import type { PushService } from "../src/push.ts";

const MAYA = "usr_maya";
const NOOR = "usr_noor";
const home = { userId: MAYA, spaceId: "spc_home" };
const work = { userId: MAYA, spaceId: "spc_work" };
// Noor shares a Space with Maya.
const other = { userId: NOOR, spaceId: "spc_work" };

const notice = (over: Partial<JoinedNotice> = {}): JoinedNotice => ({
  id: "there-1", key: "rmt:conn:ses_1:turn:idle", kind: "completed",
  sessionId: "ses_1", projectId: "prj_there", title: "Build — done", body: "All green",
  ts: 10, read: false,
  joinedSpace: { id: "rmt_0123456789abcdef01234567", name: "Design", serverLabel: "Studio" },
  ...over,
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-person-notices-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "notifications.json");
  const members: Record<string, string[]> = { [MAYA]: ["spc_home", "spc_work"], [NOOR]: ["spc_work"] };
  const hasAccess = (a: NotificationAccount) => members[a.userId]?.includes(a.spaceId) ?? false;
  const store = createNotificationStore({ file, hasAccess });
  const frames: Array<{ record: NotificationRecord; to: NotificationAccount }> = [];
  const pushed: Array<{ to: NotificationAccount; payload: Record<string, unknown>; except?: string }> = [];
  const native: Array<Record<string, unknown>> = [];
  const using = new Map<string, DeviceUse>();
  const listeners: Array<(account: NotificationAccount) => void> = [];
  const service = createPersonNotices({
    store,
    spacesOf: (userId) => members[userId] ?? [],
    broadcast: (record, to) => frames.push({ record, to }),
    push: {
      send: (async (to: NotificationAccount, payload: Record<string, unknown>, options?: { exceptDevice?: string }) => {
        pushed.push({ to, payload, except: options?.exceptDevice });
        return { sent: 1, dropped: 0, failed: 0, droppedEndpoints: [] };
      }) as unknown as PushService["send"],
    },
    nativePush: { send: async (input) => { native.push(input); return { sent: 1 }; } },
    presence: {
      activeUse: (a) => using.get(`${a.userId} ${a.spaceId}`),
      subscribe: (listener) => { listeners.push(listener); return () => {}; },
    },
  });
  return { dir, file, store, service, frames, pushed, native, using, hasAccess };
}

test("a delivered notice is one row, live and pushed to its person only", async (t) => {
  const { dir, store, service, frames, pushed, native } = fixture(t);
  service.deliver(MAYA, notice());
  await service.settled();

  const inHome = await store.list(home);
  const inWork = await store.list(work);
  assert.deepEqual(inHome, inWork);
  assert.equal(inHome.unread, 1);
  const [row] = inHome.items;
  assert.equal(row!.key, notice().key);
  assert.deepEqual(row!.joinedSpace, notice().joinedSpace);
  assert.equal(row!.sessionId, "ses_1");
  assert.notEqual(row!.id, "there-1", "this server numbers its own rows");
  assert.deepEqual(await store.get(work, row!.id), row);

  assert.deepEqual(await store.list(other), { items: [], unread: 0 });
  assert.equal(await store.get(other, row!.id), undefined);
  assert.deepEqual(await store.read(other, [row!.id]), { updated: 0, unread: 0 });
  assert.deepEqual(await store.clear(other), { cleared: 0, unread: 0 });
  assert.equal((await store.list(home)).unread, 1);

  assert.deepEqual(frames.map((frame) => frame.to), [home, work]);
  assert.deepEqual(pushed.map((send) => send.to), [home, work]);
  assert.equal(pushed[0]!.payload.body, "Design · Studio — All green");
  assert.deepEqual(pushed[0]!.payload.joinedSpace, notice().joinedSpace);
  assert.ok(native.every((send) => send.userId === MAYA && send.transitionKey === notice().key));
  assert.deepEqual(readdirSync(dir), ["notifications.json"], "nothing but the inbox is written");
});

test("a repeat adds nothing; a later notice of the same key replaces the row", async (t) => {
  const { store, service, frames, pushed } = fixture(t);
  service.deliver(MAYA, notice());
  service.deliver(MAYA, notice());
  await service.settled();
  assert.equal((await store.list(home)).items.length, 1);
  assert.equal(frames.length, 2);
  assert.equal(pushed.length, 2);

  // The same words again, later: another turn ended.
  service.deliver(MAYA, notice({ id: "there-2", ts: 20, body: "One test fails" }));
  service.deliver(MAYA, notice({ ts: 15, body: "late arrival" }));
  await service.settled();
  assert.deepEqual((await store.list(home)).items.map((row) => row.body), ["One test fails"]);
  assert.equal(frames.length, 4);
});

test("unknown people, other kinds, read rows and access requests stay out", async (t) => {
  const { store, service, frames } = fixture(t);
  service.deliver("usr_gone", notice());
  service.deliver(MAYA, notice({ kind: "explosion" as never }));
  service.deliver(MAYA, notice({ read: true }));
  service.deliver(MAYA, notice({ joinedSpace: undefined as never }));
  await service.settled();
  assert.equal(frames.length, 0);
  assert.deepEqual((await store.list(home)).items, []);

  service.deliver(MAYA, notice({
    kind: "mention", title: "x".repeat(900),
    accessRequest: { messageSeq: 3, people: [{ userId: "u", name: "U" }] },
  }));
  await service.settled();
  const [row] = (await store.list(home)).items;
  assert.equal(row!.accessRequest, undefined);
  assert.equal(row!.title.length, 200);

  // An ordinary row can never claim to be a joined one.
  const own = await store.add(home, notice({ key: "local" }));
  assert.equal(own!.joinedSpace, undefined);
});

test("read and clear hold everywhere, survive a restart and do not come back", async (t) => {
  const { file, store, service, hasAccess } = fixture(t);
  await store.add(other, { key: "n", kind: "completed", sessionId: "s", projectId: "p", title: "t", body: "b" });
  service.deliver(MAYA, notice());
  await service.settled();
  const [row] = (await store.list(home)).items;
  assert.deepEqual(await store.read(work, [row!.id]), { updated: 1, unread: 0 });
  assert.equal((await store.list(home)).unread, 0);

  const reopened = createNotificationStore({ file, hasAccess });
  assert.deepEqual((await reopened.list(home)).items, [{ ...row!, read: true }]);
  assert.equal(await reopened.deliverPerson(MAYA, notice()), undefined);
  assert.equal((await reopened.clear(work)).cleared, 1);
  assert.equal((await reopened.list(other)).items.length, 1);

  const again = createNotificationStore({ file, hasAccess });
  assert.equal(await again.deliverPerson(MAYA, notice()), undefined);
  assert.ok(await again.deliverPerson(NOOR, notice()), "one person's clear does not mute another");
  assert.ok(await again.deliverPerson(MAYA, notice({ ts: 30 })), "a later notice of that key is news");
  await again.clear(home);
  await again.removeAccount(MAYA);
  assert.ok(await createNotificationStore({ file, hasAccess }).deliverPerson(MAYA, notice()), "removal forgets");
});

test("withdraw removes only that person's row, after its own delivery", async (t) => {
  const { store, service } = fixture(t);
  service.deliver(MAYA, notice());
  service.deliver(NOOR, notice());
  service.withdraw(MAYA, notice().key);
  await service.settled();
  assert.deepEqual((await store.list(home)).items, []);
  assert.equal((await store.list(other)).items.length, 1);
});

test("joined rows are capped apart from a Space's own rows", async (t) => {
  const { store } = fixture(t);
  await store.add(home, { key: "local", kind: "completed", sessionId: "s", projectId: "p", title: "t", body: "b" });
  for (let i = 0; i <= NOTIFICATION_CAP; i++) await store.deliverPerson(MAYA, notice({ key: `rmt:conn:${i}` }));
  const { items } = await store.list(home);
  assert.equal(items.length, NOTIFICATION_CAP + 1);
  assert.equal(items[0]!.key, "local");
  assert.equal(await store.deliverPerson(MAYA, notice({ key: "rmt:conn:0" })), undefined);
});

test("while one device is in use only it is alerted", async (t) => {
  const { service, pushed, using, frames } = fixture(t);
  using.set(`${MAYA} spc_work`, { device: "laptop", hidden: false, touchedAt: Date.now() });
  service.deliver(MAYA, notice());
  await service.settled();
  assert.deepEqual(pushed.map((send) => send.to), [work]);
  assert.equal(frames.length, 2);
});
