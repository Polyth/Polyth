import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverQuotaProviders,
  listConfiguredQuotaProviders,
  mapProviderUsage,
  parseAlibabaTokenPlanUsage,
  redactLimitSecrets,
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
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  };
  assert.deepEqual(listConfiguredQuotaProviders(opts), []);
  assert.deepEqual(discoverQuotaProviders(opts), []);
});

test("registry exposes every dispatcher provider and skips unconfigured entries", () => {
  const auth = {
    antigravity: { refresh: "antigravity-access" },
    anthropic: { access: "claude-access" },
    openai: { access: "codex-access" },
    "command-code": { key: "command-key" },
    chutes: { key: "chutes-key" },
    crof: { key: "crof-key" },
    deepseek: { key: "deepseek-key" },
    google: { access: "google-access" },
    "github-copilot": { access: "copilot-access" },
    kilo: { key: "kilo-key" },
    "kimi-for-coding": { key: "kimi-key" },
    "kimi-code-plan-global": { key: "kimi-global-key" },
    "nano-gpt": { key: "nano-key" },
    openrouter: { key: "openrouter-key" },
    synthetic: { key: "synthetic-key" },
    "zai-coding-plan": { key: "zai-key" },
    "zhipuai-coding-plan": { key: "zhipu-key" },
    "minimax-coding-plan": { key: "minimax-key" },
    "minimax-cn-coding-plan": { key: "minimax-cn-key" },
    wafer: { key: "wafer-key" },
    "opencode-go": { key: "go-key" },
    opencode: { type: "oauth", access: "zen-access", refresh: "zen-refresh", expires: 4_000_000_000_000 },
    neuralwatt: { key: "neural-key" },
    xai: { type: "oauth", access: "xai-access" },
  };
  const ids = listConfiguredQuotaProviders({
    readAuth: () => auth,
    env: { PATH: "", CURSOR_TOKEN: "cursor-access", MIMO_USAGE_COOKIE: "mimo-cookie" },
    homedir: "/home/test",
    readFile: (path) => {
      if (path.endsWith("/quota/ollama-cloud.json")) return JSON.stringify({ cookie: "ollama-cookie" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.deepEqual(ids, [
    "antigravity",
    "claude",
    "command-code",
    "opencode-zen",
    "codex",
    "cursor",
    "crof",
    "chutes",
    "deepseek",
    "google",
    "github-copilot",
    "kilo",
    "kimi-for-coding",
    "kimi-code-plan-global",
    "xiaomi",
    "nano-gpt",
    "openrouter",
    "synthetic",
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
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  }), ["openrouter"]);
});

test("GitHub Copilot exposes standard and premium quotas as one provider", async () => {
  let calls = 0;
  const providers = discoverQuotaProviders({
    readAuth: () => ({ "github-copilot": { access: "copilot-secret" } }),
    env: { PATH: "" },
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
    env: { PATH: "" },
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
    env: { PATH: "", CLAUDE_CONFIG_DIR: "/claude" },
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
    env: { PATH: "" },
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

test("Claude 401 on a token past its expiry waits for Claude Code to renew it, not for a sign-in", async () => {
  const now = 1_800_000_000_000;
  const claude = provider(discoverQuotaProviders({
    readAuth: () => ({}),
    env: { CLAUDE_CONFIG_DIR: "/claude" },
    homedir: "/home/test",
    now: () => now,
    readFile: (path) => {
      if (path === "/claude/.credentials.json") {
        return JSON.stringify({
          claudeAiOauth: { accessToken: "claude-secret", refreshToken: "claude-refresh", expiresAt: now - 60_000 },
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetchImpl: (async () => new Response("", { status: 401 })) as typeof fetch,
  }), "claude");
  await assert.rejects(
    () => claude.fetch(new AbortController().signal),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "login-renewing");
      assert.doesNotMatch(error.message, /sign in again|key/i);
      return true;
    },
  );
});

test("Claude 401 on a token expired past the renewal window asks for a sign-in", async () => {
  const now = 1_800_000_000_000;
  const claude = provider(discoverQuotaProviders({
    readAuth: () => ({}),
    env: { CLAUDE_CONFIG_DIR: "/claude" },
    homedir: "/home/test",
    now: () => now,
    readFile: (path) => {
      if (path === "/claude/.credentials.json") {
        return JSON.stringify({
          claudeAiOauth: { accessToken: "claude-secret", refreshToken: "claude-refresh", expiresAt: now - 25 * 60 * 60_000 },
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetchImpl: (async () => new Response("", { status: 401 })) as typeof fetch,
  }), "claude");
  await assert.rejects(
    () => claude.fetch(new AbortController().signal),
    (error: Error & { code?: string }) => {
      assert.notEqual(error.code, "login-renewing", "a refresh token unused for a day may be revoked");
      assert.match(error.message, /sign in again/i);
      return true;
    },
  );
});

test("Codex maps primary/secondary percent windows and sends account scope", async () => {
  const calls: Array<{ url: string; account: string | null }> = [];
  const codex = provider(discoverQuotaProviders({
    readAuth: () => ({ openai: { access: "codex-secret", accountId: "acct-1" } }),
    env: { PATH: "" },
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

test("Codex quota auth errors identify the feed without claiming the native session expired", async () => {
  for (const [status, expected] of [
    [401, "authentication failed"],
    [403, "access was denied"],
  ] as const) {
    const codex = provider(discoverQuotaProviders({
      readAuth: () => ({ openai: { access: "codex-secret" } }),
      env: { PATH: "" },
      homedir: "/unused",
      readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      fetchImpl: (async () => new Response("", { status })) as typeof fetch,
    }), "codex");

    await assert.rejects(
      () => codex.fetch(new AbortController().signal),
      (error: Error) => {
        assert.match(error.message, new RegExp(`Codex quota feed ${expected} \\(HTTP ${status}\\)`));
        assert.match(error.message, /active Codex session expired/);
        assert.doesNotMatch(error.message, /re-authenticate with OpenAI/);
        return true;
      },
    );
  }
});

test("OpenCode Go uses the auth.json API key and deletes the obsolete credential unread", async () => {
  const unlinked: string[] = [];
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const go = provider(discoverQuotaProviders({
    readAuth: () => ({ "opencode-go": { key: "go-secret" } }),
    env: { PATH: "" },
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

test("OpenCode Go falls through an expired OpenCode key to the Pi login of the same account", async () => {
  // A host can hold an expired key in OpenCode's store and a working one in
  // Pi's agent directory; the subscription is one account, so the source must
  // read the working login instead of reporting a sign-in problem.
  const seen: string[] = [];
  const piAuth = JSON.stringify({ "opencode-go": { type: "api_key", key: "pi-key" } });
  const go = provider(discoverQuotaProviders({
    readAuth: () => ({ "opencode-go": { key: "expired-opencode-key" } }),
    env: { PATH: "" },
    homedir: "/home/test",
    readFile: (path) => {
      if (path === "/home/test/.pi/agent/auth.json") return piAuth;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      seen.push(authorization);
      if (authorization === "Bearer expired-opencode-key") {
        return new Response(JSON.stringify({ error: { code: "api_key_expired" } }), { status: 401 });
      }
      return jsonResponse({ usage: { rolling: { percent: 10, resetsAt: "2027-01-01T00:00:00Z" } } });
    }) as typeof fetch,
  }), "opencode-go");
  const snapshot = await go.fetch(new AbortController().signal);
  assert.deepEqual(seen, ["Bearer expired-opencode-key", "Bearer pi-key"]);
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used]), [["5h", 10]]);
});

test("OpenCode Go reports an expired key rather than a sign-in when every stored login is rejected", async () => {
  const piAuth = JSON.stringify({ "opencode-go": { type: "api_key", key: "pi-expired" } });
  const go = provider(discoverQuotaProviders({
    readAuth: () => ({ "opencode-go": { key: "opencode-expired" } }),
    env: { PATH: "" },
    homedir: "/home/test",
    readFile: (path) => {
      if (path === "/home/test/.pi/agent/auth.json") return piAuth;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetchImpl: (async () => new Response(JSON.stringify({ error: { code: "api_key_expired" } }), { status: 401 })) as typeof fetch,
  }), "opencode-go");
  await assert.rejects(
    go.fetch(new AbortController().signal),
    (error: Error) => {
      // The account is still signed in; only the key is stale.
      assert.match(error.message, /rejected all 2 stored logins/);
      assert.match(error.message, /expired or revoked/);
      assert.doesNotMatch(error.message, /sign in/i);
      return true;
    },
  );
});

test("Chutes maps its daily request quota", async () => {
  const now = Date.UTC(2027, 0, 15, 10);
  const chutes = provider(discoverQuotaProviders({
    readAuth: () => ({ chutes: { key: "chutes-key" } }),
    env: { PATH: "" },
    homedir: "/unused",
    now: () => now,
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "https://api.chutes.ai/users/me/quota_usage/me");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer chutes-key");
      return jsonResponse({ quota: 1000, used: 250 });
    }) as typeof fetch,
  }), "chutes");
  const snapshot = await chutes.fetch(new AbortController().signal);
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used, window.limit, window.unit]), [
    ["quota", 250, 1000, "requests"],
  ]);
  assert.equal(snapshot.windows[0]?.resetsAt, Date.UTC(2027, 0, 16));
  assert.equal(snapshot.windows[0]?.periodMs, 86_400_000);
});

test("documented provider environment keys win over a stale auth entry", async () => {
  const seen: string[] = [];
  const providers = discoverQuotaProviders({
    readAuth: () => ({ chutes: { key: "stale-auth-key" } }),
    env: { PATH: "", CHUTES_API_KEY: "fresh-env-key" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return jsonResponse({ quota: 10, used: 1 });
    }) as typeof fetch,
  });
  await provider(providers, "chutes").fetch(new AbortController().signal);
  assert.deepEqual(seen, ["Bearer fresh-env-key"]);
});

test("Synthetic maps the rolling five-hour and weekly credit windows", async () => {
  const synthetic = provider(discoverQuotaProviders({
    readAuth: () => ({ synthetic: { key: "synthetic-key" } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request) => {
      assert.equal(String(input), "https://api.synthetic.new/v2/quotas");
      return jsonResponse({
        rollingFiveHourLimit: { max: 100, remaining: 80, nextTickAt: "2027-01-01T05:00:00Z" },
        weeklyTokenLimit: {
          maxCredits: "$10.00",
          remainingCredits: "$7.50",
          percentRemaining: 75,
          nextRegenAt: "2027-01-08T00:00:00Z",
        },
      });
    }) as typeof fetch,
  }), "synthetic");
  const snapshot = await synthetic.fetch(new AbortController().signal);
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used, window.limit, window.unit]), [
    ["5h", 20, 100, "requests"],
    ["weekly", 2.5, 10, "currency"],
  ]);
  assert.equal(snapshot.windows[0]?.periodMs, 5 * 3600 * 1000);
  assert.equal(snapshot.windows[1]?.periodMs, 7 * 86400 * 1000);
});

test("Kilo Gateway reports Kilo Pass credits and falls back to the gateway balance", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://app.kilo.ai/api/trpc/kiloPass.getState")) {
      return jsonResponse([{
        result: {
          data: {
            json: {
              subscription: {
                currentPeriodBaseCreditsUsd: 10,
                currentPeriodBonusCreditsUsd: 2,
                currentPeriodUsageUsd: 3,
                nextBillingAt: "2027-02-01T00:00:00Z",
              },
            },
          },
        },
      }]);
    }
    assert.equal(url, "https://api.kilo.ai/api/profile/balance");
    return jsonResponse({ balance: 4.25 });
  }) as typeof fetch;
  const providers = discoverQuotaProviders({
    readAuth: () => ({ kilo: { key: "kilo-key" } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl,
  });
  const pass = await provider(providers, "kilo").fetch(new AbortController().signal);
  assert.deepEqual(pass.windows.map((window) => [window.id, window.used, window.limit, window.unit]), [
    ["credits", 3, 12, "currency"],
  ]);
  assert.equal(pass.windows[0]?.resetsAt, Date.parse("2027-02-01T00:00:00Z"));

  const balanceProviders = discoverQuotaProviders({
    readAuth: () => ({ kilo: { key: "kilo-key" } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request) => {
      if (String(input).startsWith("https://app.kilo.ai/")) {
        return jsonResponse([{ result: { data: { json: { subscription: null } } } }]);
      }
      return jsonResponse({ balance: 4.25 });
    }) as typeof fetch,
  });
  const balance = await provider(balanceProviders, "kilo").fetch(new AbortController().signal);
  assert.deepEqual(balance.windows.map((window) => [window.id, window.used, window.limit, window.unit]), [
    ["balance", 0, 4.25, "currency"],
  ]);
});

test("Kimi Code Global and CN keep their regional hosts and keys", async () => {
  const seen: string[] = [];
  const providers = discoverQuotaProviders({
    readAuth: () => ({
      "kimi-code-plan-global": { key: "global-key" },
      "kimi-for-coding": { key: "cn-key" },
    }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
      return jsonResponse({ usage: { limit: 100, used: 25, resetTime: "2027-01-08T00:00:00Z" } });
    }) as typeof fetch,
  });
  await provider(providers, "kimi-code-plan-global").fetch(new AbortController().signal);
  await provider(providers, "kimi-for-coding").fetch(new AbortController().signal);
  assert.deepEqual(seen, [
    "https://api.kimi.ai/coding/v1/usages Bearer global-key",
    "https://api.kimi.com/coding/v1/usages Bearer cn-key",
  ]);
});

test("Xiaomi MiMo reads the dashboard cookie and maps monthly tokens plus balance", async () => {
  const paths: string[] = [];
  const mimo = provider(discoverQuotaProviders({
    readAuth: () => ({}),
    env: { PATH: "", MIMO_USAGE_COOKIE: "api-platform_serviceToken=secret; userId=1" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      assert.match(new Headers(init?.headers).get("cookie") ?? "", /serviceToken=secret/);
      if (url.endsWith("/api/v1/tokenPlan/usage")) {
        return jsonResponse({ code: 0, data: { monthUsage: { items: [{ name: "month_total_token", used: 100, limit: 1000 }] } } });
      }
      if (url.endsWith("/api/v1/tokenPlan/detail")) {
        return jsonResponse({ code: 0, data: { expired: false, planName: "Pro" } });
      }
      return jsonResponse({ code: 0, data: { balance: 12.5, currency: "USD" } });
    }) as typeof fetch,
  }), "xiaomi");
  const snapshot = await mimo.fetch(new AbortController().signal);
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used, window.limit, window.unit]), [
    ["monthly", 100, 1000, "tokens"],
    ["balance", 0, 12.5, "currency"],
  ]);
  assert.equal(snapshot.accountLabel, "Xiaomi MiMo · Pro");
  assert.deepEqual(paths.sort(), ["/api/v1/balance", "/api/v1/tokenPlan/detail", "/api/v1/tokenPlan/usage"]);
});

test("OpenCode Zen maps the member budget and balance from the Console sign-in", async () => {
  const now = Date.UTC(2027, 0, 15, 12);
  const calls: string[] = [];
  const zen = provider(discoverQuotaProviders({
    readAuth: () => ({
      opencode: {
        type: "oauth",
        access: "zen-access",
        refresh: "zen-refresh",
        expires: now + 3_600_000,
        metadata: { accountID: "acct-1", orgID: "org-1", orgName: "Team" },
      },
    }),
    env: { PATH: "" },
    homedir: "/unused",
    now: () => now,
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer zen-access");
      assert.equal(new Headers(init?.headers).get("x-org-id"), "org-1");
      if (url.endsWith("/api/billing/status")) return jsonResponse({ balanceMicroCents: "500000000" });
      if (url.endsWith("/api/billing/account")) return jsonResponse({ creditLimitMicroCents: "2000000000" });
      if (url.endsWith("/api/policies/members/acct-1")) {
        return jsonResponse({
          userID: "acct-1",
          budgets: [{ policyID: "p1", ruleID: "r1", scope: "each", per: "set", limitDollars: 10, spentDollars: 4 }],
          policies: [{ id: "p1", rules: [{ id: "r1", kind: "budget", period: "month", scope: "each", per: "set" }] }],
        });
      }
      return jsonResponse([{ date: "2027-01-05", totalCostMicroCents: "250000000" }]);
    }) as typeof fetch,
  }), "opencode-zen");
  const snapshot = await zen.fetch(new AbortController().signal);
  assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used, window.limit, window.unit]), [
    ["monthly_budget", 4, 10, "currency"],
    ["balance", 0, 5, "currency"],
  ]);
  assert.equal(snapshot.accountLabel, "Team");
  assert.equal(snapshot.windows[0]?.resetsAt, Date.UTC(2027, 1, 1));
  assert.equal(calls.length, 4);
});

