import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverQuotaProviders,
  listConfiguredQuotaProviders,
  mapProviderUsage,
  redactSecrets,
  type QuotaDiscoveryOptions,
  type QuotaProvider,
} from "@polyth/usage";

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const provider = (providers: QuotaProvider[], id: string): QuotaProvider => {
  const found = providers.find((value) => value.id === id);
  assert.ok(found, `expected provider ${id}`);
  return found;
};

test("discovery finds nothing when auth and managed credentials are absent", () => {
  const opts: QuotaDiscoveryOptions = {
    readAuth: () => ({}),
    env: {},
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  };
  assert.deepEqual(listConfiguredQuotaProviders(opts), []);
  assert.deepEqual(discoverQuotaProviders(opts), []);
});

test("registry exposes every dispatcher provider and skips unconfigured entries", () => {
  const auth = {
    anthropic: { access: "claude-access" },
    openai: { access: "codex-access" },
    "command-code": { key: "command-key" },
    crof: { key: "crof-key" },
    deepseek: { key: "deepseek-key" },
    google: { access: "google-access" },
    "github-copilot": { access: "copilot-access" },
    "kimi-for-coding": { key: "kimi-key" },
    "nano-gpt": { key: "nano-key" },
    openrouter: { key: "openrouter-key" },
    "zai-coding-plan": { key: "zai-key" },
    "zhipuai-coding-plan": { key: "zhipu-key" },
    "minimax-coding-plan": { key: "minimax-key" },
    "minimax-cn-coding-plan": { key: "minimax-cn-key" },
    wafer: { key: "wafer-key" },
    "opencode-go": { key: "go-key" },
    neuralwatt: { key: "neural-key" },
    xai: { type: "oauth", access: "xai-access" },
  };
  const ids = listConfiguredQuotaProviders({
    readAuth: () => auth,
    env: { CURSOR_TOKEN: "cursor-access" },
    homedir: "/home/test",
    readFile: (path) => {
      if (path.endsWith("/quota/ollama-cloud.json")) return JSON.stringify({ cookie: "ollama-cookie" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.deepEqual(ids, [
    "claude",
    "codex",
    "command-code",
    "cursor",
    "crof",
    "deepseek",
    "google",
    "github-copilot",
    "kimi-for-coding",
    "nano-gpt",
    "openrouter",
    "zai-coding-plan",
    "zhipuai-coding-plan",
    "minimax-coding-plan",
    "minimax-cn-coding-plan",
    "ollama-cloud",
    "wafer",
    "opencode-go",
    "neuralwatt",
    "xai",
  ]);

  assert.deepEqual(listConfiguredQuotaProviders({
    readAuth: () => ({ openrouter: { key: "only-one" } }),
    env: {},
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  }), ["openrouter"]);
});

test("GitHub Copilot exposes standard and premium quotas as one provider", async () => {
  let calls = 0;
  const providers = discoverQuotaProviders({
    readAuth: () => ({ "github-copilot": { access: "copilot-secret" } }),
    env: {},
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({
        quota_reset_date: "2027-01-01T00:00:00Z",
        quota_snapshots: {
          chat: { entitlement: 100, remaining: 80 },
          completions: { entitlement: 200, remaining: 150 },
          premium_interactions: { entitlement: 50, remaining: 35 },
        },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(providers.map((value) => value.id), ["github-copilot"]);
  const snapshot = await providers[0]!.fetch(new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(snapshot.windows.map((window) => window.id), ["chat", "completions", "premium"]);
});

test("OpenRouter uses auth.json bearer credentials and maps spent/remaining credits", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return jsonResponse({ data: { total_credits: 100, total_usage: 25 } });
  }) as typeof fetch;
  const providers = discoverQuotaProviders({
    readAuth: () => ({ openrouter: { key: "or-secret" } }),
    fetchImpl,
    env: {},
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.deepEqual(providers.map((value) => value.id), ["openrouter"]);
  const snapshot = await provider(providers, "openrouter").fetch(new AbortController().signal);
  assert.deepEqual(calls, [{
    url: "https://openrouter.ai/api/v1/credits",
    authorization: "Bearer or-secret",
  }]);
  assert.equal(snapshot.accountLabel, "OpenRouter");
  assert.equal(snapshot.windows[0]?.id, "credits");
  assert.equal(snapshot.windows[0]?.used, 25);
  assert.equal(snapshot.windows[0]?.limit, 100);
  assert.equal(snapshot.windows[0]?.unit, "currency");
  assert.match(snapshot.windows[0]?.label ?? "", /75\.00 left.*25\.00 spent/);
});

test("Claude reads credentials without writing, maps limits and preserves last-good on 429", async () => {
  let now = 1_800_000_000_000;
  let fetches = 0;
  let writes = 0;
  const opts: QuotaDiscoveryOptions = {
    readAuth: () => ({}),
    writeAuth: () => { writes += 1; },
    writeManagedCredential: () => { writes += 1; },
    env: { CLAUDE_CONFIG_DIR: "/claude" },
    homedir: "/home/test",
    now: () => now,
    readFile: (path) => {
      if (path === "/claude/.credentials.json") {
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: "claude-secret",
            refreshToken: "claude-refresh",
            subscriptionType: "max",
          },
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      fetches += 1;
      assert.equal(String(input), "https://api.anthropic.com/api/oauth/usage");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer claude-secret");
      assert.equal(new Headers(init?.headers).get("anthropic-beta"), "oauth-2025-04-20");
      if (fetches > 1) return new Response("", { status: 429, headers: { "retry-after": "60" } });
      return jsonResponse({
        limits: [
          { kind: "session", percent: 12, resets_at: "2027-01-01T00:00:00Z" },
          { kind: "weekly_all", percent: 34, resets_at: "2027-01-02T00:00:00Z" },
          {
            kind: "weekly_scoped",
            percent: 56,
            resets_at: "2027-01-03T00:00:00Z",
            scope: { model: { display_name: "Sonnet" } },
          },
          { kind: "nimbus_quill", percent: 99 },
        ],
        spend: {
          enabled: true,
          percent: 25,
          used: { amount_minor: 250, exponent: 2, currency: "USD" },
          limit: { amount_minor: 1000, exponent: 2, currency: "USD" },
        },
      });
    }) as typeof fetch,
  };
  const claude = provider(discoverQuotaProviders(opts), "claude");
  const first = await claude.fetch(new AbortController().signal);
  assert.deepEqual(first.windows.map((window) => window.id), ["5h", "7d", "extra_usage", "sonnet/7d"]);
  assert.deepEqual(first.windows.map((window) => window.label), ["5h", "7d", "Extra usage", "Sonnet 7d"]);
  assert.deepEqual(first.windows.map((window) => [window.used, window.limit, window.unit]), [
    [12, 100, "percent"],
    [34, 100, "percent"],
    [2.5, 10, "currency"],
    [56, 100, "percent"],
  ]);
  assert.equal(first.accountLabel, "max");

  now += 1_000;
  const rateLimited = await claude.fetch(new AbortController().signal);
  assert.deepEqual(rateLimited.windows, first.windows);
  now += 10_000;
  const cooldownCached = await claude.fetch(new AbortController().signal);
  assert.deepEqual(cooldownCached.windows, first.windows);
  assert.equal(fetches, 2, "cooldown should avoid another Anthropic request");
  assert.equal(writes, 0, "Claude credentials must remain read-only");
});

test("Claude 401 explains that Claude Code must be opened and does not expose tokens", async () => {
  const secret = "claude-oauth-token-abcdefghijklmnopqrstuvwxyz";
  const claude = provider(discoverQuotaProviders({
    readAuth: () => ({ anthropic: { access: secret } }),
    env: {},
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async () => new Response("", { status: 401 })) as typeof fetch,
  }), "claude");
  await assert.rejects(
    () => claude.fetch(new AbortController().signal),
    (error: Error) => {
      assert.match(error.message, /Open Claude Code to sign in again/i);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("Codex maps primary/secondary percent windows and sends account scope", async () => {
  const calls: Array<{ url: string; account: string | null }> = [];
  const codex = provider(discoverQuotaProviders({
    readAuth: () => ({ openai: { access: "codex-secret", accountId: "acct-1" } }),
    env: {},
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), account: new Headers(init?.headers).get("chatgpt-account-id") });
      return jsonResponse({
        rate_limit: {
          primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
          secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: 1_900_604_800 },
        },
      });
    }) as typeof fetch,
  }), "codex");
  const snapshot = await codex.fetch(new AbortController().signal);
  assert.deepEqual(calls, [{ url: "https://chatgpt.com/backend-api/wham/usage", account: "acct-1" }]);
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used, window.limit, window.periodMs]), [
    ["5h", 20, 100, 18_000_000],
    ["7d", 60, 100, 604_800_000],
  ]);
  assert.equal(snapshot.windows[0]?.resetsAt, 1_900_000_000_000);
});

test("OpenCode Go uses the auth.json API key and deletes the obsolete credential unread", async () => {
  const unlinked: string[] = [];
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const go = provider(discoverQuotaProviders({
    readAuth: () => ({ "opencode-go": { key: "go-secret" } }),
    env: {},
    homedir: "/home/test",
    unlink: (path) => { unlinked.push(path); },
    readFile: (path) => {
      assert.ok(!path.endsWith("/opencode-go.json"), "obsolete credential must never be read");
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return jsonResponse({
        usage: {
          rolling: { percent: 17, resetsAt: "2027-01-01T00:00:00Z" },
          weekly: { percent: 42, resetsAt: "2027-01-07T00:00:00Z" },
        },
      });
    }) as typeof fetch,
  }), "opencode-go");
  const snapshot = await go.fetch(new AbortController().signal);
  assert.deepEqual(unlinked, ["/home/test/.config/polyth/quota/opencode-go.json"]);
  assert.deepEqual(calls, [{
    url: "https://opencode.ai/zen/go/v1/usage",
    authorization: "Bearer go-secret",
  }]);
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used, window.limit]), [
    ["5h", 17, 100],
    ["weekly", 42, 100],
  ]);
});

