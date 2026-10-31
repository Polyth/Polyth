import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { QuotaSnapshot } from "@polyth/contracts";
import {
  createUsageLimitService,
  redactLimitSecrets,
  type QuotaProvider,
} from "@polyth/usage";

const HOUR = 60 * 60_000;
const BASE = 1_800_000_000_000;

const snapshot = (
  used: number,
  now = BASE,
  over: Partial<QuotaSnapshot> = {},
): QuotaSnapshot => ({
  providerId: "provider",
  accountLabel: "Pro",
  windows: [{
    id: "weekly",
    label: "Weekly limit",
    used,
    limit: 100,
    unit: "percent",
    periodMs: 10 * HOUR,
    resetsAt: BASE + 10 * HOUR,
  }],
  fetchedAt: now,
  stale: false,
  ...over,
});

test("limits keep the last good snapshot and expose stale reason after a failed refresh", async () => {
  let fail = false;
  const service = createUsageLimitService({ jitterMs: 0 });
  const provider: QuotaProvider = {
    id: "provider",
    async fetch() {
      if (fail) throw new Error("HTTP 500 from provider");
      return snapshot(20);
    },
  };
  service.register(provider);

  const good = await service.refresh("provider");
  assert.equal(good.stale, false);
  assert.equal(good.windows[0]?.used, 20);

  fail = true;
  const stale = await service.refresh("provider");
  assert.equal(stale.stale, true);
  assert.equal(stale.windows[0]?.used, 20);
  assert.match(stale.error?.message ?? "", /HTTP 500/);
});

test("a failed source retries at the next poll once its login changes, despite the backoff", async () => {
  const now = BASE;
  let login = "old";
  let fetches = 0;
  const service = createUsageLimitService({ jitterMs: 0, pollMs: HOUR, now: () => now });
  service.register({
    id: "provider",
    credentialFingerprint: () => login,
    async fetch() {
      fetches += 1;
      if (login === "old") throw Object.assign(new Error("token past its expiry"), { code: "login-renewing" });
      return snapshot(20);
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const poll = async () => {
    service.start();
    await settle();
    service.stop();
  };

  await poll();
  assert.equal(fetches, 1);
  assert.equal(service.snapshots()[0]?.error?.code, "login-renewing", "a provider's own error code is kept");
  await poll();
  assert.equal(fetches, 1, "the same failing login backs off");
  login = "renewed";
  await poll();
  assert.equal(fetches, 2, "a renewed login is fetched without waiting out the backoff");
  assert.equal(service.snapshots()[0]?.error, undefined);
});

test("balances are not presented as fake percentage windows", async () => {
  const service = createUsageLimitService();
  service.register({
    id: "provider",
    async fetch() {
      return snapshot(20, BASE, {
        windows: [
          {
            id: "weekly",
            label: "Weekly limit",
            used: 20,
            limit: 100,
            unit: "percent",
            periodMs: 10 * HOUR,
            resetsAt: BASE + 10 * HOUR,
          },
          {
            id: "credits_balance",
            label: "Credits balance · $14.20 available",
            used: 0,
            limit: 14.2,
            unit: "currency",
          },
          {
            id: "free_credits",
            label: "Free credits",
            used: 0,
            limit: 120,
            unit: "requests",
          },
        ],
      });
    },
  });

  const view = await service.refresh("provider");
  assert.deepEqual(view.windows.map((window) => window.id), ["weekly"]);
  assert.deepEqual(view.balances.map((balance) => balance.id), ["credits_balance", "free_credits"]);
  assert.equal(view.balances[0]?.amount, 14.2);
  assert.equal(view.balances[0]?.valueLabel, "$14.20 available");
});

test("pace history survives restart and keeps projections meaningful", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-limits-")), "limits.json");
  let now = BASE;
  let used = 10;
  const provider: QuotaProvider = {
    id: "provider",
    async fetch() {
      return snapshot(used, now);
    },
  };

  const first = createUsageLimitService({ file, now: () => now });
  first.register(provider);
  await first.refresh("provider");
  now += HOUR;
  used = 20;
  const secondPoint = await first.refresh("provider");
  assert.ok(secondPoint.pace.weekly?.predictedAtReset !== undefined);

  const restored = createUsageLimitService({ file, now: () => now });
  restored.register(provider);
  const view = restored.snapshots()[0]!;
  assert.equal(view.stale, true);
  assert.equal(view.windows[0]?.used, 20);
  assert.ok(view.pace.weekly?.predictedAtReset !== undefined);
});

test("parallel refreshes share one provider request", async () => {
  let calls = 0;
  let release!: (snapshot: QuotaSnapshot) => void;
  const service = createUsageLimitService();
  service.register({
    id: "provider",
    fetch: async () => {
      calls += 1;
      return new Promise<QuotaSnapshot>((resolve) => {
        release = resolve;
      });
    },
  });

  const first = service.refresh("provider");
  const second = service.refresh("provider");
  release(snapshot(10));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test("limit error redaction never exposes credential-shaped strings", async () => {
  const raw = "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const redacted = redactLimitSecrets(raw);
  assert.ok(!redacted.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.match(redacted, /\[redacted\]/);

  const service = createUsageLimitService();
  service.register({
    id: "provider",
    async fetch() {
      throw new Error("failed for token abcdefghijklmnopqrstuvwxyz012345");
    },
  });
  const view = await service.refresh("provider");
  assert.ok(!view.error?.message.includes("abcdefghijklmnopqrstuvwxyz"));
});

test("refreshAll returns every configured source without coupling to analytics", async () => {
  const service = createUsageLimitService();
  service.register({ id: "one", fetch: async () => ({ ...snapshot(1), providerId: "one" }) });
  service.register({ id: "two", fetch: async () => ({ ...snapshot(2), providerId: "two" }) });
  const refreshed = await service.refreshAll();
  assert.deepEqual(refreshed.map((provider) => provider.providerId).sort(), ["one", "two"]);
});
