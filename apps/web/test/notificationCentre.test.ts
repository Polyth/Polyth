// NTF-01 client slice (DOM-free): bootstrap/WS race merge by id, reconnect
// catch-up cursor, live append dedupe + cap, optimistic read/read-all/clear
// with per-row rollback, single notify per logical mutation, and the pure
// bell/panel helpers (badge text, accessible name, history filter, dead-
// session row gating).
import test from "node:test";
import assert from "node:assert/strict";
import type { NotificationRecord } from "@polyth/contracts";
import {
  NOTIFICATION_CENTRE_CAP, NOTIFICATION_KIND_LABELS,
  bellBadge, bellName, canOpenNotification, centreRows, createNotificationCentre,
  type NotificationCentre, type NotificationCentreRemote,
} from "../src/notificationCentre.ts";

const rec = (over: Partial<NotificationRecord> & { id: string; ts: number }): NotificationRecord => ({
  key: `${over.sessionId ?? "s1"}:turn:idle`, kind: "completed",
  sessionId: "s1", projectId: "p1",
  title: "Polyth — Session", body: "Session — finished", read: false,
  ...over,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Remote whose every call is recorded and manually resolvable. */
function fakeRemote() {
  const calls: Array<{ op: string; arg?: unknown }> = [];
  const lists: Array<Deferred<{ items: NotificationRecord[]; unread: number }>> = [];
  const reads: Array<Deferred<{ updated: number; unread: number }>> = [];
  const readAlls: Array<Deferred<{ updated: number; unread: number }>> = [];
  const clears: Array<Deferred<{ cleared: number; unread: number }>> = [];
  const remote: NotificationCentreRemote = {
    list(after) {
      calls.push({ op: "list", arg: after });
      const d = deferred<{ items: NotificationRecord[]; unread: number }>();
      lists.push(d);
      return d.promise;
    },
    read(ids) {
      calls.push({ op: "read", arg: [...ids] });
      const d = deferred<{ updated: number; unread: number }>();
      reads.push(d);
      return d.promise;
    },
    readAll() {
      calls.push({ op: "readAll" });
      const d = deferred<{ updated: number; unread: number }>();
      readAlls.push(d);
      return d.promise;
    },
    clear() {
      calls.push({ op: "clear" });
      const d = deferred<{ cleared: number; unread: number }>();
      clears.push(d);
      return d.promise;
    },
  };
  return { remote, calls, lists, reads, readAlls, clears };
}

/** Bootstrap a centre preloaded with rows (resolved immediately). */
async function seeded(items: NotificationRecord[], unread?: number) {
  const f = fakeRemote();
  const centre = createNotificationCentre(f.remote);
  const boot = centre.bootstrap();
  f.lists[0]!.resolve({ items, unread: unread ?? items.filter((r) => !r.read).length });
  await boot;
  return { centre, ...f };
}

// ---- bootstrap / catch-up / append merge -----------------------------------

test("bootstrap adopts server rows and unread; loading flag brackets the fetch", async () => {
  const f = fakeRemote();
  const centre = createNotificationCentre(f.remote);
  assert.deepEqual(centre.getState(), { items: [], unread: 0, loading: false, error: null });

  const boot = centre.bootstrap();
  assert.equal(centre.getState().loading, true);
  f.lists[0]!.resolve({ items: [rec({ id: "a", ts: 1 }), rec({ id: "b", ts: 2, read: true })], unread: 1 });
  await boot;

  const s = centre.getState();
  assert.deepEqual(s.items.map((r) => r.id), ["a", "b"]);
  assert.equal(s.unread, 1);
  assert.equal(s.loading, false);
  assert.equal(s.error, null);
});

test("delayed bootstrap racing an identical WS append yields ONE row (merge by id)", async () => {
  const f = fakeRemote();
  const centre = createNotificationCentre(f.remote);
  const boot = centre.bootstrap();

  // The WS copy of the same persisted record lands before the GET resolves.
  centre.append(rec({ id: "a", ts: 10 }));
  assert.equal(centre.getState().unread, 1);

  f.lists[0]!.resolve({ items: [rec({ id: "a", ts: 10 })], unread: 1 });
  await boot;

  const s = centre.getState();
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0]!.id, "a");
  assert.equal(s.unread, 1);
});

