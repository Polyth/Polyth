// The navigators' open projects, shown-session counts, project sort and manual
// project order live in localStorage.
// The mobile app serves its shell from a new loopback port on every launch, so
// there localStorage starts empty; navigatorState mirrors the keys into the
// app-owned client-context store and puts them back before the first render.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientPersistenceWriteError,
  flushClientPersistence,
  setClientPersistenceBackend,
  writeClientRecord,
  type AsyncKeyValueStore,
  type PersistenceScope,
} from "../src/clientPersistence.ts";
import {
  EXPANDED_PROJECTS_KEY,
  hydrateNavigatorState,
  MOBILE_RAIL_MAP_KEY,
  PROJECT_ORDER_KEY,
  PROJECT_SORT_KEY,
  readNavigatorState,
  resetNavigatorStateForTest,
  SESSION_VISIBLE_COUNTS_KEY,
  SHOW_ALL_PROJECTS_KEY,
  writeNavigatorState,
} from "../src/navigatorState.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

/** One launch of the shell: its own, empty localStorage. */
function launch(): { storage: MemoryStorage; end(): void } {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  resetNavigatorStateForTest();
  return {
    storage,
    end() {
      setClientPersistenceBackend(null);
      resetNavigatorStateForTest();
      if (prior) Object.defineProperty(globalThis, "localStorage", prior);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    },
  };
}

interface FakeBackendOptions {
  get?: (key: string) => Promise<string | null>;
  set?: (key: string, value: string) => Promise<void>;
}

/** The Link proxy's record store: it outlives every launch of the shell. */
function fakeBackend(options: FakeBackendOptions = {}) {
  const records = new Map<string, string>();
  const calls = { get: 0, set: 0 };
  const store: AsyncKeyValueStore = {
    async get(key) {
      calls.get += 1;
      return options.get ? options.get(key) : records.get(key) ?? null;
    },
    async set(key, value) {
      calls.set += 1;
      if (options.set) return options.set(key, value);
      records.set(key, value);
    },
    async remove(key) { records.delete(key); },
  };
  return { store, records, calls };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(1);
  }
  assert.fail(message);
}

const owner: PersistenceScope = { connectionScope: "link-a", accountId: "usr_owner" };
const COUNTS = '{"tree:beta:worktree:__main__":18}';

async function saveEverything(backend: ReturnType<typeof fakeBackend>): Promise<void> {
  const first = launch();
  try {
    setClientPersistenceBackend(backend.store);
    assert.equal(await hydrateNavigatorState(owner), true, "an empty store hydrates");
    writeNavigatorState(EXPANDED_PROJECTS_KEY, '["alpha","beta"]');
    writeNavigatorState(SHOW_ALL_PROJECTS_KEY, '["beta"]');
    writeNavigatorState(SESSION_VISIBLE_COUNTS_KEY, COUNTS);
    await waitFor(() => backend.records.size === 3, "all three records reach the app-owned store");
  } finally {
    first.end();
  }
}

test("a browser has no app-owned store: navigator state stays in localStorage alone", async () => {
  const session = launch();
  try {
    setClientPersistenceBackend(null);
    assert.equal(await hydrateNavigatorState(owner), false);
    writeNavigatorState(EXPANDED_PROJECTS_KEY, '["alpha"]');
    assert.equal(readNavigatorState(EXPANDED_PROJECTS_KEY), '["alpha"]');
    assert.deepEqual([...session.storage.values.keys()], [EXPANDED_PROJECTS_KEY],
      "no mirrored client record is written next to the key");
  } finally {
    session.end();
  }
});

test("the mobile app gets its open projects and shown-session counts back on a new, empty origin", async () => {
  const backend = fakeBackend();
  await saveEverything(backend);

  // Next launch: the Link proxy picked another port, so nothing is stored.
  const second = launch();
  try {
    setClientPersistenceBackend(backend.store);
    assert.equal(readNavigatorState(EXPANDED_PROJECTS_KEY), null, "the new origin starts empty");
    assert.equal(await hydrateNavigatorState(owner), true);
    assert.equal(readNavigatorState(EXPANDED_PROJECTS_KEY), '["alpha","beta"]');
    assert.equal(readNavigatorState(SHOW_ALL_PROJECTS_KEY), '["beta"]');
    assert.equal(readNavigatorState(SESSION_VISIBLE_COUNTS_KEY), COUNTS);
  } finally {
    second.end();
  }
});

