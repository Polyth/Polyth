// WP12: quota service — last-good staleness, backoff, in-flight dedup,
// malformed data, secret redaction, persistence across restart, no adapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuotaSnapshot } from "@polyth/contracts";
import { createUsageService, createFakeQuotaProvider, redactSecrets, type QuotaProvider } from "@polyth/usage";

const snapshot = (used: number): QuotaSnapshot => ({
  providerId: "p", windows: [{ id: "w", label: "W", used, limit: 100, unit: "requests" }],
  fetchedAt: Date.now(), stale: false,
});

test("no adapters → empty snapshot list; unknown refresh rejects", async () => {
  const svc = createUsageService();
  assert.deepEqual(svc.snapshots(), []);
  await assert.rejects(() => svc.refresh("nope"), /unknown quota provider/);
});

test("last-good snapshot renders stale with reason after a failure", async () => {
  let fail = false;
  const provider: QuotaProvider = {
    id: "p",
    async fetch() {
      if (fail) throw new Error("HTTP 500 from provider");
      return snapshot(10);
    },
  };
  const svc = createUsageService();
  svc.register(provider);

  const good = await svc.refresh("p");
  assert.equal(good.stale, false);
  assert.equal(good.windows[0]?.used, 10);

  fail = true;
  const degraded = await svc.refresh("p");
  assert.equal(degraded.stale, true);
  assert.equal(degraded.windows[0]?.used, 10); // last-good values preserved
  assert.match(degraded.error!.message, /HTTP 500/);

  // recovery clears the stale flag
  fail = false;
  // (backoff applies to polling, not explicit refresh)
  const recovered = await svc.refresh("p");
  assert.equal(recovered.stale, false);
  assert.equal(recovered.error, undefined);
});

test("provider that never succeeded reports an honest empty stale snapshot", async () => {
  const svc = createUsageService();
  svc.register({ id: "p", fetch: async () => { throw new Error("no auth"); } });
  await svc.refresh("p");
  const [view] = svc.snapshots();
  assert.equal(view!.stale, true);
  assert.deepEqual(view!.windows, []);
});

test("malformed numbers fail sanitization and keep last-good", async () => {
  let malformed = false;
  const svc = createUsageService();
  svc.register({
    id: "p",
    async fetch() {
      if (malformed) return { ...snapshot(1), windows: [{ id: "w", label: "W", used: Number.NaN, limit: 100, unit: "requests" }] } as QuotaSnapshot;
      return snapshot(5);
    },
  });
  await svc.refresh("p");
  malformed = true;
  const view = await svc.refresh("p");
  assert.equal(view.stale, true);
  assert.match(view.error!.message, /malformed/);
  assert.equal(view.windows[0]?.used, 5);
});

test("parallel clients share one in-flight fetch", async () => {
  let calls = 0;
  let release: (v: QuotaSnapshot) => void = () => {};
  const svc = createUsageService();
  svc.register({
    id: "p",
    fetch: () => { calls += 1; return new Promise((r) => { release = r; }); },
  });
  const a = svc.refresh("p");
  const b = svc.refresh("p");
  release(snapshot(3));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual(ra, rb);
});

test("secret redaction removes tokens from error text", async () => {
  const redacted = redactSecrets("Authorization: Bearer sk-abcdef1234567890abcdef1234567890");
  assert.ok(!redacted.includes("sk-abcdef"), redacted);
  assert.ok(!/bearer\s+\S{10,}/i.test(redacted), redacted);
  assert.match(redactSecrets("failed with key=sk-super-secret-value-000111222333"), /\[redacted\]/);
  const svc = createUsageService();
  svc.register({ id: "p", fetch: async () => { throw new Error("401 for token abcdefghijklmnopqrstuvwxyz012345"); } });
  const view = await svc.refresh("p");
  assert.ok(!view.error!.message.includes("abcdefghijklmnopqrstuvwxyz012345"));
});

test("last-good snapshots persist across restart, marked stale until refetched", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-usage-")), "quotas.json");
  const first = createUsageService({ file });
  first.register({ id: "p", fetch: async () => snapshot(42) });
  await first.refresh("p");

  const second = createUsageService({ file });
  second.register({ id: "p", fetch: async () => snapshot(43) });
  const restored = second.snapshots()[0]!;
  assert.equal(restored.stale, true);
  assert.equal(restored.windows[0]?.used, 42);
  assert.equal(restored.error?.code, "not-refreshed");

  const fresh = await second.refresh("p");
  assert.equal(fresh.stale, false);
  assert.equal(fresh.windows[0]?.used, 43);
});

test("fake provider produces sane increasing windows", async () => {
  const p = createFakeQuotaProvider();
  const a = await p.fetch(new AbortController().signal);
  const b = await p.fetch(new AbortController().signal);
  assert.ok(b.windows[0]!.used > a.windows[0]!.used);
  assert.equal(a.windows.length, 2);
});
