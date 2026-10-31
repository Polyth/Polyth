// The signed-in GitHub user is remembered per key (Space + person + account).
// These pin the properties the header avatar relies on: a good answer is not
// lost to a passing failure, `gh` is not spawned per request, and one key never
// answers for another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUserCache, type UserLoad } from "../src/userCache.ts";

const user = (login: string) => ({ login, avatarUrl: `https://avatars.example/${login}` });
const found = (login: string): UserLoad => ({ ok: true, user: user(login) });
const failed = (signedOut = false): UserLoad => ({ ok: false, signedOut });

/** A loader the test steers: every call is counted and answers `next`. */
function loader(first: UserLoad = found("kat")) {
  const state = { calls: 0, next: first, gate: null as Promise<void> | null };
  return {
    state,
    load: async (): Promise<UserLoad> => {
      state.calls += 1;
      if (state.gate) await state.gate;
      return state.next;
    },
  };
}

/** Let `void`ed background refreshes finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function clockedCache(extra: Parameters<typeof createUserCache>[0] = {}) {
  const clock = { now: 1_000 };
  const cache = createUserCache({ now: () => clock.now, freshMs: 1_000, maxStaleMs: 100_000, retryMs: 500, coldWaitMs: 25, ...extra });
  return { clock, cache };
}

test("concurrent lookups for one key share a single load", async () => {
  const { cache } = clockedCache();
  const l = loader();
  let release!: () => void;
  l.state.gate = new Promise<void>((resolve) => { release = resolve; });
  const asks = [cache.lookup("a", l.load), cache.lookup("a", l.load), cache.lookup("a", l.load)];
  release();
  assert.deepEqual(await Promise.all(asks), [user("kat"), user("kat"), user("kat")]);
  assert.equal(l.state.calls, 1);
});

test("a fresh answer is served without asking gh again", async () => {
  const { cache, clock } = clockedCache();
  const l = loader();
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"));
  clock.now += 999;
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"));
  assert.equal(l.state.calls, 1);
});

test("an older answer is served at once while one refresh runs behind it", async () => {
  const { cache, clock } = clockedCache();
  const l = loader();
  await cache.lookup("a", l.load);
  clock.now += 1_000;
  l.state.next = found("kat-renamed");
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"), "the ask does not wait for gh");
  await settle();
  assert.equal(l.state.calls, 2);
  assert.deepEqual(await cache.lookup("a", l.load), user("kat-renamed"));
  assert.equal(l.state.calls, 2, "the refreshed answer is fresh again");
});

test("a failed refresh keeps the good answer and is not retried within the quiet period", async () => {
  const { cache, clock } = clockedCache();
  const l = loader();
  await cache.lookup("a", l.load);
  clock.now += 1_000;
  l.state.next = failed();
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"));
  await settle();
  assert.equal(l.state.calls, 2);
  clock.now += 499;
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"));
  await settle();
  assert.equal(l.state.calls, 2, "no gh child per request while the lookup keeps failing");
  clock.now += 1;
  l.state.next = found("kat-again");
  await cache.lookup("a", l.load);
  await settle();
  assert.equal(l.state.calls, 3);
  assert.deepEqual(await cache.lookup("a", l.load), user("kat-again"));
});

test("a throwing loader counts as a passing failure", async () => {
  const { cache, clock } = clockedCache();
  const l = loader();
  await cache.lookup("a", l.load);
  clock.now += 1_000;
  assert.deepEqual(await cache.lookup("a", async () => { throw new Error("spawn failed"); }), user("kat"));
  await settle();
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"));
});

test("gh saying there is no account removes the remembered user", async () => {
  const { cache, clock } = clockedCache();
  const l = loader();
  await cache.lookup("a", l.load);
  clock.now += 1_000;
  l.state.next = failed(true);
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"), "this ask still gets the old answer");
  await settle();
  clock.now += 500;
  assert.equal(await cache.lookup("a", l.load), null);
});

test("with nothing remembered a failure answers null and is not retried within the quiet period", async () => {
  const { cache, clock } = clockedCache();
  const l = loader(failed());
  assert.equal(await cache.lookup("a", l.load), null);
  assert.equal(l.state.calls, 1);
  clock.now += 499;
  assert.equal(await cache.lookup("a", l.load), null);
  assert.equal(l.state.calls, 1);
  clock.now += 1;
  l.state.next = found("kat");
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"));
  assert.equal(l.state.calls, 2);
});

test("a slow first lookup answers null after the wait and still lands for the next ask", async () => {
  const { cache } = clockedCache();
  const l = loader();
  let release!: () => void;
  l.state.gate = new Promise<void>((resolve) => { release = resolve; });
  assert.equal(await cache.lookup("a", l.load), null, "does not hang the request on a slow gh");
  release();
  await settle();
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"));
  assert.equal(l.state.calls, 1, "the slow lookup was kept, not restarted");
});

test("an answer older than the stale limit is not served", async () => {
  const { cache, clock } = clockedCache({ maxStaleMs: 5_000 });
  const l = loader();
  await cache.lookup("a", l.load);
  clock.now += 5_001;
  l.state.next = found("kat-new");
  assert.deepEqual(await cache.lookup("a", l.load), user("kat-new"), "waits for a fresh answer instead of serving a stale one");
  assert.equal(l.state.calls, 2);
});

test("keys never answer for each other", async () => {
  const { cache } = clockedCache();
  assert.deepEqual(await cache.lookup("s1:alice:account:p-1", loader(found("alice")).load), user("alice"));
  assert.deepEqual(await cache.lookup("s1:bob:account:p-2", loader(found("bob")).load), user("bob"));
  const other = loader(failed());
  assert.equal(await cache.lookup("s2:alice:account:p-1", other.load), null, "the same account in another Space is its own key");
  assert.equal(other.state.calls, 1);
});

test("remember() records a live answer and ends a quiet period", async () => {
  const { cache } = clockedCache();
  const l = loader(failed());
  assert.equal(await cache.lookup("a", l.load), null);
  cache.remember("a", user("kat"));
  assert.deepEqual(await cache.lookup("a", l.load), user("kat"));
  assert.equal(l.state.calls, 1);
});

test("clear() forgets everything, including a lookup still in flight", async () => {
  const { cache } = clockedCache({ coldWaitMs: 1_000 });
  const l = loader();
  await cache.lookup("a", l.load);
  cache.clear();
  const slow = loader(found("late"));
  let release!: () => void;
  slow.state.gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = cache.lookup("b", slow.load);
  cache.clear();
  release();
  assert.equal(await pending, null, "a lookup started before clear() does not repopulate");
  await settle();
  const again = loader(found("kat"));
  assert.deepEqual(await cache.lookup("a", again.load), user("kat"));
  assert.equal(again.state.calls, 1, "the earlier answer was forgotten");
  assert.equal(await cache.lookup("b", loader(failed()).load), null, "and so was the late one");
});
