// Runs the usage notifications for one browser tab. It reads only what Usage
// already has — the Limits snapshot (`GET /api/usage/limits`, no provider
// request), the session events the host delivers and the projections — and
// shows passing notices through `host.notifications`. It never sends a turn.
//
// Only a visible tab evaluates, so two open tabs normally do not both alert,
// and the ledger keeps a reload, another tab or a later visit from repeating an
// alert for the same limit period. localStorage holds this browser's copy; the
// server keeps the person's copy (alertLedgerClient.ts), which is merged in
// before every evaluation, so another device or the phone app (whose shell
// starts with empty localStorage on every launch) does not repeat it either.
// Host-wide sources share one ledger; a per-Space source (limitsIdentity.ts)
// keeps its own ledger under its server and Space, so one Space never
// suppresses or re-arms another's alerts.
import type { SessionEvent, SessionProjection, TokenUsage, UsageRecordedData } from "@polyth/contracts";
import type { WebNotificationAction, WebNotificationInput } from "@polyth/web-sdk";
import { fmtCost } from "../../../../apps/web/src/format.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { sessionCacheHealth } from "../../src/analytics/cacheHealth.ts";
import { collectSessionObservations } from "../../src/analytics/collect.ts";
import { currentLimitSources } from "../../src/limitSources.ts";
import {
  addTurnUsage,
  cacheAlert,
  cacheAlertAt,
  collapseAlertBurst,
  emptyAlertLedger,
  emptyTurnUsage,
  evaluateLimitAlerts,
  limitName,
  parseAlertLedger,
  remainingByWindow,
  turnSummary,
  type TurnUsage,
  type UsageAlert,
  type UsageAlertLedger,
} from "./alertsModel.ts";
import {
  ALERT_DURATION_MS,
  alertsPaused,
  getUsageAlertPrefs,
  subscribeUsageAlertPrefs,
  type UsageAlertPrefs,
} from "./alertsPrefs.ts";
import { alertLedgerAnnouncements, mergeAlertLedgers } from "../../src/alertLedger.ts";
import type { RemoteAlertLedgers, RemoteAlertLedgersUpdate } from "./alertLedgerClient.ts";
import type { UsageLimitsResponse, UsageLimitSnapshotDto } from "./limitsClient.ts";
import { attributableLimits, hostWideLimits, limitsIdentity, sameLimitsIdentity, spaceScopedLimits, type UsageLimitsIdentity } from "./limitsIdentity.ts";
import { limitSourceName } from "./limitsModel.ts";
import { getUsageLimitsPrefs, subscribeUsageLimitsPrefs, type UsageLimitsPrefs } from "./limitsPrefs.ts";

export const ALERT_LEDGER_KEY = "polyth.usageAlerts.1";
/** The ledger of one server's Space for its per-Space sources. */
export const spaceAlertLedgerKey = (identity: UsageLimitsIdentity): string =>
  `polyth.usageAlerts.space.1:${JSON.stringify([identity.serverInstanceId, identity.spaceId])}`;
/** How often a visible tab re-reads the server's snapshot for limit alerts. */
export const ALERT_POLL_MS = 2 * 60_000;
/** A source is asked for fresh values after a turn only when its reading is older than this. */
export const AFTER_TURN_REFRESH_MIN_AGE_MS = 90_000;
/** Turns that show no summary re-read the snapshot at most this often. */
const AFTER_TURN_CHECK_SPACING_MS = 10_000;
/** Events older than this are history being loaded, not a turn that just ended. */
const LIVE_EVENT_MAX_AGE_MS = 2 * 60_000;
/** A check re-reads the person's stored ledger when the copy in hand is older than this. */
export const REMOTE_LEDGER_MAX_AGE_MS = 60_000;
const MAX_CACHE_WATCHES = 8;
const MAX_TRACKED_TURNS = 64;