test("OpenCode Zen refreshes an expired Console token and writes it back", async () => {
  const now = Date.UTC(2027, 0, 15, 12);
  let written: Record<string, unknown> | null = null;
  const zen = provider(discoverQuotaProviders({
    readAuth: () => ({
      opencode: {
        type: "oauth",
        access: "expired-access",
        refresh: "old-refresh",
        expires: now - 1_000,
        metadata: { accountID: "acct-1", server: "https://opencode.ai/console" },
      },
    }),
    writeAuth: (auth) => { written = auth.opencode as Record<string, unknown>; },
    env: { PATH: "" },
    homedir: "/unused",
    now: () => now,
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/device/token")) {
        assert.equal(String(init?.body), JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "old-refresh",
          client_id: "opencode-cli",
        }));
        return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, org_id: "org-2" });
      }
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new-access");
      if (url.endsWith("/api/billing/status")) return jsonResponse({ balanceMicroCents: "100000000" });
      if (url.endsWith("/api/billing/account")) return jsonResponse({ creditLimitMicroCents: null });
      if (url.includes("/api/policies/members/")) return jsonResponse({ userID: "acct-1", budgets: [], policies: [] });
      return jsonResponse([{ date: "2027-01-05", totalCostMicroCents: "50000000" }]);
    }) as typeof fetch,
  }), "opencode-zen");
  const snapshot = await zen.fetch(new AbortController().signal);
  assert.deepEqual(snapshot.windows.map((window) => window.id), ["balance"]);
  assert.equal(snapshot.windows.some((window) => window.id === "monthly_spend"), false);
  assert.deepEqual(
    snapshot.windows.map((window) => [window.id, window.used, window.limit, window.unit]),
    [["balance", 0, 1, "currency"]],
  );
  const stored = written as Record<string, unknown> | null;
  assert.ok(stored);
  assert.equal(stored.access, "new-access");
  assert.equal(stored.refresh, "new-refresh");
  assert.equal(stored.expires, now + 3_600_000);
  assert.deepEqual((stored.metadata as Record<string, unknown>)?.orgID, "org-2");
});

