import test from "node:test";
import assert from "node:assert/strict";
import type { QuotaPace, QuotaWindow, SessionEvent, SessionProjection } from "@polyth/contracts";
import type { WebNotificationInput } from "@polyth/web-sdk";
import {
  cacheAlertAt,
  collapseAlertBurst,
  emptyAlertLedger,
  evaluateLimitAlerts,
  parseAlertLedger,
  remainingByWindow,
  turnSummary,
  addTurnUsage,
  emptyTurnUsage,
  type UsageAlertLedger,
} from "../widgets/usage/alertsModel.ts";
import { DEFAULT_USAGE_ALERT_PREFS, sanitizeUsageAlertPrefs, type UsageAlertPrefs } from "../widgets/usage/alertsPrefs.ts";
import { DEFAULT_USAGE_LIMITS_PREFS } from "../widgets/usage/limitsPrefs.ts";
import type { UsageLimitSnapshotDto, UsageLimitsResponse } from "../widgets/usage/limitsClient.ts";
import { ALERT_LEDGER_KEY, createUsageAlerts, spaceAlertLedgerKey, type UsageAlertsDeps } from "../widgets/usage/alertsController.ts";
import type { RemoteAlertLedgers, RemoteAlertLedgersUpdate } from "../widgets/usage/alertLedgerClient.ts";
import { mergeAlertLedgers } from "../src/alertLedger.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 16, 12);

const win = (patch: Partial<QuotaWindow> = {}): QuotaWindow => ({
  id: "5h", label: "5-hour", unit: "percent", used: 50, limit: 100,
  periodMs: 5 * HOUR, resetsAt: NOW + 2 * HOUR, ...patch,
});

const source = (
  windows: QuotaWindow[],
  patch: Partial<UsageLimitSnapshotDto> = {},
): UsageLimitSnapshotDto => ({
  providerId: "claude", fetchedAt: NOW, stale: false, windows, balances: [], pace: {}, ...patch,
});

const prefs = (patch: Partial<UsageAlertPrefs> = {}): UsageAlertPrefs => ({ ...DEFAULT_USAGE_ALERT_PREFS, ...patch });

const run = (providers: UsageLimitSnapshotDto[], ledger: UsageAlertLedger = emptyAlertLedger(), patch: Partial<UsageAlertPrefs> = {}, now = NOW) =>
  evaluateLimitAlerts({ providers, prefs: prefs(patch), limits: DEFAULT_USAGE_LIMITS_PREFS, ledger, now });

test("alert preferences fall back to defaults and keep levels in canonical order", () => {
  assert.deepEqual(sanitizeUsageAlertPrefs(null), DEFAULT_USAGE_ALERT_PREFS);
  const parsed = sanitizeUsageAlertPrefs({
    enabled: "yes", lowLevels: [5, 50, 7, 25], turnParts: ["limits", "bogus", "tokens"],
    turnMinTokens: -4, pausedUntil: "soon", paceLevel: "likely", cacheLeadMinutes: 3, mutedSources: [" Claude ", "claude", 4],
  });
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.lowLevels, [50, 25, 5]);
  assert.deepEqual(parsed.turnParts, ["tokens", "limits"]);
  assert.equal(parsed.turnMinTokens, 0);
  assert.equal(parsed.pausedUntil, 0);
  assert.equal(parsed.paceLevel, "likely");
  assert.equal(parsed.cacheLeadMinutes, 1);
  assert.deepEqual(parsed.mutedSources, ["claude"]);
});

test("a low limit alerts once per level and again at a lower level", () => {
  const first = run([source([win({ used: 80 })])]);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0]!.rule, "low");
  assert.equal(first.alerts[0]!.title, "Claude 5-hour: 20% left");
  assert.match(first.alerts[0]!.body, /^Resets in 2 hours\.$/);

  const again = run([source([win({ used: 82 })])], first.ledger);
  assert.equal(again.alerts.length, 0, "same level does not repeat");

  const lower = run([source([win({ used: 91 })])], again.ledger);
  assert.deepEqual(lower.alerts.map((alert) => alert.title), ["Claude 5-hour: 9% left"]);
});

