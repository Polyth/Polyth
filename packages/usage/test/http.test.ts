// F13 quota half: config-driven HTTP quota adapter — spec validation, bearer
// credential from env, windows extraction, and degradation through the
// service's stale-with-reason path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpQuotaProvider, createUsageService, parseQuotaProviderSpecs } from "@polyth/usage";

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

test("parseQuotaProviderSpecs validates entries and rejects malformed config", () => {
  const specs = parseQuotaProviderSpecs([
    { id: "openai", url: "https://api.example.com/quota", bearerEnv: "OPENAI_ADMIN_KEY" },
    { id: "local", url: "http://127.0.0.1:9999/q", windowsPath: "data.windows", accountLabel: "dev" },
  ]);
  assert.deepEqual(specs.map((s) => s.id), ["openai", "local"]);
  // wrapped form is accepted too
  assert.equal(parseQuotaProviderSpecs({ providers: [{ id: "a", url: "https://x.test/" }] }).length, 1);

  assert.throws(() => parseQuotaProviderSpecs("nope"), /must be an array/);
  assert.throws(() => parseQuotaProviderSpecs([{ url: "https://x.test/" }]), /\[0\]: missing id/);
  assert.throws(() => parseQuotaProviderSpecs([{ id: "a", url: "ftp://x.test/" }]), /url must be http/);
  assert.throws(
    () => parseQuotaProviderSpecs([{ id: "a", url: "https://x.test/" }, { id: "a", url: "https://y.test/" }]),
    /duplicate id/,
  );
  assert.throws(() => parseQuotaProviderSpecs([{ id: "a", url: "https://x.test/", headers: { n: 1 } }]), /string map/);
});

test("http provider fetches windows, sends bearer from env, never from config", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return jsonResponse({
      accountLabel: "team plan",
      windows: [{ id: "req", label: "Requests", used: 5, limit: 100, unit: "requests" }],
    });
  }) as typeof fetch;
  const provider = createHttpQuotaProvider(
    { id: "prov", url: "https://api.example.com/quota", bearerEnv: "PROV_KEY" },
    { fetchImpl, env: { PROV_KEY: "sekret" }, now: () => 42 },
  );
  const snap = await provider.fetch(new AbortController().signal);
  assert.equal(snap.providerId, "prov");
  assert.equal(snap.accountLabel, "team plan");
  assert.equal(snap.fetchedAt, 42);
  assert.deepEqual(snap.windows.map((w) => w.id), ["req"]);
  assert.equal(calls[0]!.headers.authorization, "Bearer sekret");

  // missing credential is an error, not an empty snapshot
  const missing = createHttpQuotaProvider(
    { id: "prov", url: "https://api.example.com/quota", bearerEnv: "PROV_KEY" },
    { fetchImpl, env: {} },
  );
  await assert.rejects(() => missing.fetch(new AbortController().signal), /PROV_KEY is not set/);
});

test("http provider follows windowsPath and accepts a bare array body", async () => {
  const nested = createHttpQuotaProvider(
    { id: "n", url: "https://x.test/", windowsPath: "data.windows" },
    { fetchImpl: (async () => jsonResponse({ data: { windows: [{ id: "w", label: "W", used: 1, limit: 2, unit: "requests" }] } })) as typeof fetch },
  );
  assert.equal((await nested.fetch(new AbortController().signal)).windows.length, 1);

  const bare = createHttpQuotaProvider(
    { id: "b", url: "https://x.test/" },
    { fetchImpl: (async () => jsonResponse([{ id: "w", label: "W", used: 1, limit: 2, unit: "requests" }])) as typeof fetch },
  );
  assert.equal((await bare.fetch(new AbortController().signal)).windows.length, 1);

  const broken = createHttpQuotaProvider(
    { id: "x", url: "https://x.test/" },
    { fetchImpl: (async () => jsonResponse({ nothing: true })) as typeof fetch },
  );
  await assert.rejects(() => broken.fetch(new AbortController().signal), /did not return a windows array/);

  const denied = createHttpQuotaProvider(
    { id: "d", url: "https://x.test/" },
    { fetchImpl: (async () => jsonResponse({}, 403)) as typeof fetch },
  );
  await assert.rejects(() => denied.fetch(new AbortController().signal), /HTTP 403/);
});

test("http provider degrades to stale-with-reason through the usage service", async () => {
  let fail = false;
  const fetchImpl = (async () => {
    if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    return jsonResponse({ windows: [{ id: "w", label: "W", used: 7, limit: 10, unit: "requests" }] });
  }) as typeof fetch;
  const svc = createUsageService();
  svc.register(createHttpQuotaProvider({ id: "h", url: "https://x.test/" }, { fetchImpl }));

  const good = await svc.refresh("h");
  assert.equal(good.stale, false);
  assert.equal(good.windows[0]?.used, 7);

  fail = true;
  const degraded = await svc.refresh("h");
  assert.equal(degraded.stale, true);
  assert.equal(degraded.windows[0]?.used, 7); // last-good preserved
  assert.ok(degraded.error);
});