test("Alibaba Personal Token Plan discovers and runs only a trusted bl binary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "polyth-alibaba-"));
  try {
    const bl = join(directory, "bl");
    writeFileSync(bl, `#!/bin/sh\nprintf '%s' '${JSON.stringify({
      per5HourPercentage: 0.25,
      per5HourResetTime: 1_900_000_000_000,
      per1WeekPercentage: 0.5,
    })}'`, "utf8");
    chmodSync(bl, 0o755);
    const providers = discoverQuotaProviders({
      readAuth: () => ({}),
      env: { PATH: directory },
      homedir: directory,
      now: () => 1_800_000_000_000,
      readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      fetchImpl: (async () => { throw new Error("network must not be used"); }) as typeof fetch,
    });
    assert.deepEqual(providers.map((value) => value.id), ["alibaba-token-plan"]);
    const snapshot = await providers[0]!.fetch(new AbortController().signal);
    assert.deepEqual(snapshot.windows.map((window) => [window.id, window.used, window.limit]), [
      ["5h", 25, 100],
      ["weekly", 50, 100],
    ]);
    assert.equal(snapshot.windows[0]?.resetsAt, 1_900_000_000_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Alibaba Personal Token Plan parses the CLI windows without running the CLI", () => {
  const parsed = parseAlibabaTokenPlanUsage(JSON.stringify({
    per5HourPercentage: 0.25,
    per5HourResetTime: 1_900_000_000_000,
    per1WeekPercentage: 0.5,
  }));
  assert.deepEqual(parsed, {
    fiveHour: { usedPercent: 25, resetAt: 1_900_000_000_000 },
    weekly: { usedPercent: 50, resetAt: null },
  });
  assert.equal(parseAlibabaTokenPlanUsage(JSON.stringify({ per1WeekPercentage: 0 })).weekly?.usedPercent, 0);
  assert.throws(() => parseAlibabaTokenPlanUsage("not json"), /valid JSON/);
  assert.throws(() => parseAlibabaTokenPlanUsage(JSON.stringify({})), /no quota windows/);
  assert.throws(() => parseAlibabaTokenPlanUsage(JSON.stringify({ per5HourPercentage: 2 })), /invalid Personal Token Plan/);
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

test("Antigravity reads credentials from antigravity-oauth-token, lets agy refresh expired tokens, and maps quota limits", async () => {
  let fetches = 0;
  const now = 1_774_000_000_000;
  const calls: string[] = [];
  const refreshedHomes: string[] = [];
  let refreshed = false;
  const opts: QuotaDiscoveryOptions = {
    refreshAntigravityLogin: async (loginHome) => {
      refreshedHomes.push(loginHome);
      refreshed = true;
      return true;
    },
    findGoogleClient: () => assert.fail("an agy login must not use a bundled OAuth client"),
    readAuth: () => ({}),
    env: { PATH: "" },
    homedir: "/home/test",
    platform: "darwin",
    arch: "arm64",
    now: () => now,
    readFile: (path) => {
      if (path === "/home/test/.gemini/antigravity-cli/antigravity-oauth-token") {
        return JSON.stringify({
          token: refreshed
            ? { access_token: "fresh-access-token", refresh_token: "refresh-token-val", expiry: new Date(now + 3_600_000).toISOString() }
            : { access_token: "expired-token", refresh_token: "refresh-token-val", expiry: new Date(now - 60_000).toISOString() },
          auth_method: "consumer",
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      fetches += 1;
      const url = String(input);
      calls.push(url);
      assert.notEqual(url, "https://oauth2.googleapis.com/token");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fresh-access-token");
      assert.equal(new Headers(init?.headers).get("user-agent"), "antigravity/2.24.0 darwin/arm64");
      if (url.includes("/v1internal:retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            {
              modelId: "gemini-3.8-flash-tiered",
              remainingFraction: 0.85,
              resetTime: new Date(now + 3 * 3600 * 1000).toISOString(),
            },
            {
              modelId: "chat_20706",
              remainingFraction: 1,
            },
          ],
        });
      }
      if (url.includes("/v1internal:fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "claude-sonnet-4-6": {
              quotaInfo: {
                remainingFraction: 0.5,
                resetTime: new Date(now + 4 * 3600 * 1000).toISOString(),
              },
            },
            tab_flash_lite_preview: {
              quotaInfo: { remainingFraction: 1 },
            },
          },
        });
      }
      throw new Error(`Unexpected request to ${url}`);
    }) as typeof fetch,
  };

  const agy = provider(discoverQuotaProviders(opts), "antigravity");
  const snapshot = await agy.fetch(new AbortController().signal);
  assert.equal(snapshot.providerId, "antigravity");
  assert.equal(snapshot.accountLabel, "Antigravity");
  assert.deepEqual(snapshot.windows.map((w) => w.id), [
    "google-models",
    "third-party-models",
  ]);
  assert.deepEqual(snapshot.windows.map((w) => w.label), [
    "Google models",
    "Third-party models",
  ]);
  assert.deepEqual(snapshot.windows.map((w) => [w.used, w.limit, w.unit, w.periodMs]), [
    [15, 100, "percent", 5 * 3600 * 1000],
    [50, 100, "percent", 5 * 3600 * 1000],
  ]);
  assert.equal(snapshot.windows[0]?.resetsAt, now + 3 * 3600 * 1000);
  assert.equal(snapshot.windows[1]?.resetsAt, now + 4 * 3600 * 1000);
  assert.deepEqual(refreshedHomes, ["/home/test"]);
  assert.ok(calls.some((u) => u.includes("retrieveUserQuota")));
});