test("a new period re-arms the alerts and an exhausted limit reports when it is back", () => {
  const exhausted = run([source([win({ used: 100 })])]);
  assert.equal(exhausted.alerts[0]!.rule, "exhausted");
  assert.equal(exhausted.alerts[0]!.kind, "error");
  assert.equal(exhausted.alerts[0]!.title, "Claude 5-hour limit reached");
  assert.equal(run([source([win({ used: 100 })])], exhausted.ledger).alerts.length, 0);

  const reset = run([source([win({ used: 2, resetsAt: NOW + 7 * HOUR })])], exhausted.ledger, {}, NOW + 2 * HOUR + 60_000);
  assert.deepEqual(reset.alerts.map((alert) => [alert.rule, alert.title]), [["restored", "Claude 5-hour is available again"]]);

  const lowAgain = run([source([win({ used: 80, resetsAt: NOW + 7 * HOUR })])], reset.ledger, {}, NOW + 4 * HOUR);
  assert.equal(lowAgain.alerts[0]?.rule, "low", "the new period alerts from scratch");
});

test("a refill without a reset time also starts a new period", () => {
  const noReset = (used: number) => source([win({ used, resetsAt: undefined, periodMs: undefined })]);
  const low = run([noReset(80)]);
  assert.equal(low.alerts.length, 1);
  assert.equal(run([noReset(10)], low.ledger).alerts.length, 0);
  assert.equal(run([noReset(80)], run([noReset(10)], low.ledger).ledger).alerts.length, 1);
});

test("pace alerts follow the chosen level and escalate once", () => {
  const elevated: QuotaPace = { usageFraction: .4, timeFraction: .2, pace: "over" };
  const likely: QuotaPace = { ...elevated, predictedAtReset: 140, exhaustsAt: NOW + HOUR };
  const window = win({ used: 40, resetsAt: NOW + 4 * HOUR });
  const withPace = (pace: QuotaPace) => source([window], { pace: { "5h": pace } });

  const fast = run([withPace(elevated)]);
  assert.equal(fast.alerts[0]?.title, "Claude 5-hour is running fast");
  assert.equal(run([withPace(elevated)], fast.ledger).alerts.length, 0);
  const escalated = run([withPace(likely)], fast.ledger);
  assert.equal(escalated.alerts[0]?.title, "Claude 5-hour may run out before it resets");
  assert.match(escalated.alerts[0]!.body, /runs out in 1 hour/);

  assert.equal(run([withPace(elevated)], emptyAlertLedger(), { paceLevel: "likely" }).alerts.length, 0);
  assert.equal(run([withPace(likely)], emptyAlertLedger(), { paceLevel: "likely" }).alerts.length, 1);
});

test("off, paused, muted and hidden sources stay quiet without spending the alert", () => {
  const low = [source([win({ used: 95 })])];
  const paused = run(low, emptyAlertLedger(), { pausedUntil: NOW + HOUR });
  assert.equal(paused.alerts.length, 0);
  assert.equal(run(low, paused.ledger).alerts.length, 1, "still true after the pause, so it shows");

  assert.equal(run(low, emptyAlertLedger(), { enabled: false }).alerts.length, 0);
  assert.equal(run(low, emptyAlertLedger(), { mutedSources: ["claude"] }).alerts.length, 0);
  const hidden = evaluateLimitAlerts({
    providers: low, prefs: prefs(), limits: { ...DEFAULT_USAGE_LIMITS_PREFS, hiddenSources: ["claude"] }, ledger: emptyAlertLedger(), now: NOW,
  });
  assert.equal(hidden.alerts.length, 0);
});

