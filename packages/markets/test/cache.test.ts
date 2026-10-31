import assert from "node:assert/strict";
import test from "node:test";
import { SwrCache } from "../src/cache.ts";

const policy = { softTtlMs: 10, hardTtlMs: 20, maxEntries: 8 };

test("SWR cache returns stale immediately and refreshes in the background", async () => {
  let now = 0;
  let calls = 0;
  let resolveRefresh: ((value: number) => void) | undefined;
  const cache = new SwrCache<number>(() => now);
  const load = async (): Promise<number> => {
    calls += 1;
    if (calls === 1) return 1;
    return await new Promise<number>((resolve) => { resolveRefresh = resolve; });
  };

  const initial = await cache.get("NVDA", policy, load);
  assert.equal(initial.value, 1);
  assert.equal(initial.state, "refreshed");

  now = 11;
  const stale = await cache.get("NVDA", policy, load);
  assert.equal(stale.value, 1);
  assert.equal(stale.state, "stale");
  assert.equal(stale.revalidating, true);
  assert.equal(calls, 2);

  resolveRefresh?.(2);
  await Promise.resolve();
  await Promise.resolve();

  now = 12;
  const fresh = await cache.get("NVDA", policy, load);
  assert.equal(fresh.value, 2);
  assert.equal(fresh.state, "fresh");
  assert.equal(calls, 2);
});

test("SWR cache coalesces hard-expired concurrent loads", async () => {
  let now = 0;
  let calls = 0;
  let resolveReload: ((value: number) => void) | undefined;
  const cache = new SwrCache<number>(() => now);
  const load = async (): Promise<number> => {
    calls += 1;
    if (calls === 1) return 1;
    return await new Promise<number>((resolve) => { resolveReload = resolve; });
  };

  await cache.get("NVDA", policy, load);
  now = 21;
  const first = cache.get("NVDA", policy, load);
  const second = cache.get("NVDA", policy, load);
  assert.equal(calls, 2);

  resolveReload?.(2);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.value, 2);
  assert.equal(b.value, 2);
  assert.equal(calls, 2);
});

test("SWR cache evicts least-recently-touched entries", async () => {
  let now = 0;
  const cache = new SwrCache<number>(() => now);
  const small = { softTtlMs: 10, hardTtlMs: 20, maxEntries: 2 };

  await cache.get("A", small, async () => 1);
  now += 1;
  await cache.get("B", small, async () => 2);
  now += 1;
  await cache.get("A", small, async () => 1);
  now += 1;
  await cache.get("C", small, async () => 3);

  assert.equal(cache.size(), 2);
  let bReloads = 0;
  await cache.get("B", small, async () => { bReloads += 1; return 20; });
  assert.equal(bReloads, 1);
});
