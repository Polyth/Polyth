// NTF-01 notification store: versioned JSON inbox with strictly increasing
// timestamps, a 200-row FIFO cap, idempotent read/read-all/clear, fail-closed
// loading, and atomic serialized writes. Stable keys are deliberately NOT the
// primary key — a repeated transition keeps both rows under fresh ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NotificationRecord } from "@polyth/contracts";
import { createNotificationStore, NOTIFICATION_CAP, type NotificationStore } from "../src/notifications.ts";
import { notificationRoutes } from "../src/routes/notifications.ts";
import type { RouteRequest } from "../src/http.ts";

const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "polyth-ntf-")), "notifications.json");

const input = (n: number, over: Partial<Omit<NotificationRecord, "id" | "ts" | "read">> = {}) => ({
  key: `ses_a:turn:idle`,
  kind: "completed" as const,
  sessionId: "ses_a",
  projectId: "p1",
  title: `Polyth — Task ${n}`,
  body: `Task ${n} — finished`,
  ...over,
});

test("first boot: missing file yields an empty inbox and list is read-only", async () => {
  const file = tmpFile();
  const store = createNotificationStore({ file });
  assert.deepEqual(await store.list(), { items: [], unread: 0 });
  assert.equal(existsSync(file), false, "a pure read must not create the file");
});

test("malformed JSON, unsupported version, invalid rows, and duplicate ids fail closed", async () => {
  const file = tmpFile();
  writeFileSync(file, "{ not json");
  assert.deepEqual(await createNotificationStore({ file }).list(), { items: [], unread: 0 });

  writeFileSync(file, JSON.stringify({ version: 1, items: [input(1)] }));
  assert.deepEqual(await createNotificationStore({ file }).list(), { items: [], unread: 0 });

  const good: NotificationRecord = {
    id: "id-1", key: "s:turn:idle", kind: "completed", sessionId: "s", projectId: "p",
    title: "t", body: "b", ts: 5, read: false,
  };
  writeFileSync(file, JSON.stringify({
    version: 2,
    items: [
      { record: good, recipient: { userId: "__isolated_test__", spaceId: "__isolated_test__" } },
      { record: { ...good, id: "id-1" }, recipient: { userId: "__isolated_test__", spaceId: "__isolated_test__" } },
      { record: { ...good, id: "id-2", kind: "explosion" }, recipient: { userId: "__isolated_test__", spaceId: "__isolated_test__" } },
      { record: { ...good, id: "id-3", ts: "soon" }, recipient: { userId: "__isolated_test__", spaceId: "__isolated_test__" } },
      { record: { ...good, id: "id-3b", ts: 5.5 }, recipient: { userId: "__isolated_test__", spaceId: "__isolated_test__" } },
      { record: { ...good, id: "" }, recipient: { userId: "__isolated_test__", spaceId: "__isolated_test__" } },
      "garbage",                                     // non-object → discarded
      { record: { ...good, id: "id-out-of-order", ts: 4 }, recipient: { userId: "__isolated_test__", spaceId: "__isolated_test__" } },
      { record: { ...good, id: "id-4", ts: 6, read: true }, recipient: { userId: "__isolated_test__", spaceId: "__isolated_test__" } },
    ],
    recipients: [],
  }));
  const loaded = await createNotificationStore({ file }).list();
  assert.deepEqual(loaded.items.map((r) => r.id), ["id-1", "id-4"]);
  assert.equal(loaded.unread, 1);
});

test("timestamps are strictly increasing under a fixed clock; 250 adds retain the newest 200 FIFO", async () => {
  const file = tmpFile();
  const store = createNotificationStore({ file, now: () => 1_000 }); // frozen clock
  let first: NotificationRecord | null = null;
  for (let i = 0; i < 250; i++) {
    const rec = await store.add(input(i, { key: `ses_a:question:${i}`, kind: "question" }));
    first ??= rec;
  }
  const { items, unread } = await store.list();
  assert.equal(items.length, NOTIFICATION_CAP);
  assert.equal(unread, NOTIFICATION_CAP);
  assert.ok(!items.some((r) => r.id === first!.id), "oldest row evicted regardless of read state");
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i]!.ts > items[i - 1]!.ts, "ts must be strictly increasing");
  }

  // Disk and reload retain exactly the newest 200 in oldest-first order.
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number; items: Array<{ record: NotificationRecord }> };
  assert.equal(onDisk.version, 2);
  assert.deepEqual(onDisk.items.map((r) => r.record.id), items.map((r) => r.id));
  const reloaded = await createNotificationStore({ file }).list();
  assert.deepEqual(reloaded.items.map((r) => r.id), items.map((r) => r.id));

  // Restart keeps the cursor monotonic even with the same frozen clock.
  const again = createNotificationStore({ file, now: () => 1_000 });
  const next = await again.add(input(999));
  assert.ok(next.ts > items[items.length - 1]!.ts);
});