test("a source that needs sign-in alerts once until it recovers", () => {
  const broken = source([], { error: { code: "unauthorized", message: "token expired" } });
  const first = run([broken]);
  assert.deepEqual(first.alerts.map((alert) => alert.title), ["Claude needs you to sign in again"]);
  assert.equal(run([broken], first.ledger).alerts.length, 0);
  const healthy = run([source([])], first.ledger);
  assert.equal(run([broken], healthy.ledger).alerts.length, 1);
  assert.equal(run([source([], { error: { code: "timeout", message: "slow" } })]).alerts.length, 0, "a transient failure is not a sign-in problem");
});

test("an expired key reads as a rejected key, not as a signed-out account", () => {
  // A signed-in account can still hold a stale API key; telling the person to
  // sign in again sends them to the wrong fix.
  const rejected = run([source([], {
    error: { code: "fetch-failed", message: "OpenCode Go rejected all 2 stored logins (expired or revoked). Create a new key in OpenCode Console." },
  })]);
  assert.deepEqual(rejected.alerts.map((alert) => alert.title), ["Claude has a rejected API key"]);
  assert.match(rejected.alerts[0]!.body, /expired or revoked/);
  assert.doesNotMatch(rejected.alerts[0]!.title, /sign in/i);

  const signedOut = run([source([], { error: { code: "unauthorized", message: "no credential stored" } })]);
  assert.deepEqual(signedOut.alerts.map((alert) => alert.title), ["Claude needs you to sign in again"]);

  // An expired sign-in names no key, so it is not reported as a rejected one.
  const session = run([source([], { error: { code: "fetch-failed", message: "Claude session expired. Open Claude Code to sign in again." } })]);
  assert.deepEqual(session.alerts.map((alert) => alert.title), ["Claude needs you to sign in again"]);
  // A token the harness renews on its next run is not the person's problem.
  const renewing = run([source([], { error: { code: "login-renewing", message: "Claude's sign-in token expired." } })]);
  assert.equal(renewing.alerts.length, 0);
});

test("a burst keeps the most urgent cards and summarizes the rest", () => {
  const windows = ["a", "b", "c", "d"].map((id) => win({ id, label: id.toUpperCase(), used: 95 }));
  const { alerts } = run([source([...windows, win({ id: "e", label: "E", used: 100 })])]);
  assert.equal(alerts.length, 5);
  const shown = collapseAlertBurst(alerts);
  assert.equal(shown.length, 3);
  assert.equal(shown[0]!.rule, "exhausted");
  assert.equal(shown[2]!.title, "3 more limits need attention");
});

test("the ledger survives a malformed stored value", () => {
  assert.deepEqual(parseAlertLedger("nope"), emptyAlertLedger());
  assert.deepEqual(parseAlertLedger({ version: 2, windows: {}, sources: {} }), emptyAlertLedger());
  const kept = parseAlertLedger({ version: 1, windows: { "a/b": { remaining: .5, at: 1 }, bad: { at: "x" } }, sources: { a: "sign-in", b: 3 } });
  assert.deepEqual(Object.keys(kept.windows), ["a/b"]);
  assert.deepEqual(kept.sources, { a: "sign-in" });
});

test("a turn summary shows usage, the cache share and the limits it ran against", () => {
  let usage = addTurnUsage(emptyTurnUsage(), { input: 1_000, output: 400, cacheRead: 8_600 }, 0.05);
  usage = addTurnUsage(usage, { input: 0, output: 0 }, 0.01);
  const providers = [source([win({ used: 38 }), win({ id: "7d", label: "Weekly", used: 10 }), win({ id: "opus/7d", label: "Opus weekly", used: 90 })])];
  const before = remainingByWindow([source([win({ used: 35 }), win({ id: "7d", label: "Weekly", used: 10 })])]);
  const summary = turnSummary({
    usage,
    session: { resolvedHarnessId: "claude", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, title: "Refactor" },
    named: false,
    providers,
    before,
    prefs: prefs(),
  });
  assert.deepEqual(summary, {
    title: "Turn used 10.0k tokens · $0.0600",
    body: "86% from cache · Claude 5-hour 62% left (−3%) · Claude Weekly 90% left",
  });

  assert.equal(turnSummary({ usage, session: {}, named: false, providers: [], before, prefs: prefs({ turnMinTokens: 20_000 }) }), null);
  const named = turnSummary({ usage, session: { title: "Refactor" }, named: true, providers: [], before, prefs: prefs({ turnParts: ["cost"] }) });
  assert.deepEqual(named, { title: "Turn used $0.0600", body: "Refactor" });
});

