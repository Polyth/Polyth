import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessProvider } from "@polyth/contracts";
import { createHarnessAccountLimits, createUsageLimitService } from "@polyth/usage";
import type { QuotaRuntime } from "../src/opencodeAuth.ts";
import { createVibeProvider, loadVibeCredential, readDotenvValue, vibeBudgetWindow } from "../src/providers/vibe.ts";
import { sourceProblem } from "../widgets/usage/alertsModel.ts";

const missing = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The shape Mistral answered for a Free Vibe key (2026-11-26).
const FREE_BUDGET = {
  vibe_budget: { usage_percentage: 25, initial_budget: 10, currency: "USD", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
  api_budget: { usage_percentage: 100, initial_budget: 5, currency: "USD", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
  usage_percentage: 0,
  initial_budget: 0,
  currency: "USD",
  reset_at: "2026-12-01T00:00:00Z",
};
const FREE_SUBSCRIPTION = { plan_name: "FREE", payg_enabled: false, vibe_payg_enabled: false, enterprise: false };

const runtimeWith = (opts: {
  env?: Record<string, string>;
  files?: Record<string, string>;
  respond?: (url: string) => Response;
  seen?: { url: string; authorization: string }[];
}): QuotaRuntime => ({
  env: opts.env ?? {},
  home: "/home/test",
  now: () => 1_800_000_000_000,
  readFile: (path: string) => opts.files?.[path] ?? missing(),
  readAuth: () => ({}),
  fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    opts.seen?.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    return opts.respond ? opts.respond(url) : json(url.endsWith("/budget") ? FREE_BUDGET : FREE_SUBSCRIPTION);
  }) as typeof fetch,
}) as unknown as QuotaRuntime;

test("dotenv values: export, quotes and trailing comments", () => {
  assert.equal(readDotenvValue("MISTRAL_API_KEY=abc", "MISTRAL_API_KEY"), "abc");
  assert.equal(readDotenvValue("# c\nexport MISTRAL_API_KEY = 'a b' # x\n", "MISTRAL_API_KEY"), "a b");
  assert.equal(readDotenvValue("MISTRAL_API_KEY=\"q#1\"\r\nOTHER=1", "MISTRAL_API_KEY"), "q#1");
  assert.equal(readDotenvValue("MISTRAL_API_KEY=abc # note", "MISTRAL_API_KEY"), "abc");
  assert.equal(readDotenvValue("NOT_MISTRAL_API_KEY=abc\nMISTRAL_API_KEY=", "MISTRAL_API_KEY"), null);
});

test("the default Vibe login: launch environment first, then VIBE_HOME/.env; a browser sign-in is not a key", () => {
  assert.equal(createVibeProvider(runtimeWith({})).isConfigured(), false);
  const files = { "/home/test/.vibe/.env": "MISTRAL_API_KEY=home-key\n" };
  assert.equal(loadVibeCredential(runtimeWith({ files })), "home-key");
  assert.equal(loadVibeCredential(runtimeWith({ files, env: { MISTRAL_API_KEY: "env-key" } })), "env-key");
  assert.equal(
    loadVibeCredential(runtimeWith({ env: { VIBE_HOME: "/srv/vibe" }, files: { "/srv/vibe/.env": "MISTRAL_API_KEY=custom" } })),
    "custom",
  );
  // Vibe's OIDC sign-in writes a placeholder, not a credential.
  const oidc = runtimeWith({ files: { "/home/test/.vibe/.env": "MISTRAL_API_KEY=vibe-cli-oidc" } });
  assert.equal(loadVibeCredential(oidc), null);
  assert.equal(createVibeProvider(oidc).isConfigured(), false);
});

test("the Vibe budget becomes a monthly USD window; the API budget is not a Vibe limit", async () => {
  const seen: { url: string; authorization: string }[] = [];
  const provider = createVibeProvider(runtimeWith({ env: { MISTRAL_API_KEY: "vibe-key" }, seen }));
  assert.equal(provider.id, "vibe");
  assert.equal(provider.isConfigured(), true);
  const snapshot = await provider.fetch(new AbortController().signal);
  // The key goes only to Mistral's own billing routes.
  assert.deepEqual(seen.map((call) => call.url).sort(), [
    "https://api.mistral.ai/v1/billing/budget",
    "https://api.mistral.ai/v1/billing/subscription",
  ]);
  assert.ok(seen.every((call) => call.authorization === "Bearer vibe-key"));
  assert.equal(snapshot.providerId, "vibe");
  assert.equal(snapshot.accountLabel, "Mistral Free");
  assert.equal(snapshot.windows.length, 1);
  const [window] = snapshot.windows;
  assert.equal(window?.id, "monthly");
  assert.equal(window?.unit, "percent");
  assert.equal(window?.used, 25);
  assert.equal(window?.limit, 100);
  assert.equal(window?.label, "Monthly budget · $7.50 left · $2.50 spent");
  assert.equal(window?.resetsAt, Date.parse("2026-12-01T00:00:00Z"));
  // November: the calendar month the reset closes.
  assert.equal(window?.periodMs, 30 * 86_400_000);
});

