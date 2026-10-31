import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { HarnessProvider, JsonObject, Project, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import {
  createHarnessAccountLimits,
  createUsageLimitService,
  displayHarness,
  harnessAccountOf,
  resolveSessionUsageProviderId,
  type QuotaDiscoveryOptions,
} from "@polyth/usage";
import { createUsageAnalyticsService } from "../src/analytics/service.ts";
import { claudeKeychainService } from "../src/providers/claude.ts";

const credentials = (accessToken: string) => JSON.stringify({ claudeAiOauth: { accessToken, subscriptionType: "max" } });
const missing = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };

/** A harness as a backend registers it; `limitsAccount` is the only Usage-facing seam. */
const harness = (id: string, accountLabel?: string, configDir?: string, family = "claude"): HarnessProvider => ({
  descriptor: { id, name: accountLabel ? `Claude Code · ${accountLabel}` : "Claude Code", integration: "test", priority: 0, ...(accountLabel ? { accountLabel } : {}) },
  probe: async () => ({ harnessId: id, installed: true, healthy: true, authenticated: true }),
  createRuntime: async () => { throw new Error("not used"); },
  ...(configDir ? { limitsAccount: () => ({ family, configDir }) } : {}),
});

/** Usage reads `/home/test/.claude` (default) and each account's own directory; every request records its token. */
const discovery = (seen: string[], files: Record<string, string>): QuotaDiscoveryOptions => ({
  readAuth: () => ({ anthropic: { access: "opencode-token" } }),
  env: { CLAUDE_CODE_OAUTH_TOKEN: "env-token" },
  homedir: "/home/test",
  platform: "linux",
  readFile: (path) => files[path] ?? missing(),
  fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ five_hour: { utilization: 40, resets_at: "2027-01-01T00:00:00Z" } }), { status: 200 });
  }) as typeof fetch,
});

test("every account of a harness becomes its own limits source, read from that account's login only", async () => {
  const seen: string[] = [];
  const limits = createUsageLimitService({ jitterMs: 0 });
  const harnesses = [
    harness("claude", undefined, "/home/test/.claude"),
    harness("claude-work", "Work", "/data/claude-accounts/work"),
    harness("claude-personal", "Personal", "/data/claude-accounts/personal"),
    harness("codex-second", "Second", "/data/codex-accounts/second", "codex"),
    harness("grok-second", "Second", "/data/grok-accounts/second", "grok"),
    harness("opencode"),
  ];
  const accounts = createHarnessAccountLimits({
    limits,
    harnesses: () => harnesses,
    reserved: new Set(),
    discovery: discovery(seen, { "/data/claude-accounts/work/.credentials.json": credentials("work-token") }),
  });
  accounts.reconcile();
  // The default account is the family's own source; a family without an
  // account reader (grok here) and a harness without accounts add nothing.
  assert.deepEqual(limits.providerIds(), ["claude-work", "claude-personal", "codex-second"]);

  const work = await limits.refresh("claude-work");
  assert.deepEqual(seen, ["Bearer work-token"]);
  assert.deepEqual(work.account, { family: "claude", harnessId: "claude-work", label: "Work" });
  assert.equal(work.windows[0]?.used, 40);

  // An account that never signed in reports so; it never borrows the default
  // login, the OpenCode auth file or an environment token.
  const personal = await limits.refresh("claude-personal");
  assert.deepEqual(seen, ["Bearer work-token"]);
  assert.match(personal.error?.message ?? "", /not signed in/);
  assert.equal(personal.account?.label, "Personal");

  // A Codex account reads only its own CODEX_HOME, never ~/.codex or the env.
  const codex = await limits.refresh("codex-second");
  assert.deepEqual(seen, ["Bearer work-token"]);
  assert.match(codex.error?.message ?? "", /Codex account is not signed in/);
  assert.deepEqual(codex.account, { family: "codex", harnessId: "codex-second", label: "Second" });
});

test("an Antigravity account reads only its own agy login under its private HOME", async () => {
  const seen: string[] = [];
  const token = (access: string) => JSON.stringify({ token: { access_token: access, expiry: "2099-01-01T00:00:00Z" } });
  const limits = createUsageLimitService({ jitterMs: 0 });
  createHarnessAccountLimits({
    limits,
    harnesses: () => [
      harness("antigravity", undefined, "/home/test", "antigravity"),
      harness("antigravity-ines", "Ines", "/data/antigravity-accounts/ines", "antigravity"),
      harness("antigravity-empty", "Empty", "/data/antigravity-accounts/empty", "antigravity"),
    ],
    reserved: new Set(),
    discovery: {
      ...discovery([], {
        "/home/test/.gemini/antigravity-cli/antigravity-oauth-token": token("default-token"),
        "/home/test/.config/opencode/antigravity-accounts.json": JSON.stringify({ accounts: [{ refreshToken: "plugin-refresh" }] }),
        "/data/antigravity-accounts/ines/.gemini/antigravity-cli/antigravity-oauth-token": token("ines-token"),
      }),
      readAuth: () => ({ antigravity: { access: "opencode-token" } }),
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({
          groups: [{ displayName: "Gemini", buckets: [{ window: "weekly", remainingFraction: 0.75, resetTime: "2099-01-01T00:00:00Z" }] }],
        }), { status: 200 });
      }) as typeof fetch,
    },
  }).reconcile();
  // The default login stays the family's own source.
  assert.deepEqual(limits.providerIds(), ["antigravity-ines", "antigravity-empty"]);

  const ines = await limits.refresh("antigravity-ines");
  assert.deepEqual([...new Set(seen)], ["Bearer ines-token"]);
  assert.deepEqual(ines.account, { family: "antigravity", harnessId: "antigravity-ines", label: "Ines" });
  assert.equal(ines.windows[0]?.used, 25);

  // Without its own sign-in it never borrows the default login, the OpenCode
  // plugin's accounts file or the OpenCode auth file.
  seen.length = 0;
  const empty = await limits.refresh("antigravity-empty");
  assert.deepEqual(seen, []);
  assert.match(empty.error?.message ?? "", /Antigravity account is not signed in/);
});