test("the cache warning is only scheduled for a known lifetime and a prefix worth keeping", () => {
  const health = { lastActivityAt: NOW, ttlMs: 5 * 60_000, ttlBasis: "provider-default" as const, cachedTokens: 120_000, burn: { tokens: 0, rewrites: 0 } };
  assert.equal(cacheAlertAt(health, 60_000, NOW + 1_000), NOW + 4 * 60_000);
  assert.equal(cacheAlertAt({ ...health, ttlMs: null, ttlBasis: "unknown" }, 60_000, NOW), null);
  assert.equal(cacheAlertAt({ ...health, cachedTokens: 2_000 }, 60_000, NOW), null);
  assert.equal(cacheAlertAt(health, 60_000, NOW + 6 * 60_000), null);
  assert.equal(cacheAlertAt(health, 5 * 60_000, NOW), null, "a lead as long as the lifetime is meaningless");
});

// ---- controller ----

interface Harness {
  deps: UsageAlertsDeps;
  shown: WebNotificationInput[];
  emit(event: Partial<SessionEvent> & { type: string; sessionId: string }): void;
  refreshes: string[];
  dismissed: string[];
  stored: Map<string, string>;
  setProviders(providers: UsageLimitSnapshotDto[]): void;
  sessions: Map<string, SessionProjection>;
  setVisibleSession(id: string | null): void;
  setPrefs(patch: Partial<UsageAlertPrefs>): void;
}