test("two records with the same stable key keep distinct ids and both stay in history", async () => {
  const store = createNotificationStore({ file: tmpFile() });
  const a = await store.add(input(1));
  const b = await store.add(input(2)); // same key "ses_a:turn:idle"
  assert.equal(a.key, b.key);
  assert.notEqual(a.id, b.id);
  const { items } = await store.list();
  assert.deepEqual(items.map((r) => r.id), [a.id, b.id]);
});

test("add validates its input with typed errors", async () => {
  const store = createNotificationStore({ file: tmpFile() });
  await assert.rejects(store.add(input(1, { key: "" })), (e: Error & { code?: string }) => e.code === "invalid-input");
  await assert.rejects(store.add(input(1, { sessionId: "" })), (e: Error & { code?: string }) => e.code === "invalid-input");
  await assert.rejects(store.add(input(1, { projectId: "" })), (e: Error & { code?: string }) => e.code === "invalid-input");
  await assert.rejects(
    store.add({ ...input(1), kind: "explosion" as never }),
    (e: Error & { code?: string }) => e.code === "invalid-input",
  );
});

test("read is idempotent for duplicate, unknown, and already-read ids; no-ops never write", async () => {
  const file = tmpFile();
  const store = createNotificationStore({ file });
  const a = await store.add(input(1));
  const b = await store.add(input(2));

  assert.deepEqual(await store.read([a.id, a.id, "ghost"]), { updated: 1, unread: 1 });
  assert.deepEqual(await store.read([a.id]), { updated: 0, unread: 1 });

  // An unchanged read/read-all/clear must not touch disk: delete the file and
  // verify no-op mutations do not recreate it.
  assert.deepEqual(await store.read([b.id]), { updated: 1, unread: 0 });
  unlinkSync(file);
  assert.deepEqual(await store.read([a.id, b.id]), { updated: 0, unread: 0 });
  assert.deepEqual(await store.readAll(), { updated: 0, unread: 0 });
  assert.equal(existsSync(file), false, "idempotent no-ops never rewrite the file");
});

test("read-all and clear are idempotent", async () => {
  const store = createNotificationStore({ file: tmpFile() });
  await store.add(input(1));
  await store.add(input(2));
  await store.add(input(3));

  assert.deepEqual(await store.readAll(), { updated: 3, unread: 0 });
  assert.deepEqual(await store.readAll(), { updated: 0, unread: 0 });
  assert.deepEqual(await store.clear(), { cleared: 3, unread: 0 });
  assert.deepEqual(await store.clear(), { cleared: 0, unread: 0 });
  assert.deepEqual(await store.list(), { items: [], unread: 0 });
});

test("list(after) returns only ts > after while unread covers the whole inbox", async () => {
  const store = createNotificationStore({ file: tmpFile(), now: () => 100 });
  const a = await store.add(input(1));
  const b = await store.add(input(2));
  const c = await store.add(input(3));
  await store.read([c.id]);

  const all = await store.list(0);
  assert.deepEqual(all.items.map((r) => r.id), [a.id, b.id, c.id]);
  assert.equal(all.unread, 2);

  const after = await store.list(a.ts);
  assert.deepEqual(after.items.map((r) => r.id), [b.id, c.id]);
  assert.equal(after.unread, 2, "unread stays global under a cursor");

  assert.deepEqual((await store.list(c.ts)).items, []);
});

test("concurrent add/read/clear serialize without resurrecting an older snapshot", async () => {
  const file = tmpFile();
  const store = createNotificationStore({ file });
  const seed = await store.add(input(0));
  await Promise.all([
    store.add(input(1)),
    store.read([seed.id]),
    store.add(input(2)),
    store.clear(),
    store.add(input(3)),
  ]);
  // The chain runs in call order: add, read, add, clear, add → one row left.
  const { items, unread } = await store.list();
  assert.equal(items.length, 1);
  assert.equal(unread, 1);
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as { items: Array<{ record: NotificationRecord }> };
  assert.deepEqual(onDisk.items.map((r) => r.record.id), items.map((r) => r.id));
});