test("window mapping handles model scope and currency labels without fake percentages", () => {
  const windows = mapProviderUsage({
    windows: {
      balance: { valueLabel: "$12.50" },
      spend: { used: 2, limit: 10, valueLabel: "$2 / $10" },
      unknown: { valueLabel: "Unlimited" },
    },
    models: {
      Sonnet: { windows: { "7d": { usedPercent: 70, windowSeconds: 604_800 } } },
    },
  });
  assert.deepEqual(windows.map((window) => [window.id, window.used, window.limit, window.unit]), [
    ["balance", 0, 12.5, "currency"],
    ["spend", 2, 10, "currency"],
    ["unknown", 0, 0, "requests"],
    ["sonnet/7d", 70, 100, "percent"],
  ]);
});

test("adapter failures and usage-service redaction never include secret values", async () => {
  const secret = "sk-secret-abcdefghijklmnopqrstuvwxyz012345";
  const openrouter = provider(discoverQuotaProviders({
    readAuth: () => ({ openrouter: { key: secret } }),
    env: {},
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async () => { throw new Error(`network rejected ${secret}`); }) as typeof fetch,
  }), "openrouter");
  await assert.rejects(
    () => openrouter.fetch(new AbortController().signal),
    (error: Error) => {
      assert.ok(!error.message.includes(secret));
      assert.ok(!redactSecrets(error.message).includes(secret));
      return true;
    },
  );
});