import assert from "node:assert/strict";
import test from "node:test";
import type { QuotaRuntime } from "../src/opencodeAuth.ts";
import { createCommandCodeProvider } from "../src/providers/commandcode.ts";
import { listConfiguredQuotaProviders, discoverQuotaProviders } from "../src/providers/index.ts";

test("Command Code is not configured when credentials are absent", () => {
  const runtime = {
    env: {},
    home: "/nonexistent",
    readFile: () => { throw new Error("ENOENT"); },
    readAuth: () => ({}),
  } as unknown as QuotaRuntime;

  const provider = createCommandCodeProvider(runtime);
  assert.equal(provider.id, "command-code");
  assert.equal(provider.isConfigured(), false);
});

test("Command Code discovers auth and maps 5-hour and weekly limits", async () => {
  const calls: string[] = [];
  const runtime = {
    env: { COMMAND_CODE_API_KEY: "cmd-secret" },
    home: "/home/user",
    now: () => 1_800_000_000_000,
    readFile: () => { throw new Error("ENOENT"); },
    readAuth: () => ({}),
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/alpha/whoami")) {
        return new Response(JSON.stringify({
          user: { email: "user@example.com", name: "User" },
          org: { id: "org-1", name: "Acme" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/alpha/billing/credits")) {
        return new Response(JSON.stringify({
          windowLimits: {
            fiveHour: { used: 15, cap: 100, resetAt: "2027-01-01T05:00:00Z" },
            weekly: { used: 45, cap: 100, resetAt: "2027-01-07T00:00:00Z" },
          },
          credits: {
            monthlyCredits: 200,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected url ${url}`);
    }) as typeof fetch,
  } as unknown as QuotaRuntime;

  const provider = createCommandCodeProvider(runtime);
  assert.equal(provider.id, "command-code");
  assert.equal(provider.isConfigured(), true);

  const snapshot = await provider.fetch(new AbortController().signal);
  assert.equal(snapshot.providerId, "command-code");
  assert.equal(snapshot.accountLabel, "user@example.com");
  assert.equal(snapshot.windows.length, 3);
  assert.deepEqual(snapshot.windows.map((w) => [w.id, w.used, w.limit, w.unit, w.periodMs]), [
    ["5h", 15, 100, "percent", 5 * 3600 * 1000],
    ["weekly", 45, 100, "percent", 7 * 86400 * 1000],
    ["monthly_credits", 0, 200, "requests", undefined],
  ]);
});