function harness(initial: Partial<UsageAlertPrefs> = {}): Harness {
  let providers: UsageLimitSnapshotDto[] = [];
  let alertPrefs = prefs(initial);
  let visibleSession: string | null = "s1";
  const prefListeners = new Set<() => void>();
  const listeners = new Set<(event: SessionEvent) => void>();
  const shown: WebNotificationInput[] = [];
  const dismissed: string[] = [];
  const refreshes: string[] = [];
  const stored = new Map<string, string>();
  const sessions = new Map<string, SessionProjection>([
    ["s1", { id: "s1", projectId: "p", title: "Refactor", status: "idle", resolvedHarnessId: "claude", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } } as SessionProjection],
    ["s2", { id: "s2", projectId: "p", title: "Docs", status: "idle", resolvedHarnessId: "claude" } as SessionProjection],
    ["child", { id: "child", projectId: "p", parentId: "s1", title: "Worker", status: "idle", resolvedHarnessId: "claude" } as SessionProjection],
  ]);
  const response = (): UsageLimitsResponse => ({ providers, fetchedAt: NOW });
  let seq = 0;
  const deps: UsageAlertsDeps = {
    notifications: { show: (input) => { shown.push(input); }, dismiss: (id) => { dismissed.push(id); } },
    sessions: {
      get: (id) => sessions.get(id),
      events: () => [],
      subscribeEvents: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    visibleSessionId: () => visibleSession,
    openLimits: () => undefined,
    openSettings: () => undefined,
    openSession: () => undefined,
    loadLimits: async () => response(),
    refreshLimitSource: async (id) => {
      refreshes.push(id);
      providers = providers.map((provider) => provider.providerId === id
        ? { ...provider, fetchedAt: NOW, windows: provider.windows.map((window) => ({ ...window, used: window.used + 3 })) }
        : provider);
      return response();
    },
    cachedLimits: () => response(),
    now: () => NOW,
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } },
    visibility: { visible: () => true, subscribe: () => () => undefined },
    prefs: {
      alerts: () => alertPrefs,
      limits: () => DEFAULT_USAGE_LIMITS_PREFS,
      subscribe: (listener) => { prefListeners.add(listener); return () => prefListeners.delete(listener); },
    },
  };
  return {
    deps, shown, dismissed, refreshes, stored, sessions,
    emit: (event) => {
      seq += 1;
      const full = { id: `e${seq}`, seq, time: NOW, data: {}, v: 1, ...event } as SessionEvent;
      for (const listener of listeners) listener(full);
    },
    setProviders: (next) => { providers = next; },
    setVisibleSession: (id) => { visibleSession = id; },
    setPrefs: (patch) => {
      alertPrefs = { ...alertPrefs, ...patch };
      for (const listener of prefListeners) listener();
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("the controller alerts from the snapshot once and keeps the ledger in storage", async () => {
  const h = harness();
  h.setProviders([source([win({ used: 92 })])]);
  const controller = createUsageAlerts(h.deps);
  await settle();
  assert.deepEqual(h.shown.map((input) => [input.id, input.kind, input.title]), [["limit:claude/5h", "warning", "Claude 5-hour: 8% left"]]);
  assert.ok(h.stored.get(ALERT_LEDGER_KEY));
  await controller.check();
  assert.equal(h.shown.length, 1, "a second check does not repeat it");
  controller.dispose();

  const reloaded = createUsageAlerts(h.deps);
  await settle();
  assert.equal(h.shown.length, 1, "a reload reads the stored ledger");
  reloaded.dispose();
});

test("a source that works again takes its sign-in notice off the screen", async () => {
  const h = harness();
  h.setProviders([source([], { error: { code: "unauthorized", message: "no credential stored" } })]);
  const controller = createUsageAlerts(h.deps);
  await settle();
  assert.deepEqual(h.shown.map((input) => input.id), ["source:claude"]);
  assert.deepEqual(h.dismissed, []);
  h.setProviders([source([])]);
  await controller.check();
  assert.deepEqual(h.dismissed, ["source:claude"]);
  controller.dispose();
});

test("a per-Space estimate alerts and keeps its ledger per Space, never across Spaces", async () => {
  const h = harness();
  const spaceA = { serverInstanceId: "server-1", spaceId: "space-a" };
  const spaceB = { serverInstanceId: "server-1", spaceId: "space-b" };
  const estimate = source([win({ unit: "requests", used: 1104, limit: 1200 })], { providerId: "alibaba-coding-plan", scope: "space" });
  let answer: UsageLimitsResponse = { ...spaceA, providers: [estimate], fetchedAt: NOW };
  const deps: UsageAlertsDeps = { ...h.deps, loadLimits: async () => answer, cachedLimits: () => null };
  const alertsFor = () => h.shown.filter((input) => input.id === "limit:alibaba-coding-plan/5h");
  const controller = createUsageAlerts(deps);
  await settle();
  assert.equal(alertsFor().length, 1, "Space A is told about its own estimate");
  const ledgerA = h.stored.get(spaceAlertLedgerKey(spaceA));
  assert.ok(ledgerA && JSON.parse(ledgerA).windows["alibaba-coding-plan/5h"]);
  const shared = JSON.parse(h.stored.get(ALERT_LEDGER_KEY) ?? "{\"windows\":{}}");
  assert.equal(shared.windows["alibaba-coding-plan/5h"], undefined, "the shared ledger never holds a per-Space source");

  // Space B's estimate at the same level is judged on its own ledger, not suppressed by Space A's.
  answer = { ...spaceB, providers: [estimate], fetchedAt: NOW };
  await controller.check();
  assert.equal(alertsFor().length, 2);
  assert.equal(h.stored.get(spaceAlertLedgerKey(spaceA)), ledgerA, "Space B leaves Space A's ledger alone");
  await controller.check();
  assert.equal(alertsFor().length, 2, "and does not repeat within Space B");

  // A per-Space source the response cannot attribute to a Space is not evaluated at all.
  answer = { providers: [{ ...estimate, windows: [win({ unit: "requests", used: 1200, limit: 1200 })] }], fetchedAt: NOW };
  await controller.check();
  assert.equal(alertsFor().length, 2);
  controller.dispose();
});

test("a finished turn in the visible chat shows its summary with freshly read limits", async () => {
  const h = harness({ turn: true, low: false, pace: false });
  h.setProviders([source([win({ used: 30 })], { fetchedAt: NOW - 5 * 60_000 })]);
  const controller = createUsageAlerts(h.deps);
  await settle();
  h.emit({ type: "turn/started", sessionId: "s1", data: { turnId: "t1" } });
  h.emit({ type: "usage/recorded", sessionId: "s1", data: { turnId: "t1", model: { providerID: "anthropic", modelID: "x" }, tokens: { input: 1200, output: 300 }, cost: 0.02 } });
  h.emit({ type: "turn/stopped", sessionId: "s1", data: { turnId: "t1", reason: "completed" } });
  await settle();
  assert.deepEqual(h.refreshes, ["claude"], "an old reading is refreshed once");
  const summary = h.shown.find((input) => input.data?.["usage-alert"] === "summary");
  assert.ok(summary);
  assert.equal(summary.title, "Turn used 1.5k tokens · $0.0200");
  assert.equal(summary.body, "Claude 5-hour 67% left (−3%)");
  assert.equal(summary.duration, 4_000);

  // Another chat, the scope is "This chat": quiet. A replayed old stop: quiet.
  h.emit({ type: "turn/stopped", sessionId: "s2", data: { turnId: "t2", reason: "completed" } });
  h.emit({ type: "turn/stopped", sessionId: "s1", time: NOW - 10 * 60_000, data: { turnId: "t0", reason: "completed" } });
  await settle();
  assert.equal(h.shown.filter((input) => input.data?.["usage-alert"] === "summary").length, 1);
  controller.dispose();
});

test("all-chats summaries name the chat and leave delegated children out", async () => {
  const h = harness({ turn: true, turnScope: "all", turnParts: ["tokens"], low: false, pace: false });
  const controller = createUsageAlerts(h.deps);
  await settle();
  h.emit({ type: "usage/recorded", sessionId: "s2", data: { turnId: "t", model: { providerID: "a", modelID: "b" }, tokens: { input: 10, output: 5 } } });
  h.emit({ type: "turn/stopped", sessionId: "s2", data: { turnId: "t", reason: "completed" } });
  h.emit({ type: "turn/stopped", sessionId: "child", data: { turnId: "c", reason: "completed" } });
  await settle();
  const summaries = h.shown.filter((input) => input.data?.["usage-alert"] === "summary");
  assert.deepEqual(summaries.map((input) => [input.id, input.title, input.body]), [["turn:s2", "Turn used 15 tokens", "Docs"]]);
  assert.deepEqual(h.refreshes, [], "limits are not re-read when the summary does not show them");
  controller.dispose();
});

test("previews use the real source name and never touch the ledger", async () => {
  const h = harness({ low: false, pace: false, exhausted: false, restored: false, sourceProblems: false });
  h.setProviders([source([win({ used: 10, label: "Weekly" })], { providerId: "codex" })]);
  const controller = createUsageAlerts(h.deps);
  await settle();
  controller.preview("low");
  controller.preview("summary");
  assert.deepEqual(h.shown.map((input) => input.id), ["preview:low", "preview:summary"]);
  assert.equal(h.shown[0]!.title, "Codex Weekly: 10% left");
  assert.equal(h.shown[0]!.data?.["usage-alert-preview"], "true");
  assert.equal(h.stored.get(ALERT_LEDGER_KEY), undefined);
  controller.dispose();
});

test("turning a rule on judges the snapshot already in hand", async () => {
  const h = harness({ low: false, pace: false, exhausted: false, restored: false, sourceProblems: false });
  h.setProviders([source([win({ used: 100 })])]);
  const controller = createUsageAlerts(h.deps);
  await settle();
  assert.equal(h.shown.length, 0);
  h.setPrefs({ exhausted: true });
  assert.deepEqual(h.shown.map((input) => input.title), ["Claude 5-hour limit reached"]);
  h.setPrefs({ keepOnScreen: true, low: true });
  assert.equal(h.shown.length, 1, "the reached limit already covers the low levels");
  controller.dispose();
});

// ---- the person's ledger on the server ----

/** An in-memory stand-in for `/api/usage/alerts/ledger`: writes merge like the route's. */
function ledgerServer() {
  let ledgers: RemoteAlertLedgers = { host: null, space: null };
  const saves: RemoteAlertLedgersUpdate[] = [];
  let failLoads = 0;
  return {
    saves,
    get ledgers() { return ledgers; },
    failNextLoads(count: number) { failLoads = count; },
    store: {
      load: async () => {
        if (failLoads > 0) {
          failLoads -= 1;
          throw Object.assign(new Error("connection lost"), { status: 0 });
        }
        return ledgers;
      },
      save: async (update: RemoteAlertLedgersUpdate) => {
        saves.push(update);
        if (update.host) ledgers = { ...ledgers, host: ledgers.host ? mergeAlertLedgers(ledgers.host, update.host) : update.host };
        return ledgers;
      },
    } satisfies NonNullable<UsageAlertsDeps["ledgerStore"]>,
  };
}

test("a relaunch with empty storage does not repeat an alert the person already saw", async () => {
  // The phone app's shell starts with empty localStorage on every launch.
  const server = ledgerServer();
  const first = harness();
  first.setProviders([source([win({ used: 100 })])]);
  const firstController = createUsageAlerts({ ...first.deps, ledgerStore: server.store });
  await settle();
  assert.deepEqual(first.shown.map((input) => input.title), ["Claude 5-hour limit reached"]);
  assert.equal(server.saves.length, 1, "the announcement is kept with the person");
  assert.equal(server.ledgers.host?.windows["claude/5h"]?.exhausted, true);
  await firstController.check();
  assert.equal(server.saves.length, 1, "an unchanged announcement is not written again");
  firstController.dispose();

  const relaunch = harness();
  relaunch.setProviders([source([win({ used: 100 })])]);
  const relaunched = createUsageAlerts({ ...relaunch.deps, ledgerStore: server.store });
  await settle();
  assert.equal(relaunch.shown.length, 0, "the same period stays quiet on a fresh page");
  relaunched.dispose();

  // The next period is news again, once.
  const later = harness();
  later.setProviders([source([win({ used: 100, resetsAt: NOW + 7 * HOUR })])]);
  const laterController = createUsageAlerts({ ...later.deps, ledgerStore: server.store });
  await settle();
  assert.deepEqual(later.shown.map((input) => input.title), ["Claude 5-hour limit reached"]);
  laterController.dispose();
});

test("a page waits for the person's ledger before it alerts", async () => {
  const server = ledgerServer();
  server.failNextLoads(1);
  const h = harness();
  h.setProviders([source([win({ used: 92 })])]);
  const controller = createUsageAlerts({ ...h.deps, ledgerStore: server.store });
  await settle();
  assert.equal(h.shown.length, 0, "an unread ledger could repeat what was already shown");
  assert.equal(h.stored.get(ALERT_LEDGER_KEY), undefined);
  await controller.check();
  assert.deepEqual(h.shown.map((input) => input.title), ["Claude 5-hour: 8% left"]);
  controller.dispose();
});

test("a server that keeps no ledger leaves the alerts to this device's ledger", async () => {
  const h = harness();
  h.setProviders([source([win({ used: 92 })])]);
  const saves: RemoteAlertLedgersUpdate[] = [];
  const controller = createUsageAlerts({
    ...h.deps,
    ledgerStore: { load: async () => null, save: async (update) => { saves.push(update); return null; } },
  });
  await settle();
  assert.equal(h.shown.length, 1);
  await controller.check();
  assert.equal(h.shown.length, 1, "the local ledger still keeps it to once");
  assert.deepEqual(saves, []);
  controller.dispose();
});