export interface UsageAlertsDeps {
  notifications: {
    show(input: WebNotificationInput): unknown;
    dismiss(id: string): void;
  };
  sessions: {
    get(sessionId: string): SessionProjection | undefined;
    events(sessionId: string): readonly SessionEvent[];
    subscribeEvents(listener: (event: SessionEvent) => void): () => void;
  };
  /** The chat on screen, or null when none is (no session, or a package page in its place). */
  visibleSessionId(): string | null;
  openLimits(): void;
  openSettings(): void;
  openSession(sessionId: string): void;
  loadLimits(): Promise<UsageLimitsResponse>;
  refreshLimitSource(providerId: string): Promise<UsageLimitsResponse>;
  cachedLimits(): UsageLimitsResponse | null;
  /** The person's ledger as the server keeps it. `load` resolves null when the
   * server keeps none; without a store the ledger stays on this device. */
  ledgerStore?: {
    load(): Promise<RemoteAlertLedgers | null>;
    save(update: RemoteAlertLedgersUpdate): Promise<RemoteAlertLedgers | null>;
  };
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Visibility of the document; absent means always visible. */
  visibility?: {
    visible(): boolean;
    subscribe(listener: () => void): () => void;
  };
  prefs?: {
    alerts(): UsageAlertPrefs;
    limits(): UsageLimitsPrefs;
    subscribe(listener: () => void): () => void;
  };
}

export interface UsageAlertsController {
  /** Shows a sample of one notification kind, built from real source names when there are some. */
  preview(rule: UsageAlertPreviewRule): void;
  /** Re-reads the snapshot and evaluates limit alerts now. */
  check(): Promise<void>;
  dispose(): void;
}

export type UsageAlertPreviewRule = "pace" | "low" | "exhausted" | "restored" | "summary" | "cache" | "source";

const defaultStorage = (): Pick<Storage, "getItem" | "setItem"> | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const defaultVisibility = (): UsageAlertsDeps["visibility"] => typeof document === "undefined"
  ? undefined
  : {
    visible: () => document.visibilityState !== "hidden",
    subscribe: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };

const defaultPrefs = (): NonNullable<UsageAlertsDeps["prefs"]> => ({
  alerts: getUsageAlertPrefs,
  limits: getUsageLimitsPrefs,
  subscribe: (listener) => {
    const offAlerts = subscribeUsageAlertPrefs(listener);
    const offLimits = subscribeUsageLimitsPrefs(listener);
    return () => {
      offAlerts();
      offLimits();
    };
  },
});

const limitRulesOn = (prefs: UsageAlertPrefs): boolean =>
  prefs.enabled && (prefs.pace || prefs.low || prefs.exhausted || prefs.restored || prefs.sourceProblems);

/** Turn usage from the loaded event log, when the host holds the turn's events. */
function usageFromEvents(events: readonly SessionEvent[], turnId: string | undefined): TurnUsage | null {
  if (!turnId) return null;
  let usage = emptyTurnUsage();
  let found = false;
  for (const event of events) {
    if (event.type !== "usage/recorded") continue;
    const data = event.data as unknown as UsageRecordedData;
    if (data.turnId !== turnId || !data.tokens) continue;
    found = true;
    usage = addTurnUsage(usage, data.tokens, data.cost);
  }
  return found ? usage : null;
}