test("Antigravity asks the user to sign in again when agy cannot refresh its login", async () => {
  const now = 1_774_000_000_000;
  const agy = provider(discoverQuotaProviders({
    readAuth: () => ({}),
    env: { PATH: "" },
    homedir: "/home/test",
    now: () => now,
    refreshAntigravityLogin: async () => false,
    readFile: (path) => {
      if (path !== "/home/test/.gemini/antigravity-cli/antigravity-oauth-token") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return JSON.stringify({ token: { access_token: "old", refresh_token: "r", expiry: new Date(now - 1).toISOString() } });
    },
    fetchImpl: (async (input: string | URL | Request) => assert.fail(`unexpected request to ${String(input)}`)) as typeof fetch,
  }), "antigravity");
  await assert.rejects(() => agy.fetch(new AbortController().signal), /please sign in again with agy/i);
});

test("Antigravity refreshes an OpenCode plugin login with the plugin's installed client", async () => {
  const forms: string[] = [];
  const agy = provider(discoverQuotaProviders({
    readAuth: () => ({ antigravity: { type: "oauth", refresh: "plugin-refresh|proj-1" } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    refreshAntigravityLogin: async () => assert.fail("a plugin login is not agy's to refresh"),
    findGoogleClient: (kind) => kind === "antigravity" ? { id: "1-plugin.apps.googleusercontent.com", secret: "plugin-client-secret" } : null,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        forms.push(String(init?.body));
        return jsonResponse({ access_token: "plugin-access" });
      }
      if (url.includes("retrieveUserQuota")) {
        return jsonResponse({ buckets: [{ modelId: "gemini-3.8-flash", remainingFraction: 0.5 }] });
      }
      return jsonResponse({});
    }) as typeof fetch,
  }), "antigravity");
  const snapshot = await agy.fetch(new AbortController().signal);
  assert.equal(snapshot.windows[0]?.used, 50);
  const form = new URLSearchParams(forms[0]);
  assert.equal(form.get("client_id"), "1-plugin.apps.googleusercontent.com");
  assert.equal(form.get("client_secret"), "plugin-client-secret");
  assert.equal(form.get("refresh_token"), "plugin-refresh");
});