test("saved counts reach the wide navigator's in-memory store after the app restores them", async () => {
  const { getVisibleSessionCount } = await import("../src/sidebarPrefs.ts");
  const backend = fakeBackend();
  const first = launch();
  try {
    setClientPersistenceBackend(backend.store);
    await hydrateNavigatorState(owner);
    writeNavigatorState(SESSION_VISIBLE_COUNTS_KEY, '{"tree:restored:worktree:__main__":24}');
    await waitFor(() => backend.records.size === 1, "the counts reach the app-owned store");
  } finally {
    first.end();
  }

  const second = launch();
  try {
    setClientPersistenceBackend(backend.store);
    // sidebarPrefs read an empty localStorage when the module loaded.
    assert.equal(getVisibleSessionCount("restored", "tree", 6, "__main__"), 6);
    await hydrateNavigatorState(owner);
    assert.equal(getVisibleSessionCount("restored", "tree", 6, "__main__"), 24);
  } finally {
    second.end();
  }
});

test("the project sort and the manual order come back after the app restores them", async () => {
  const { getProjectOrder, getProjectSortMode, setProjectOrder, setProjectSortMode } = await import("../src/sidebarPrefs.ts");
  const backend = fakeBackend();
  const first = launch();
  try {
    setClientPersistenceBackend(backend.store);
    await hydrateNavigatorState(owner);
    setProjectSortMode("manual");
    setProjectOrder(["beta", "alpha", "gamma"]);
    await waitFor(() => backend.records.size === 2, "the sort and the order reach the app-owned store");
  } finally {
    first.end();
  }

  const second = launch();
  try {
    // A new page: its module copy starts from the empty origin.
    setProjectSortMode("recent");
    setProjectOrder([]);
    second.storage.values.clear();
    setClientPersistenceBackend(backend.store);
    assert.equal(readNavigatorState(PROJECT_SORT_KEY), null, "the new origin starts empty");
    assert.equal(getProjectSortMode(), "recent");
    await hydrateNavigatorState(owner);
    assert.equal(readNavigatorState(PROJECT_SORT_KEY), "manual");
    assert.equal(readNavigatorState(PROJECT_ORDER_KEY), '["beta","alpha","gamma"]');
    // sidebarPrefs caches both in memory; the restore must reach that copy.
    assert.equal(getProjectSortMode(), "manual");
    assert.deepEqual(getProjectOrder(), ["beta", "alpha", "gamma"]);
  } finally {
    setProjectSortMode("recent");
    setProjectOrder([]);
    second.end();
  }
});

test("the composer button arrangement comes back after the app restores it", async () => {
  const { mobileRailKey, readMobileRail } = await import("../src/composer/mobileRail.ts");
  const key = mobileRailKey("space-rail", "project-rail");
  const arrangement = JSON.stringify({ v: 1, slots: ["host:add", "widget:dictation"] });
  const backend = fakeBackend();
  const first = launch();
  try {
    setClientPersistenceBackend(backend.store);
    await hydrateNavigatorState(owner);
    // The rail store writes its whole map under one navigator-state key; that
    // write is what makes an arrangement survive a fresh mobile origin.
    writeNavigatorState(MOBILE_RAIL_MAP_KEY, JSON.stringify({ [key]: arrangement }));
    await waitFor(() => backend.records.size === 1, "the arrangement reaches the app-owned store");
  } finally {
    first.end();
  }

  const second = launch();
  try {
    setClientPersistenceBackend(backend.store);
    assert.equal(readMobileRail(key), null, "the new origin starts empty");
    await hydrateNavigatorState(owner);
    assert.equal(readMobileRail(key), arrangement);
  } finally {
    second.end();
  }
});