test("failed persistence never publishes a non-durable add, read, or clear in memory", async () => {
  const blockedDir = mkdtempSync(join(tmpdir(), "polyth-ntf-blocked-"));
  const blockedParent = join(blockedDir, "not-a-directory");
  writeFileSync(blockedParent, "x");
  const addStore = createNotificationStore({ file: join(blockedParent, "notifications.json") });
  await assert.rejects(addStore.add(input(1)));
  assert.deepEqual(await addStore.list(), { items: [], unread: 0 });

  const readFile = tmpFile();
  const readStore = createNotificationStore({ file: readFile });
  const unread = await readStore.add(input(2));
  unlinkSync(readFile);
  mkdirSync(readFile);
  await assert.rejects(readStore.read([unread.id]));
  assert.deepEqual(
    (await readStore.list()).items.map((row) => [row.id, row.read]),
    [[unread.id, false]],
  );

  const clearFile = tmpFile();
  const clearStore = createNotificationStore({ file: clearFile });
  const retained = await clearStore.add(input(3));
  unlinkSync(clearFile);
  mkdirSync(clearFile);
  await assert.rejects(clearStore.clear());
  assert.deepEqual((await clearStore.list()).items.map((row) => row.id), [retained.id]);
});

test("restart retains rows and read state exactly", async () => {
  const file = tmpFile();
  const store = createNotificationStore({ file });
  const a = await store.add(input(1, { kind: "permission", key: "ses_a:permission:1" }));
  await store.add(input(2, { kind: "failed", key: "ses_a:turn:failed" }));
  await store.read([a.id]);

  const reloaded = createNotificationStore({ file });
  const { items, unread } = await reloaded.list();
  assert.equal(items.length, 2);
  assert.equal(unread, 1);
  assert.deepEqual(items.map((r) => [r.kind, r.read]), [["permission", true], ["failed", false]]);
});

// ---- routes ------------------------------------------------------------------

function routeHarness(store: NotificationStore) {
  const routes = notificationRoutes(store);
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const url = new URL(`http://x${path}`);
    const rc = {
      req: {}, res: {},
      url,
      path: url.pathname, method,
      body: async () => body,
      space: { userId: "__isolated_test__", spaceId: "__isolated_test__" },
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload };
  };
  return { call };
}

test("GET /api/notifications lists oldest-first with a global unread count; after cursor filters", async () => {
  const store = createNotificationStore({ file: tmpFile() });
  const a = await store.add(input(1));
  const b = await store.add(input(2, { kind: "question", key: "ses_a:question:1" }));
  await store.read([b.id]);
  const { call } = routeHarness(store);

  const all = await call("GET", "/api/notifications");
  assert.equal(all.status, 200);
  const listed = all.payload as { items: NotificationRecord[]; unread: number };
  assert.deepEqual(listed.items.map((r) => r.id), [a.id, b.id]);
  assert.equal(listed.unread, 1);

  const after = await call("GET", `/api/notifications?after=${a.ts}`);
  const filtered = after.payload as { items: NotificationRecord[]; unread: number };
  assert.deepEqual(filtered.items.map((r) => r.id), [b.id]);
  assert.equal(filtered.unread, 1, "unread stays global under a cursor");
});

test("read/read-all/clear routes respond with typed counters", async () => {
  const store = createNotificationStore({ file: tmpFile() });
  const a = await store.add(input(1));
  await store.add(input(2));
  const { call } = routeHarness(store);

  const read = await call("POST", "/api/notifications/read", { ids: [a.id, a.id, "ghost"] });
  assert.deepEqual(read.payload, { updated: 1, unread: 1 });

  const emptyNoop = await call("POST", "/api/notifications/read", { ids: [] });
  assert.deepEqual(emptyNoop.payload, { updated: 0, unread: 1 });

  const readAll = await call("POST", "/api/notifications/read-all");
  assert.deepEqual(readAll.payload, { updated: 1, unread: 0 });
  assert.deepEqual((await call("POST", "/api/notifications/read-all")).payload, { updated: 0, unread: 0 });

  const cleared = await call("POST", "/api/notifications/clear");
  assert.deepEqual(cleared.payload, { cleared: 2, unread: 0 });
  assert.deepEqual((await call("POST", "/api/notifications/clear")).payload, { cleared: 0, unread: 0 });
});