test("accounts follow the registry: a rename shows at once, a removal drops the source, a reserved id stays", async () => {
  const limits = createUsageLimitService({ jitterMs: 0 });
  const work = harness("claude-work", "Work", "/data/claude-accounts/work");
  let harnesses: HarnessProvider[] = [work, harness("claude-team", "Team", "/data/claude-accounts/team")];
  const accounts = createHarnessAccountLimits({
    limits,
    harnesses: () => harnesses,
    reserved: new Set(["claude-team"]),
    discovery: discovery([], {}),
  });
  accounts.reconcile();
  assert.deepEqual(limits.providerIds(), ["claude-work"]);

  work.descriptor.accountLabel = "Work (renamed)";
  assert.equal(limits.snapshots()[0]?.account?.label, "Work (renamed)");

  harnesses = [];
  accounts.reconcile();
  assert.deepEqual(limits.providerIds(), []);
});

test("the limits service reconciles discovered sources before reads, refreshes and polls", async () => {
  let reconciles = 0;
  const limits = createUsageLimitService({ jitterMs: 0, reconcile: () => { reconciles += 1; } });
  limits.snapshots();
  limits.providerIds();
  await limits.refreshAll();
  await assert.rejects(() => limits.refresh("absent"), { code: "not-found" });
  limits.start();
  limits.stop();
  assert.equal(reconciles, 5);
});

test("a macOS account reads its own keychain entry, keyed like Claude Code keys it", async () => {
  const configDir = "/Users/test/claude-accounts/work";
  const expected = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
  assert.equal(claudeKeychainService(configDir), expected);
  assert.equal(claudeKeychainService(), "Claude Code-credentials");

  const services: string[] = [];
  const seen: string[] = [];
  const limits = createUsageLimitService({ jitterMs: 0 });
  createHarnessAccountLimits({
    limits,
    harnesses: () => [harness("claude-work", "Work", configDir)],
    reserved: new Set(),
    discovery: {
      ...discovery(seen, {}),
      platform: "darwin",
      readKeychain: (service) => {
        services.push(service);
        return service === expected ? credentials("keychain-work") : credentials("keychain-default");
      },
    },
  }).reconcile();
  await limits.refresh("claude-work");
  assert.deepEqual(services, [expected]);
  assert.deepEqual(seen, ["Bearer keychain-work"]);
});

test("an account harness id names its base harness and provider", () => {
  assert.deepEqual(harnessAccountOf("claude-work"), { harnessId: "claude", account: "work" });
  assert.equal(harnessAccountOf("claude"), undefined);
  assert.equal(harnessAccountOf("claude-code"), undefined);
  assert.equal(harnessAccountOf("my-custom_harness"), undefined);
  assert.equal(displayHarness("claude-work"), "Claude Code · Work");
  assert.equal(displayHarness("claude-code"), "Claude Code");
  const projection = { resolvedHarnessId: "claude-work" } as SessionProjection;
  assert.equal(resolveSessionUsageProviderId(projection), "anthropic");
});

test("the harness breakdown names an account by its live registry label", async () => {
  const space: SpaceContext = { spaceId: "space-a", spaceSlug: "space-a", userId: "user", role: "owner", deployment: "local-trusted", storageDir: "/tmp/unused" };
  const project: Project = { id: "project-a", name: "project-a", path: "/project-a", createdAt: 1 };
  const time = Date.UTC(2026, 6, 1, 12);
  const session = (id: string, harnessId: string): SessionProjection => ({
    id, projectId: "project-a", title: id, status: "idle", createdAt: 1, updatedAt: time, lastTurnAt: time,
    resolvedHarnessId: harnessId, model: { providerID: "anthropic", modelID: "sonnet" },
  });
  const event = (sessionId: string, seq: number, type: string, data: JsonObject): SessionEvent =>
    ({ id: `${sessionId}-${seq}`, sessionId, seq, time: time + seq, type, data, v: 1 });
  const events = (sessionId: string, harnessId: string): SessionEvent[] => [
    event(sessionId, 1, "turn/started", { turnId: "turn-1", harnessId }),
    event(sessionId, 2, "usage/recorded", { model: { providerID: "anthropic", modelID: "sonnet" }, tokens: { input: 10, output: 2 } }),
    event(sessionId, 3, "turn/stopped", { turnId: "turn-1", reason: "completed" }),
  ];
  const sessions = [session("a", "claude"), session("b", "claude-work"), session("c", "claude-old")];
  const service = createUsageAnalyticsService({
    source: {
      projections: async () => sessions,
      events: async (_space, id) => events(id, sessions.find((row) => row.id === id)!.resolvedHarnessId!),
    },
    now: () => Date.UTC(2026, 6, 10),
    serverInstanceId: "server-a",
    harnessLabel: (id) => (id === "claude-work" ? "Claude Code · Work Account" : undefined),
  });
  const report = await service.query(space, [project], { range: "30d", timezone: "UTC" });
  // A removed account keeps a readable name derived from its id.
  assert.deepEqual(
    Object.fromEntries(report.harnesses.map((group) => [group.id, group.label])),
    { claude: "Claude Code", "claude-work": "Claude Code · Work Account", "claude-old": "Claude Code · Old" },
  );
  service.stop();
});