test("a non-USD budget labels its own currency; pay-as-you-go is named", () => {
  const window = vibeBudgetWindow(
    { vibe_budget: { usage_percentage: 120, initial_budget: 15, currency: "EUR", reset_at: "2027-03-31T00:00:00Z" } },
    { plan_name: "INDIVIDUAL", vibe_payg_enabled: true },
  );
  assert.equal(window?.unit, "percent");
  assert.equal(window?.used, 120);
  assert.equal(window?.limit, 100);
  assert.equal(window?.label, "Monthly budget · €0.00 left · €18.00 spent · pay-as-you-go on");
  // A reset on the 31st after a 28-day February clamps to February's end.
  assert.equal(window?.periodMs, Date.parse("2027-03-31T00:00:00Z") - Date.parse("2027-02-28T00:00:00Z"));
  assert.equal(vibeBudgetWindow({ vibe_budget: { usage_percentage: 0, initial_budget: 0 } }, null), null);
  assert.equal(vibeBudgetWindow({}, null), null);
});

test("a rejected key, a member without usage access and an account without a Vibe budget", async () => {
  const fetchWith = (respond: (url: string) => Response) =>
    createVibeProvider(runtimeWith({ env: { MISTRAL_API_KEY: "k" }, respond })).fetch(new AbortController().signal);

  const rejected = await fetchWith(() => json({ message: "Unauthorized" }, 401)).catch((error: Error & { code?: string }) => error);
  assert.ok(rejected instanceof Error);
  assert.equal((rejected as { code?: string }).code, "unauthorized");
  assert.equal(sourceProblem({ error: { code: "unauthorized", message: rejected.message } }), "key");

  const forbidden = await fetchWith((url) => url.endsWith("/budget") ? json({}, 403) : json(FREE_SUBSCRIPTION))
    .catch((error: Error) => error);
  assert.ok(forbidden instanceof Error);
  assert.match(forbidden.message, /HTTP 403/);
  // Not a sign-in or key problem: the key works, the member lacks the permission.
  assert.equal(sourceProblem({ error: { code: "fetch-failed", message: forbidden.message } }), null);

  // The subscription read is optional; the budget alone is enough.
  const noPlan = await fetchWith((url) => url.endsWith("/budget") ? json(FREE_BUDGET) : json({}, 404));
  assert.equal(noPlan.accountLabel, "Mistral");
  assert.equal(noPlan.windows[0]?.used, 25);

  await assert.rejects(
    fetchWith((url) => url.endsWith("/budget") ? json({ api_budget: FREE_BUDGET.api_budget }) : json(FREE_SUBSCRIPTION)),
    /no Vibe Code budget/,
  );
});

test("a Vibe account reads only its own VIBE_HOME/.env, never the server key or ~/.vibe", async () => {
  const seen: { url: string; authorization: string }[] = [];
  const limits = createUsageLimitService({ jitterMs: 0 });
  const harness = (id: string, label: string, configDir: string): HarnessProvider => ({
    descriptor: { id, name: `Mistral Vibe · ${label}`, integration: "test", priority: 0, accountLabel: label },
    probe: async () => ({ harnessId: id, installed: true, healthy: true, authenticated: true }),
    createRuntime: async () => { throw new Error("not used"); },
    limitsAccount: () => ({ family: "vibe", configDir }),
  });
  const files: Record<string, string> = {
    "/home/test/.vibe/.env": "MISTRAL_API_KEY=default-key",
    "/data/vibe-accounts/work/.env": "MISTRAL_API_KEY=work-key",
  };
  createHarnessAccountLimits({
    limits,
    harnesses: () => [
      harness("vibe-work", "Work", "/data/vibe-accounts/work"),
      harness("vibe-empty", "Empty", "/data/vibe-accounts/empty"),
    ],
    reserved: new Set(),
    discovery: {
      env: { MISTRAL_API_KEY: "server-key" },
      homedir: "/home/test",
      platform: "linux",
      readAuth: () => ({}),
      readFile: (path) => files[path] ?? missing(),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "" });
        return json(url.endsWith("/budget") ? FREE_BUDGET : FREE_SUBSCRIPTION);
      }) as typeof fetch,
    },
  }).reconcile();
  assert.deepEqual(limits.providerIds(), ["vibe-work", "vibe-empty"]);

  const work = await limits.refresh("vibe-work");
  assert.deepEqual(work.account, { family: "vibe", harnessId: "vibe-work", label: "Work" });
  assert.equal(work.windows[0]?.label, "Monthly budget · $7.50 left · $2.50 spent");
  assert.ok(seen.length > 0 && seen.every((call) => call.authorization === "Bearer work-key"));

  const empty = await limits.refresh("vibe-empty");
  assert.match(empty.error?.message ?? "", /Mistral Vibe account has no API key/);
  assert.ok(seen.every((call) => call.authorization === "Bearer work-key"));
});
