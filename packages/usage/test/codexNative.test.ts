import assert from "node:assert/strict";
import test from "node:test";
import type { QuotaDiscoveryOptions } from "../src/opencodeAuth.ts";
import {
  loadCodexCredential,
  jwtAccountId,
  jwtExpiresAt,
  CODEX_TOKEN_URL,
  CODEX_CLIENT_ID,
} from "../src/providers/codex.ts";
import { discoverQuotaProviders } from "../src/providers/index.ts";

const createJwt = (payload: Record<string, unknown>): string => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
};

test("jwtAccountId extracts accountId from OpenAI custom claims or root", () => {
  const tokenWithCustom = createJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-custom-123" },
  });
  assert.equal(jwtAccountId(tokenWithCustom), "acct-custom-123");

  const tokenWithRoot = createJwt({
    chatgpt_account_id: "acct-root-456",
  });
  assert.equal(jwtAccountId(tokenWithRoot), "acct-root-456");

  assert.equal(jwtAccountId("not-a-jwt"), null);
});

test("jwtExpiresAt extracts expiration timestamp in milliseconds", () => {
  const token = createJwt({ exp: 1_800_000_000 });
  assert.equal(jwtExpiresAt(token), 1_800_000_000_000);
  assert.equal(jwtExpiresAt("not-a-jwt"), null);
});

test("loadCodexCredential discovers native ~/.codex/auth.json credentials", () => {
  const token = createJwt({
    exp: 2_000_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-native" },
  });
  const now = 1_800_000_000_000;
  const runtime = {
    home: "/home/user",
    now: () => now,
    env: {},
    readAuth: () => ({}),
    readFile: (path: string) => {
      if (path === "/home/user/.codex/auth.json") {
        return JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: token,
            refresh_token: "ref-native-123",
            account_id: "acct-native",
          },
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  } as any;

  const cred = loadCodexCredential(runtime);
  assert.ok(cred);
  assert.equal(cred.source, "native");
  assert.equal(cred.accessToken, token);
  assert.equal(cred.refreshToken, "ref-native-123");
  assert.equal(cred.accountId, "acct-native");
  assert.equal(cred.expires, 2_000_000_000_000);
});

test("loadCodexCredential prefers valid native credentials over expired OpenCode credentials", () => {
  const now = 1_800_000_000_000;
  const freshNativeToken = createJwt({ exp: 1_900_000_000 });
  const runtime = {
    home: "/home/user",
    now: () => now,
    env: {},
    readAuth: () => ({
      openai: {
        access: "expired-opencode-access",
        refresh: "opencode-refresh",
        expires: now - 100_000, // expired!
        accountId: "acct-opencode",
      },
    }),
    readFile: (path: string) => {
      if (path === "/home/user/.codex/auth.json") {
        return JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: freshNativeToken,
            refresh_token: "native-refresh",
            account_id: "acct-native",
          },
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  } as any;

  const cred = loadCodexCredential(runtime);
  assert.ok(cred);
  assert.equal(cred.source, "native");
  assert.equal(cred.accessToken, freshNativeToken);
  assert.equal(cred.accountId, "acct-native");
});

test("Codex provider refreshes expired token before fetch using refresh_token", async () => {
  const now = 1_800_000_000_000;
  const refreshedToken = createJwt({
    exp: 1_900_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-refreshed" },
  });

  const calls: string[] = [];
  let authWrites = 0;

  const opts: QuotaDiscoveryOptions = {
    now: () => now,
    env: {},
    homedir: "/home/user",
    readAuth: () => ({
      openai: {
        access: "expired-access",
        refresh: "refresh-val-999",
        expires: now - 60_000, // expired
      },
    }),
    writeAuth: () => {
      authWrites++;
    },
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === CODEX_TOKEN_URL) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.grant_type, "refresh_token");
        assert.equal(body.refresh_token, "refresh-val-999");
        assert.equal(body.client_id, CODEX_CLIENT_ID);
        return new Response(JSON.stringify({
          access_token: refreshedToken,
          refresh_token: "new-refresh-val",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${refreshedToken}`);
        assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "acct-refreshed");
        return new Response(JSON.stringify({
          plan_type: "pro",
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch,
  };

  const providers = discoverQuotaProviders(opts);
  const codex = providers.find((p) => p.id === "codex");
  assert.ok(codex);

  const snapshot = await codex.fetch(new AbortController().signal);
  assert.equal(snapshot.providerId, "codex");
  assert.equal(snapshot.accountLabel, "Codex (pro)");
  assert.equal(calls.length, 2);
  assert.equal(calls[0], CODEX_TOKEN_URL);
  assert.equal(calls[1], "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(authWrites, 1);
});

test("Codex provider retries on HTTP 401 after token refresh", async () => {
  const now = 1_800_000_000_000;
  const initialToken = "maybe-revoked-token";
  const refreshedToken = createJwt({ exp: 1_900_000_000 });

  let attempts = 0;
  const calls: string[] = [];

  const opts: QuotaDiscoveryOptions = {
    now: () => now,
    env: {},
    homedir: "/home/user",
    readAuth: () => ({
      openai: {
        access: initialToken,
        refresh: "refresh-val-123",
      },
    }),
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        attempts++;
        if (attempts === 1) {
          // First attempt fails with 401
          return new Response("", { status: 401 });
        }
        // Second attempt after refresh succeeds
        return new Response(JSON.stringify({
          plan_type: "team",
          rate_limit: {
            primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === CODEX_TOKEN_URL) {
        return new Response(JSON.stringify({
          access_token: refreshedToken,
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch,
  };

  const providers = discoverQuotaProviders(opts);
  const codex = providers.find((p) => p.id === "codex");
  assert.ok(codex);

  const snapshot = await codex.fetch(new AbortController().signal);
  assert.equal(snapshot.accountLabel, "Codex (team)");
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [
    "https://chatgpt.com/backend-api/wham/usage",
    CODEX_TOKEN_URL,
    "https://chatgpt.com/backend-api/wham/usage",
  ]);
});

test("Codex 401 without refresh token produces descriptive error without claiming session expired", async () => {
  const opts: QuotaDiscoveryOptions = {
    readAuth: () => ({
      openai: {
        access: "revoked-token-without-refresh",
      },
    }),
    env: {},
    homedir: "/unused",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: (async () => new Response("", { status: 401 })) as typeof fetch,
  };

  const providers = discoverQuotaProviders(opts);
  const codex = providers.find((p) => p.id === "codex");
  assert.ok(codex);

  await assert.rejects(
    () => codex.fetch(new AbortController().signal),
    (error: Error) => {
      assert.match(error.message, /Codex quota feed authentication failed \(HTTP 401\)/);
      assert.match(error.message, /this does not indicate that the active Codex session expired/);
      assert.match(error.message, /Check the Usage credential/);
      assert.doesNotMatch(error.message, /revoked-token-without-refresh/);
      return true;
    },
  );
});