test("a record the page has not read is never overwritten by its defaults", async () => {
  const backend = fakeBackend();
  await saveEverything(backend);
  const saved = new Map(backend.records);

  // The store does not answer in time: the page runs on localStorage alone.
  const pending: Array<(value: string | null) => void> = [];
  const stalled = fakeBackend({ get: () => new Promise((resolve) => pending.push(resolve)) });
  for (const [key, value] of saved) stalled.records.set(key, value);
  const second = launch();
  try {
    setClientPersistenceBackend(stalled.store);
    assert.equal(await hydrateNavigatorState(owner, 20), false, "hydration gives up");
    writeNavigatorState(EXPANDED_PROJECTS_KEY, '["gamma"]');
    assert.equal(readNavigatorState(EXPANDED_PROJECTS_KEY), '["gamma"]', "localStorage still works");
    await sleep(30);
    assert.equal(stalled.calls.set, 0, "the saved record is not replaced by this page's defaults");

    // A read that finally answers must not rewrite what the page already runs on.
    for (const resolve of pending) resolve('["old"]');
    await sleep(30);
    assert.equal(readNavigatorState(EXPANDED_PROJECTS_KEY), '["gamma"]');
    assert.equal(stalled.calls.set, 0);
  } finally {
    second.end();
  }
});

test("a write is sent once and only while the store that was read is still the store", async () => {
  const backend = fakeBackend();
  const session = launch();
  try {
    setClientPersistenceBackend(backend.store);
    await hydrateNavigatorState(owner);
    writeNavigatorState(EXPANDED_PROJECTS_KEY, '["alpha"]');
    writeNavigatorState(EXPANDED_PROJECTS_KEY, '["alpha"]');
    await waitFor(() => backend.calls.set >= 1, "the first write is sent");
    await sleep(30);
    assert.equal(backend.calls.set, 1, "an unchanged value is not sent again");

    const other = fakeBackend();
    setClientPersistenceBackend(other.store);
    writeNavigatorState(EXPANDED_PROJECTS_KEY, '["beta"]');
    await sleep(30);
    assert.equal(other.calls.set, 0, "a replaced store was never read, so it is not written");
    assert.equal(backend.calls.set, 1);
    assert.equal(readNavigatorState(EXPANDED_PROJECTS_KEY), '["beta"]', "localStorage still follows the page");
  } finally {
    session.end();
  }
});

test("records are scoped to the connection and the account", async () => {
  const backend = fakeBackend();
  await saveEverything(backend);

  for (const scope of [
    { connectionScope: "link-b", accountId: "usr_owner" },
    { connectionScope: "link-a", accountId: "usr_other" },
  ] satisfies PersistenceScope[]) {
    const session = launch();
    try {
      setClientPersistenceBackend(backend.store);
      assert.equal(await hydrateNavigatorState(scope), true);
      assert.equal(readNavigatorState(EXPANDED_PROJECTS_KEY), null,
        `${scope.connectionScope}/${scope.accountId} does not see another scope's open projects`);
      assert.equal(readNavigatorState(SESSION_VISIBLE_COUNTS_KEY), null);
    } finally {
      session.end();
    }
  }
});

test("a navigator write that fails or hangs never joins the barrier a send waits on", async () => {
  const failing = fakeBackend({ set: async () => { throw new Error("client persistence: HTTP 413"); } });
  const session = launch();
  try {
    setClientPersistenceBackend(failing.store);
    await hydrateNavigatorState(owner);
    writeNavigatorState(EXPANDED_PROJECTS_KEY, '["alpha"]');
    await waitFor(() => failing.calls.set === 1, "the write was attempted");
    await sleep(10);
    await flushClientPersistence();
    assert.equal(clientPersistenceWriteError(), null, "the failure is dropped");

    // Control: a recovery record on the same store does hold the send back.
    writeClientRecord("draft-control", owner, "x");
    await assert.rejects(flushClientPersistence(), /HTTP 413/);
  } finally {
    session.end();
  }

  const hung = fakeBackend({ set: () => new Promise<void>(() => {}) });
  const stalled = launch();
  try {
    setClientPersistenceBackend(hung.store);
    await hydrateNavigatorState(owner);
    writeNavigatorState(EXPANDED_PROJECTS_KEY, '["alpha"]');
    await waitFor(() => hung.calls.set === 1, "the write was attempted");
    const outcome = await Promise.race([
      flushClientPersistence().then(() => "flushed"),
      sleep(500).then(() => "held"),
    ]);
    assert.equal(outcome, "flushed", "a send is not held behind a stalled navigator write");
  } finally {
    stalled.end();
  }
});