test("catchUp fetches after=max(local ts); an empty inbox catch-up fetches everything", async () => {
  const { centre, calls, lists } = await seeded([rec({ id: "a", ts: 5 }), rec({ id: "b", ts: 9 })]);

  const catchUp = centre.catchUp();
  assert.deepEqual(calls[calls.length - 1], { op: "list", arg: 9 });
  lists[1]!.resolve({ items: [rec({ id: "c", ts: 11 })], unread: 3 });
  await catchUp;
  assert.deepEqual(centre.getState().items.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(centre.getState().unread, 3); // server count is global truth

  const empty = createNotificationCentre(fakeRemote().remote);
  void empty.catchUp(); // must not throw; cursor is undefined on empty
});

test("overlapping bootstrap/catch-up fetches collapse into one request", async () => {
  const f = fakeRemote();
  const centre = createNotificationCentre(f.remote);
  const first = centre.bootstrap();
  void centre.catchUp(); // in-flight → no second request
  void centre.bootstrap();
  assert.equal(f.calls.length, 1);
  f.lists[0]!.resolve({ items: [], unread: 0 });
  await first;
});

test("bootstrap failure exposes a bounded retryable error and clears loading", async () => {
  const f = fakeRemote();
  const centre = createNotificationCentre(f.remote);
  const boot = centre.bootstrap();
  f.lists[0]!.reject(new Error("offline"));
  await boot;
  const s = centre.getState();
  assert.equal(s.loading, false);
  assert.ok(s.error !== null && s.error.length > 0);
  assert.ok(!s.error.includes("offline")); // bounded message, not raw error
});

test("append dedupes by id, increments unread only for unread rows, and caps FIFO", async () => {
  const many = Array.from({ length: NOTIFICATION_CENTRE_CAP }, (_, i) => rec({ id: `n${i}`, ts: i + 1, read: true }));
  const { centre } = await seeded(many, 0);

  centre.append(rec({ id: "n5", ts: 6, read: true })); // duplicate id → no-op
  assert.equal(centre.getState().items.length, NOTIFICATION_CENTRE_CAP);
  assert.equal(centre.getState().unread, 0);

  centre.append(rec({ id: "fresh", ts: 1000 })); // unread live row
  const s = centre.getState();
  assert.equal(s.items.length, NOTIFICATION_CENTRE_CAP); // capped
  assert.equal(s.items[0]!.id, "n1"); // oldest ("n0") evicted FIFO
  assert.equal(s.items[s.items.length - 1]!.id, "fresh");
  assert.equal(s.unread, 1);

  centre.append(rec({ id: "already-read", ts: 1001, read: true }));
  assert.equal(centre.getState().unread, 1); // read rows do not bump unread
});

// ---- optimistic mutations ----------------------------------------------------

test("markRead flips rows in ONE notification, then adopts the server unread", async () => {
  const { centre, reads, calls } = await seeded([
    rec({ id: "a", ts: 1 }), rec({ id: "b", ts: 2 }), rec({ id: "c", ts: 3, read: true }),
  ]);
  let notifies = 0;
  const off = centre.subscribe(() => { notifies++; });

  const p = centre.markRead(["a", "b"]);
  assert.equal(notifies, 1); // one logical mutation, not one per row
  assert.deepEqual(centre.getState().items.map((r) => r.read), [true, true, true]);
  assert.equal(centre.getState().unread, 0);
  assert.deepEqual(calls[calls.length - 1], { op: "read", arg: ["a", "b"] });

  reads[0]!.resolve({ updated: 2, unread: 0 });
  await p;
  assert.equal(centre.getState().unread, 0);
  assert.equal(centre.getState().error, null);
  off();
});

test("markRead failure restores only its own optimistic rows", async () => {
  const { centre, reads } = await seeded([rec({ id: "a", ts: 1 }), rec({ id: "b", ts: 2 })]);

  const p = centre.markRead(["a"]);
  // A live row lands while the POST is in flight — rollback must keep it.
  centre.append(rec({ id: "c", ts: 3 }));
  reads[0]!.reject(new Error("net"));
  await p;

  const s = centre.getState();
  assert.deepEqual(
    s.items.map((r) => [r.id, r.read]),
    [["a", false], ["b", false], ["c", false]],
  );
  assert.equal(s.unread, 3);
  assert.ok(s.error !== null);
});

test("markRead failure does not roll back a row superseded by newer server truth", async () => {
  const { centre, reads, lists } = await seeded([rec({ id: "a", ts: 1 })]);

  const p = centre.markRead(["a"]);
  // A catch-up merge lands a NEWER copy of the same row (server already read).
  const gap = centre.catchUp();
  lists[1]!.resolve({ items: [rec({ id: "a", ts: 1, read: true })], unread: 0 });
  await gap;

  reads[0]!.reject(new Error("net"));
  await p;
  const s = centre.getState();
  assert.equal(s.items[0]!.read, true); // server truth wins; no zombie unread
  assert.equal(s.unread, 0);
});

test("markRead of already-read or unknown ids still POSTs but changes nothing locally", async () => {
  const { centre, reads } = await seeded([rec({ id: "a", ts: 1, read: true })], 0);
  let notifies = 0;
  const off = centre.subscribe(() => { notifies++; });
  const p = centre.markRead(["a", "ghost"]);
  assert.equal(notifies, 0); // nothing flipped → no optimistic publish
  reads[0]!.resolve({ updated: 0, unread: 0 });
  await p;
  assert.equal(centre.getState().unread, 0);
  off();

  // Empty ids: valid idempotent no-op, no request at all.
  const f2 = fakeRemote();
  const c2 = createNotificationCentre(f2.remote);
  await c2.markRead([]);
  assert.equal(f2.calls.length, 0);
});

test("markAllRead flips everything optimistically and rolls back on failure", async () => {
  const { centre, readAlls } = await seeded([rec({ id: "a", ts: 1 }), rec({ id: "b", ts: 2, read: true })]);

  const p = centre.markAllRead();
  assert.equal(centre.getState().unread, 0);
  assert.ok(centre.getState().items.every((r) => r.read));

  readAlls[0]!.reject(new Error("net"));
  await p;
  const s = centre.getState();
  assert.deepEqual(s.items.map((r) => [r.id, r.read]), [["a", false], ["b", true]]);
  assert.equal(s.unread, 1);
  assert.ok(s.error !== null);
});

test("clear empties optimistically; failure restores rows but keeps mid-flight appends", async () => {
  const { centre, clears } = await seeded([rec({ id: "a", ts: 1 }), rec({ id: "b", ts: 2, read: true })]);

  const p = centre.clear();
  assert.deepEqual(centre.getState().items, []);
  assert.equal(centre.getState().unread, 0);

  centre.append(rec({ id: "c", ts: 3 })); // arrives while DELETE is in flight
  clears[0]!.reject(new Error("net"));
  await p;

  const s = centre.getState();
  assert.deepEqual(s.items.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(s.unread, 2); // recomputed from merged truth (a + c unread)
  assert.ok(s.error !== null);
});

test("clear success keeps the emptied inbox", async () => {
  const { centre, clears } = await seeded([rec({ id: "a", ts: 1 })]);
  const p = centre.clear();
  clears[0]!.resolve({ cleared: 1, unread: 0 });
  await p;
  assert.deepEqual(centre.getState(), { items: [], unread: 0, loading: false, error: null });
});

// ---- pure bell/panel helpers -------------------------------------------------

test("bell name always carries the exact count; badge is absent at zero and caps at 99+", () => {
  assert.equal(bellName(0), "Notifications, none unread");
  assert.equal(bellName(1), "Notifications, 1 unread");
  assert.equal(bellName(120), "Notifications, 120 unread");
  assert.equal(bellBadge(0), null);
  assert.equal(bellBadge(1), "1");
  assert.equal(bellBadge(99), "99");
  assert.equal(bellBadge(100), "99+");
});

test("centreRows shows newest first; history off keeps unread rows only", () => {
  const items = [
    rec({ id: "old-read", ts: 1, read: true }),
    rec({ id: "mid-unread", ts: 2 }),
    rec({ id: "new-read", ts: 3, read: true }),
  ];
  assert.deepEqual(centreRows(items, true).map((r) => r.id), ["new-read", "mid-unread", "old-read"]);
  assert.deepEqual(centreRows(items, false).map((r) => r.id), ["mid-unread"]);
  assert.equal(items[0]!.id, "old-read"); // input order untouched (pure)
});

test("canOpenNotification requires the SAME session id and project id in the registry", () => {
  const sessions = [
    { id: "s1", projectId: "p1" },
    { id: "s2", projectId: "p2" },
  ];
  assert.equal(canOpenNotification(rec({ id: "x", ts: 1 }), sessions), true);
  assert.equal(canOpenNotification(rec({ id: "x", ts: 1, sessionId: "gone" }), sessions), false);
  // Project mismatch is dead even though the session id exists.
  assert.equal(canOpenNotification(rec({ id: "x", ts: 1, sessionId: "s2", projectId: "p1" }), sessions), false);
});

test("every canonical kind has a non-color textual label", () => {
  for (const kind of ["completed", "failed", "question", "permission", "subagent"] as const) {
    assert.ok(NOTIFICATION_KIND_LABELS[kind].length > 0);
  }
});

// Type-only sanity: the exported factory returns the public interface.
const _typecheck: (remote: NotificationCentreRemote) => NotificationCentre = createNotificationCentre;
void _typecheck;