test("invalid after and malformed/oversized ids raise typed invalid-input with a field", async () => {
  const store = createNotificationStore({ file: tmpFile() });
  const { call } = routeHarness(store);
  const isInvalid = (field: string) => (e: Error & { code?: string; field?: string }) =>
    e.code === "invalid-input" && e.field === field;

  await assert.rejects(call("GET", "/api/notifications?after=soon"), isInvalid("after"));
  await assert.rejects(call("GET", "/api/notifications?after=-1"), isInvalid("after"));
  await assert.rejects(call("GET", "/api/notifications?after=1.5"), isInvalid("after"));

  await assert.rejects(call("POST", "/api/notifications/read", {}), isInvalid("ids"));
  await assert.rejects(call("POST", "/api/notifications/read", { ids: "x" }), isInvalid("ids"));
  await assert.rejects(call("POST", "/api/notifications/read", { ids: [""] }), isInvalid("ids"));
  await assert.rejects(call("POST", "/api/notifications/read", { ids: [42] }), isInvalid("ids"));
  await assert.rejects(call("POST", "/api/notifications/read", { ids: ["x".repeat(129)] }), isInvalid("ids"));
  await assert.rejects(
    call("POST", "/api/notifications/read", { ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) }),
    isInvalid("ids"),
  );
});

test("mutation bodies cannot select a project or session scope", async () => {
  const store = createNotificationStore({ file: tmpFile() });
  const mine = await store.add(input(1, { sessionId: "ses_mine", projectId: "p_mine" }));
  const other = await store.add(input(2, { sessionId: "ses_other", projectId: "p_other" }));
  const { call } = routeHarness(store);

  // Extra scope fields in the body are ignored: only the opaque ids matter,
  // and they can never widen a mutation to another project's rows.
  const r = await call("POST", "/api/notifications/read", {
    ids: [mine.id], projectId: "p_other", sessionId: "ses_other",
  });
  assert.deepEqual(r.payload, { updated: 1, unread: 1 });
  const { items } = await store.list();
  assert.deepEqual(
    items.map((row) => [row.id, row.read]),
    [[mine.id, true], [other.id, false]],
  );
});

test("unmatched paths and methods fall through to the next handler", async () => {
  const store = createNotificationStore({ file: tmpFile() });
  const { call } = routeHarness(store);
  assert.equal((await call("DELETE", "/api/notifications")).handled, false);
  assert.equal((await call("GET", "/api/notifications/read")).handled, false);
  assert.equal((await call("POST", "/api/notifications")).handled, false);
  assert.equal((await call("GET", "/api/other")).handled, false);
});

test("records, ids, recipient policies, and revocation are account/Space scoped", async () => {
  const allowed = new Set(["usr_a\0sp_a", "usr_b\0sp_b"]);
  const store = createNotificationStore({
    file: tmpFile(),
    hasAccess: (account) => allowed.has(`${account.userId}\0${account.spaceId}`),
  });
  const a = { userId: "usr_a", spaceId: "sp_a" };
  const b = { userId: "usr_b", spaceId: "sp_b" };
  const one = await store.add(a, input(1, { sessionId: "ses_same", projectId: "prj_same" }));
  const two = await store.add(b, input(2, { sessionId: "ses_same", projectId: "prj_same" }));
  assert.ok(one && two);
  assert.deepEqual((await store.list(a)).items.map((row) => row.id), [one.id]);
  assert.deepEqual((await store.list(b)).items.map((row) => row.id), [two.id]);
  assert.equal(await store.get(b, one.id), undefined);
  assert.deepEqual(await store.read(b, [one.id]), { updated: 0, unread: 1 });
  assert.deepEqual(await store.read(a, [two.id]), { updated: 0, unread: 1 });
  assert.deepEqual(await store.clear(a), { cleared: 1, unread: 0 });
  assert.deepEqual((await store.list(b)).items.map((row) => row.id), [two.id]);
  assert.deepEqual(await store.readAll(a), { updated: 0, unread: 0 });
  assert.deepEqual(await store.readAll(b), { updated: 1, unread: 0 });
  assert.equal(await store.registerSessionRecipient("ses_same", a), true);
  assert.equal(await store.registerSessionRecipient("ses_same", b), true);
  assert.deepEqual(await store.recipientForSession("ses_same", { spaceId: "sp_a" }), a);
  assert.deepEqual(await store.recipientForSession("ses_same", { spaceId: "sp_b" }), b);
  allowed.delete("usr_a\0sp_a");
  assert.deepEqual(await store.list(a), { items: [], unread: 0 });
  assert.equal(await store.get(a, one.id), undefined);
  assert.equal(await store.recipientForSession("ses_same", { spaceId: "sp_a" }), undefined);

  assert.deepEqual(await store.removeAccount(b.userId), { cleared: 1, recipients: 1 });
  assert.deepEqual(await store.list(b), { items: [], unread: 0 });
  assert.equal(await store.recipientForSession("ses_same", { spaceId: "sp_b" }), undefined);
});