test("Antigravity plugin logins stay unrefreshed without an installed plugin client", async () => {
  const agy = provider(discoverQuotaProviders({
    readAuth: () => ({ antigravity: { type: "oauth", refresh: "plugin-refresh|proj-1" } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    findGoogleClient: () => null,
    fetchImpl: (async (input: string | URL | Request) => assert.fail(`unexpected request to ${String(input)}`)) as typeof fetch,
  }), "antigravity");
  await assert.rejects(() => agy.fetch(new AbortController().signal), /open OpenCode/i);
});

test("Antigravity 401 explains that agy must be opened and does not expose tokens", async () => {
  const secret = "agy-secret-token-abcdefghijklmnopqrstuvwxyz";
  const agy = provider(discoverQuotaProviders({
    readAuth: () => ({ antigravity: { access: secret } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async () => new Response("", { status: 401 })) as typeof fetch,
  }), "antigravity");
  await assert.rejects(
    () => agy.fetch(new AbortController().signal),
    (error: Error) => {
      assert.match(error.message, /please sign in again with agy/i);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("Antigravity handles 429 rate limit cooldown and preserves last-good snapshot", async () => {
  let now = 1_774_000_000_000;
  let fetches = 0;
  const opts: QuotaDiscoveryOptions = {
    readAuth: () => ({ antigravity: { access: "valid-agy-token" } }),
    env: { PATH: "" },
    homedir: "/unused",
    now: () => now,
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request) => {
      fetches += 1;
      if (fetches > 2) {
        return new Response("", { status: 429, headers: { "retry-after": "60" } });
      }
      return jsonResponse({
        buckets: [
          {
            modelId: "gemini-3.8-flash-tiered",
            remainingFraction: 0.9,
            resetTime: new Date(now + 2 * 3600 * 1000).toISOString(),
          },
        ],
      });
    }) as typeof fetch,
  };

  const agy = provider(discoverQuotaProviders(opts), "antigravity");
  const first = await agy.fetch(new AbortController().signal);
  assert.equal(first.windows[0]?.used, 10);

  now += 1_000;
  const rateLimited = await agy.fetch(new AbortController().signal);
  assert.deepEqual(rateLimited.windows, first.windows);

  now += 10_000;
  const cached = await agy.fetch(new AbortController().signal);
  assert.deepEqual(cached.windows, first.windows);
});

test("Antigravity collapses many identical model quotas into exactly 2 tiers: Google and third-party", async () => {
  const now = 1_800_000_000_000;
  const resetIso = new Date(now + 2 * 3600 * 1000).toISOString();
  const opts: QuotaDiscoveryOptions = {
    readAuth: () => ({ antigravity: { access: "valid-agy-token" } }),
    env: { PATH: "" },
    homedir: "/unused",
    now: () => now,
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1internal:retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            { modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: resetIso },
            { modelId: "gemini-2.5-pro", remainingFraction: 0.9, resetTime: resetIso },
            { modelId: "gemini-3.8-flash-high", remainingFraction: 0.9, resetTime: resetIso },
            { modelId: "gemini-3.8-flash-medium", remainingFraction: 0.9, resetTime: resetIso },
            { modelId: "gemini-3.8-flash-tiered", remainingFraction: 0.9, resetTime: resetIso },
            { modelId: "claude-sonnet-4-6", remainingFraction: 0.75, resetTime: resetIso },
            { modelId: "claude-opus-4-6-thinking", remainingFraction: 0.75, resetTime: resetIso },
            { modelId: "gpt-oss-120b-medium", remainingFraction: 0.75, resetTime: resetIso },
            { modelId: "chat_20706", remainingFraction: 1 },
            { modelId: "tab_flash_lite_preview", remainingFraction: 1 },
          ],
        });
      }
      return jsonResponse({ models: {} });
    }) as typeof fetch,
  };

  const agy = provider(discoverQuotaProviders(opts), "antigravity");
  const snapshot = await agy.fetch(new AbortController().signal);
  assert.equal(snapshot.windows.length, 2, "Must contain exactly 2 tiers, not 8 identical model rows");
  assert.deepEqual(snapshot.windows.map((w) => ({ id: w.id, label: w.label, used: w.used })), [
    { id: "google-models", label: "Google models", used: 10 },
    { id: "third-party-models", label: "Third-party models", used: 25 },
  ]);
});

