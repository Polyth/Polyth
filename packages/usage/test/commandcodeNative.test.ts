import assert from "node:assert/strict";
import test from "node:test";
import { discoverQuotaProviders, type QuotaDiscoveryOptions } from "@polyth/usage";

const json = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("Command Code usage reads the native CLI credential without OpenCode auth", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const opts: QuotaDiscoveryOptions = {
    readAuth: () => ({}),
    env: {},
    homedir: "/home/test",
    readFile: (path) => {
      if (path === "/home/test/.commandcode/auth.json") {
        return JSON.stringify({ apiKey: "user_native_secret", userName: "Max" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/alpha/whoami")) {
        return json({ user: { email: "user@example.test" }, org: { id: "org-1", name: "Team" } });
      }
      return json({
        credits: { monthlyCredits: 80, purchasedCredits: 12, freeCredits: 3 },
        windowLimits: {
          fiveHour: { used: 4, cap: 16, resetAt: "2027-01-01T05:00:00Z" },
          weekly: { used: 20, cap: 40, resetAt: "2027-01-07T00:00:00Z" },
        },
      });
    }) as typeof fetch,
  };

  const providers = discoverQuotaProviders(opts);
  const commandCode = providers.find((provider) => provider.id === "command-code");
  assert.ok(commandCode);
  const snapshot = await commandCode.fetch(new AbortController().signal);

  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.commandcode.ai/alpha/whoami",
    "https://api.commandcode.ai/alpha/billing/credits?orgId=org-1",
  ]);
  assert.ok(calls.every((call) => call.authorization === "Bearer user_native_secret"));
  assert.equal(snapshot.accountLabel, "user@example.test");
  assert.deepEqual(snapshot.windows.map((window) => window.id), [
    "monthly_credits", "purchased_credits", "free_credits", "5h", "weekly",
  ]);
  assert.deepEqual(snapshot.windows.slice(-2).map((window) => [window.used, window.limit, window.unit]), [
    [25, 100, "percent"],
    [50, 100, "percent"],
  ]);
});

test("COMMAND_CODE_API_KEY overrides the native Command Code auth file", async () => {
  const seen: string[] = [];
  const providers = discoverQuotaProviders({
    readAuth: () => ({}),
    env: { COMMAND_CODE_API_KEY: "env-key" },
    homedir: "/home/test",
    readFile: (path) => path.endsWith("/.commandcode/auth.json")
      ? JSON.stringify({ apiKey: "file-key" })
      : (() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); })(),
    fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return seen.length === 1
        ? json({ user: { name: "User" } })
        : json({ windowLimits: { fiveHour: { used: 1, cap: 10 } } });
    }) as typeof fetch,
  });
  const commandCode = providers.find((provider) => provider.id === "command-code");
  assert.ok(commandCode);
  await commandCode.fetch(new AbortController().signal);
  assert.deepEqual(seen, ["Bearer env-key", "Bearer env-key"]);
});