export function createUsageAlerts(deps: UsageAlertsDeps): UsageAlertsController {
  const now = deps.now ?? Date.now;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const visibility = deps.visibility === undefined ? defaultVisibility() : deps.visibility;
  const prefs = deps.prefs ?? defaultPrefs();
  const visible = () => visibility?.visible() ?? true;

  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCheckAt = 0;
  let checking: Promise<void> | null = null;
  /** What each limit had left before the turn that is ending, for the "−3%" delta. */
  let lastResponse: UsageLimitsResponse | null = deps.cachedLimits();
  const turnUsage = new Map<string, TurnUsage>();
  const seenStops = new Set<string>();
  const lastRefreshAt = new Map<string, number>();
  const cacheWatches = new Map<string, { timer: ReturnType<typeof setTimeout>; lastActivityAt: number }>();

  const readLedger = (key: string): UsageAlertLedger => {
    try {
      const raw = storage?.getItem(key);
      return raw ? parseAlertLedger(JSON.parse(raw)) : emptyAlertLedger();
    } catch {
      return emptyAlertLedger();
    }
  };
  const writeLedger = (key: string, ledger: UsageAlertLedger) => {
    try {
      storage?.setItem(key, JSON.stringify(ledger));
    } catch {
      // Without storage the in-memory evaluation still avoids repeats in this tab.
    }
  };
  const memoryLedgers = new Map<string, UsageAlertLedger>([[ALERT_LEDGER_KEY, readLedger(ALERT_LEDGER_KEY)]]);

  /** The person's stored ledger: "pending" until this page has read it once,
   * "local" when there is none to read (no store, or a server without it). */
  let remote: { state: "pending" | "local" } | { state: "ready"; ledgers: RemoteAlertLedgers; at: number } =
    { state: deps.ledgerStore ? "pending" : "local" };

  const adoptRemote = (ledgers: RemoteAlertLedgers | null) => {
    if (disposed) return;
    remote = ledgers ? { state: "ready", ledgers, at: now() } : { state: "local" };
  };

  const loadRemote = async (): Promise<void> => {
    const store = deps.ledgerStore;
    if (!store || remote.state === "local") return;
    if (remote.state === "ready" && now() - remote.at < REMOTE_LEDGER_MAX_AGE_MS) return;
    // A failed read keeps what this page had; one that never read it stays quiet.
    await store.load().then(adoptRemote, () => undefined);
  };

  const saveRemote = (update: RemoteAlertLedgersUpdate) => {
    // Not awaited: a lost write is sent again by the next evaluation.
    void deps.ledgerStore?.save(update).then(adoptRemote, () => undefined);
  };

  const remoteLedger = (slot: "host" | "space", identity: UsageLimitsIdentity | null): UsageAlertLedger | null => {
    if (remote.state !== "ready") return null;
    if (slot === "host") return remote.ledgers.host;
    return identity && sameLimitsIdentity(remote.ledgers, identity) ? remote.ledgers.space : null;
  };

  const limitAction = (): WebNotificationAction => ({ label: tr("usage.notiOpenLimits"), run: deps.openLimits });

  const showAlert = (alert: UsageAlert, alertPrefs: UsageAlertPrefs, preview = false) => {
    const sticky = alertPrefs.keepOnScreen && (alert.kind === "warning" || alert.kind === "error");
    deps.notifications.show({
      id: preview ? `preview:${alert.rule}` : alert.id,
      kind: alert.kind,
      title: alert.title,
      ...(alert.body ? { body: alert.body } : {}),
      ...(sticky ? { duration: "sticky" as const } : {}),
      actions: alert.rule === "source"
        ? [{ label: tr("usage.notiOpenSettings"), run: deps.openSettings }]
        : [limitAction()],
      data: { "usage-alert": alert.rule, ...(preview ? { "usage-alert-preview": "true" } : {}) },
    });
  };

  const evaluate = (response: UsageLimitsResponse) => {
    // Until it has read the person's ledger, a page would take every limit as
    // news, and a fresh shell origin would repeat what was already shown.
    if (remote.state === "pending") return;
    const alertPrefs = prefs.alerts();
    const identity = limitsIdentity(response);
    const groups: Array<{ key: string; slot: "host" | "space"; providers: UsageLimitSnapshotDto[] }> = [
      { key: ALERT_LEDGER_KEY, slot: "host", providers: hostWideLimits(response.providers) },
    ];
    const scoped = spaceScopedLimits(response);
    if (identity && scoped.length) groups.push({ key: spaceAlertLedgerKey(identity), slot: "space", providers: scoped });
    const alerts: UsageAlert[] = [];
    const update: RemoteAlertLedgersUpdate = {};
    for (const { key, slot, providers } of groups) {
      // Another tab, or another device, may have alerted since this one last looked.
      const stored = storage ? readLedger(key) : memoryLedgers.get(key) ?? emptyAlertLedger();
      const kept = remoteLedger(slot, identity);
      const ledger = kept ? mergeAlertLedgers(stored, kept) : stored;
      const result = evaluateLimitAlerts({ providers, prefs: alertPrefs, limits: prefs.limits(), ledger, now: now() });
      memoryLedgers.set(key, result.ledger);
      writeLedger(key, result.ledger);
      // A source that works again takes its sign-in/key notice off the screen.
      for (const providerId of Object.keys(ledger.sources)) {
        if (!result.ledger.sources[providerId]) deps.notifications.dismiss(`source:${providerId}`);
      }
      alerts.push(...result.alerts);
      // Only a change in what was announced is worth a write.
      if (remote.state === "ready" && alertLedgerAnnouncements(result.ledger) !== alertLedgerAnnouncements(kept ?? emptyAlertLedger())) {
        if (slot === "host") update.host = result.ledger;
        else if (identity) update.space = { ledger: result.ledger, identity };
      }
    }
    for (const alert of collapseAlertBurst(alerts)) showAlert(alert, alertPrefs);
    if (update.host || update.space) saveRemote(update);
  };

  /** The earlier snapshot's values that may be compared with `next`'s. */
  const comparable = (previous: UsageLimitsResponse | null, next: UsageLimitsResponse): UsageLimitSnapshotDto[] => {
    if (!previous) return [];
    return sameLimitsIdentity(previous, next) ? attributableLimits(previous) : hostWideLimits(previous.providers);
  };

  const check = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (checking) return checking;
    lastCheckAt = now();
    checking = Promise.all([deps.loadLimits(), loadRemote()])
      .then(([response]) => {
        if (disposed) return;
        if (visible() && limitRulesOn(prefs.alerts())) evaluate(response);
        lastResponse = response;
      }, () => undefined)
      .finally(() => {
        checking = null;
      });
    return checking;
  };

  const schedule = () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (disposed || !limitRulesOn(prefs.alerts()) || !visible()) return;
    const wait = Math.max(0, lastCheckAt + ALERT_POLL_MS - now());
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void check().then(schedule);
    }, wait);
  };

  const onVisibility = () => {
    if (visible() && now() - lastCheckAt > 30_000 && limitRulesOn(prefs.alerts())) void check().then(schedule);
    else schedule();
  };

  const onPrefs = () => {
    if (!limitRulesOn(prefs.alerts())) {
      schedule();
      return;
    }
    // A rule just switched on (or a pause ended early): judge the snapshot we have.
    const cached = deps.cachedLimits();
    if (cached && visible()) evaluate(cached);
    schedule();
  };

  // ---- after each turn ----

  const summaryScopeMatches = (session: SessionProjection, alertPrefs: UsageAlertPrefs): boolean => {
    if (session.parentId) return false;
    return alertPrefs.turnScope === "all" || deps.visibleSessionId() === session.id;
  };

  const afterTurnLimits = async (session: SessionProjection, refresh: boolean): Promise<UsageLimitsResponse | null> => {
    let response = await deps.loadLimits().catch(() => deps.cachedLimits());
    if (!response || !refresh) return response;
    const at = now();
    const stale = currentLimitSources(session, response.providers).filter((id) => {
      const provider = response!.providers.find((entry) => entry.providerId === id);
      const fetchedAt = Math.max(provider?.fetchedAt ?? 0, lastRefreshAt.get(id) ?? 0);
      return at - fetchedAt >= AFTER_TURN_REFRESH_MIN_AGE_MS;
    });
    for (const id of stale) lastRefreshAt.set(id, at);
    const refreshed = await Promise.all(stale.map((id) => deps.refreshLimitSource(id).catch(() => null)));
    for (const next of refreshed) if (next) response = next;
    return response;
  };

  const onTurnStopped = async (event: SessionEvent) => {
    const data = event.data as { turnId?: string; reason?: string };
    const key = `${event.sessionId}:${data.turnId ?? event.id}`;
    if (seenStops.has(key)) return;
    seenStops.add(key);
    if (seenStops.size > MAX_TRACKED_TURNS) seenStops.delete(seenStops.values().next().value!);
    const pending = turnUsage.get(event.sessionId) ?? emptyTurnUsage();
    turnUsage.delete(event.sessionId);
    if (now() - event.time > LIVE_EVENT_MAX_AGE_MS) return;

    const alertPrefs = prefs.alerts();
    const session = deps.sessions.get(event.sessionId);
    if (!session || !alertPrefs.enabled || alertsPaused(alertPrefs, now())) return;
    if (alertPrefs.cache && !session.parentId) watchCache(session);
    if (data.reason === "error" && !pending.reported) return;
    const wantSummary = alertPrefs.turn && summaryScopeMatches(session, alertPrefs) && visible();
    if (!wantSummary) {
      // Many agents finishing at once share one spaced re-read of the snapshot.
      if (limitRulesOn(alertPrefs) && now() - lastCheckAt >= AFTER_TURN_CHECK_SPACING_MS) void check().then(schedule);
      return;
    }

    const previous = lastResponse;
    const response = await afterTurnLimits(session, wantSummary && alertPrefs.turnParts.includes("limits"));
    if (disposed) return;
    const providers = response ? attributableLimits(response) : [];
    const before = remainingByWindow(response ? comparable(previous, response) : []);
    if (response && visible() && limitRulesOn(prefs.alerts()) && providers.length) evaluate(response);
    if (response && providers.length) lastResponse = response;
    if (!wantSummary) return;
    const usage = usageFromEvents(deps.sessions.events(session.id), data.turnId) ?? pending;
    const summary = turnSummary({
      usage,
      session,
      named: alertPrefs.turnScope === "all" && deps.visibleSessionId() !== session.id,
      providers,
      before,
      prefs: alertPrefs,
    });
    if (!summary) return;
    deps.notifications.show({
      id: alertPrefs.turnScope === "all" ? `turn:${session.id}` : "turn",
      kind: "info",
      title: summary.title,
      ...(summary.body ? { body: summary.body } : {}),
      duration: ALERT_DURATION_MS[alertPrefs.turnDuration],
      data: { "usage-alert": "summary" },
    });
  };

  // ---- prompt cache ----

  const unwatchCache = (sessionId: string) => {
    const watch = cacheWatches.get(sessionId);
    if (watch) clearTimeout(watch.timer);
    cacheWatches.delete(sessionId);
  };

  function watchCache(session: SessionProjection) {
    unwatchCache(session.id);
    const health = sessionCacheHealth(collectSessionObservations(session, deps.sessions.events(session.id)));
    const leadMs = prefs.alerts().cacheLeadMinutes * 60_000;
    const at = cacheAlertAt(health, leadMs, now());
    if (!health || at === null) return;
    if (cacheWatches.size >= MAX_CACHE_WATCHES) {
      const oldest = cacheWatches.keys().next().value;
      if (oldest) unwatchCache(oldest);
    }
    const timer = setTimeout(() => {
      cacheWatches.delete(session.id);
      const alertPrefs = prefs.alerts();
      const current = deps.sessions.get(session.id);
      if (disposed || !alertPrefs.enabled || !alertPrefs.cache || alertsPaused(alertPrefs, now()) || !visible()) return;
      if (!current || current.status === "working") return;
      const fresh = sessionCacheHealth(collectSessionObservations(current, deps.sessions.events(current.id)));
      // A newer response restarted the cache: its own watch covers it.
      if (!fresh || fresh.lastActivityAt !== health.lastActivityAt || fresh.ttlMs === null) return;
      if (now() >= fresh.lastActivityAt + fresh.ttlMs) return;
      const notice = cacheAlert(fresh, current.title, now());
      const onScreen = deps.visibleSessionId() === current.id;
      deps.notifications.show({
        id: `cache:${current.id}`,
        kind: "hint",
        title: notice.title,
        body: notice.body,
        ...(onScreen ? {} : { actions: [{ label: tr("usage.notiOpenChat"), run: () => deps.openSession(current.id) }] }),
        data: { "usage-alert": "cache" },
      });
    }, Math.max(0, at - now()));
    cacheWatches.set(session.id, { timer, lastActivityAt: health.lastActivityAt });
  }

  const onEvent = (event: SessionEvent) => {
    if (event.type === "usage/recorded") {
      const data = event.data as unknown as UsageRecordedData;
      if (data.tokens) turnUsage.set(event.sessionId, addTurnUsage(turnUsage.get(event.sessionId) ?? emptyTurnUsage(), data.tokens as TokenUsage, data.cost));
      return;
    }
    if (event.type === "turn/started") {
      turnUsage.delete(event.sessionId);
      unwatchCache(event.sessionId);
      deps.notifications.dismiss(`cache:${event.sessionId}`);
      return;
    }
    if (event.type === "turn/stopped") void onTurnStopped(event).catch(() => undefined);
  };

  // ---- previews ----

  const preview = (rule: UsageAlertPreviewRule) => {
    const alertPrefs = prefs.alerts();
    const source = (lastResponse ? attributableLimits(lastResponse) : []).find((provider) => provider.windows.some((window) => window.limit > 0));
    const window = source?.windows.find((entry) => entry.limit > 0);
    const sourceName = source ? limitSourceName(source) : "Claude";
    const limit = source && window ? limitName(source, window) : "Claude 5-hour";
    const samples: Record<UsageAlertPreviewRule, Omit<UsageAlert, "id" | "severity">> = {
      pace: { rule: "pace", kind: "warning", title: tr("usage.notiRunningFastTitle", { name: limit }), body: tr("usage.notiSamplePaceBody") },
      low: { rule: "low", kind: "warning", title: tr("usage.notiLowTitle", { name: limit, percent: "10%" }), body: tr("usage.notiSampleLowBody") },
      exhausted: { rule: "exhausted", kind: "error", title: tr(/\blimit$/i.test(limit) ? "usage.notiReachedTitle" : "usage.notiLimitReachedTitle", { name: limit }), body: tr("usage.notiSampleExhaustedBody") },
      restored: { rule: "restored", kind: "success", title: tr("usage.notiRestoredTitle", { name: limit }), body: tr("usage.notiSampleRestoredBody") },
      summary: { rule: "summary", kind: "info", title: tr("usage.notiSampleSummaryTitle", { cost: fmtCost(0.06) }), body: tr("usage.notiSampleSummaryBody", { limit }) },
      cache: { rule: "summary", kind: "hint", title: tr("usage.notiCacheTitle", { duration: tr("usage.alMinutes", { minutes: alertPrefs.cacheLeadMinutes }) }), body: tr("usage.notiCacheBodyNoChat", { tokens: "120k" }) },
      source: { rule: "source", kind: "warning", title: tr("usage.notiSignInTitle", { name: sourceName }), body: tr("usage.notiSignInBody") },
    };
    const sample = samples[rule];
    if (rule === "summary" || rule === "cache") {
      deps.notifications.show({
        id: `preview:${rule}`,
        kind: sample.kind,
        title: sample.title,
        body: sample.body,
        ...(rule === "summary" ? { duration: ALERT_DURATION_MS[alertPrefs.turnDuration] } : {}),
        data: { "usage-alert": rule, "usage-alert-preview": "true" },
      });
      return;
    }
    showAlert({ ...sample, id: `preview:${rule}`, severity: 0 }, alertPrefs, true);
  };

  const offEvents = deps.sessions.subscribeEvents(onEvent);
  const offPrefs = prefs.subscribe(onPrefs);
  const offVisibility = visibility?.subscribe(onVisibility) ?? (() => undefined);
  if (limitRulesOn(prefs.alerts())) void check().then(schedule);

  return {
    preview,
    check: () => check().then(schedule),
    dispose() {
      disposed = true;
      offEvents();
      offPrefs();
      offVisibility();
      if (pollTimer) clearTimeout(pollTimer);
      for (const id of [...cacheWatches.keys()]) unwatchCache(id);
    },
  };
}

// ---- the tab's controller ----

let current: UsageAlertsController | null = null;
const currentListeners = new Set<() => void>();

/** Starts the tab's usage notifications; disposing it clears the module handle too. */
export function startUsageAlerts(deps: UsageAlertsDeps): () => void {
  current?.dispose();
  const controller = createUsageAlerts(deps);
  current = controller;
  for (const listener of currentListeners) listener();
  return () => {
    controller.dispose();
    if (current === controller) {
      current = null;
      for (const listener of currentListeners) listener();
    }
  };
}

/** The running controller, for the settings page's previews; null on hosts without notifications. */
export function usageAlertsController(): UsageAlertsController | null {
  return current;
}

export function subscribeUsageAlertsController(listener: () => void): () => void {
  currentListeners.add(listener);
  return () => currentListeners.delete(listener);
}