test("Antigravity maps 5-hour and weekly limits from retrieveUserQuotaSummary", async () => {
  const now = 1_800_000_000_000;
  const reset5h = new Date(now + 3 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(now + 5 * 86400 * 1000).toISOString();
  const opts: QuotaDiscoveryOptions = {
    readAuth: () => ({ antigravity: { access: "valid-token" } }),
    env: { PATH: "" },
    homedir: "/unused",
    now: () => now,
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1internal:retrieveUserQuotaSummary")) {
        return jsonResponse({
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                {
                  bucketId: "gemini-5h",
                  window: "5h",
                  remainingFraction: 0.85,
                  resetTime: reset5h,
                },
                {
                  bucketId: "gemini-weekly",
                  window: "weekly",
                  remainingFraction: 0.70,
                  resetTime: resetWeekly,
                },
              ],
            },
            {
              displayName: "Claude and GPT models",
              buckets: [
                {
                  bucketId: "3p-5h",
                  window: "5h",
                  remainingFraction: 0.90,
                  resetTime: reset5h,
                },
                {
                  bucketId: "3p-weekly",
                  window: "weekly",
                  remainingFraction: 0.50,
                  resetTime: resetWeekly,
                },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch,
  };

  const agy = provider(discoverQuotaProviders(opts), "antigravity");
  const snapshot = await agy.fetch(new AbortController().signal);
  assert.equal(snapshot.windows.length, 4);
  assert.deepEqual(snapshot.windows.map((w) => [w.id, w.used, w.limit, w.periodMs]), [
    ["google-5h", 15, 100, 5 * 3600 * 1000],
    ["google-weekly", 30, 100, 7 * 86400 * 1000],
    ["third-party-5h", 10, 100, 5 * 3600 * 1000],
    ["third-party-weekly", 50, 100, 7 * 86400 * 1000],
  ]);
});

test("Codex gracefully handles plans without 5-hour limit and exposes plan name", async () => {
  const codex = provider(discoverQuotaProviders({
    readAuth: () => ({ openai: { access: "codex-secret" } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async () => jsonResponse({
      plan_type: "pro",
      rate_limit: {
        secondary_window: { used_percent: 25, limit_window_seconds: 604_800, reset_at: 1_900_604_800 },
      },
    })) as typeof fetch,
  }), "codex");
  const snapshot = await codex.fetch(new AbortController().signal);
  assert.equal(snapshot.accountLabel, "Codex (pro)");
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0]?.id, "7d");
  assert.equal(snapshot.windows[0]?.used, 25);
  assert.equal(snapshot.windows[0]?.limit, 100);
});

test("adapter failures and usage-service redaction never include secret values", async () => {
  const secret = "sk-secret-abcdefghijklmnopqrstuvwxyz012345";
  const openrouter = provider(discoverQuotaProviders({
    readAuth: () => ({ openrouter: { key: secret } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async () => { throw new Error(`network rejected ${secret}`); }) as typeof fetch,
  }), "openrouter");
  await assert.rejects(
    () => openrouter.fetch(new AbortController().signal),
    (error: Error) => {
      assert.ok(!error.message.includes(secret));
      assert.ok(!redactLimitSecrets(error.message).includes(secret));
      return true;
    },
  );
});

test("Google refreshes a Gemini CLI login with the installed Gemini CLI client", async () => {
  const forms: string[] = [];
  const google = provider(discoverQuotaProviders({
    readAuth: () => ({ google: { type: "oauth", refresh: "gemini-refresh||proj-9" } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    findGoogleClient: (kind) => kind === "gemini" ? { id: "2-cli.apps.googleusercontent.com", secret: "cli-client-secret" } : null,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        forms.push(String(init?.body));
        return jsonResponse({ access_token: "gemini-access" });
      }
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gemini-access");
      if (url.includes("retrieveUserQuota")) {
        return jsonResponse({ buckets: [{ modelId: "gemini-3.8-pro", remainingFraction: 0.25 }] });
      }
      return jsonResponse({});
    }) as typeof fetch,
  }), "google");
  const snapshot = await google.fetch(new AbortController().signal);
  assert.ok(snapshot.windows.some((window) => window.used === 75));
  const form = new URLSearchParams(forms[0]);
  assert.equal(form.get("client_id"), "2-cli.apps.googleusercontent.com");
  assert.equal(form.get("client_secret"), "cli-client-secret");
});

test("Google reports an expired login instead of using a bundled client when Gemini CLI is not installed", async () => {
  const google = provider(discoverQuotaProviders({
    readAuth: () => ({ google: { type: "oauth", refresh: "gemini-refresh" } }),
    env: { PATH: "" },
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    findGoogleClient: () => null,
    fetchImpl: (async (input: string | URL | Request) => assert.fail(`unexpected request to ${String(input)}`)) as typeof fetch,
  }), "google");
  await assert.rejects(() => google.fetch(new AbortController().signal), /install Gemini CLI/i);
});
