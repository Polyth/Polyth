import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessRegistry, Project, QuotaSnapshot, RouteHandler, SessionProjection, SpaceContext } from "@polyth/contracts";
import {
  adoptLegacyPackageData,
  atomicWriteSync,
  localOnlyRemoteAccess,
  packageDataDir,
  SERVER_MODEL_FAVORITES,
  SERVER_MODEL_ROUTING,
  SERVER_RUNTIME_CATALOG,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createUsageAnalyticsService,
  createUsageLimitService,
  createFakeLimitProvider,
  createHttpQuotaProvider,
  discoverQuotaProviders,
  isValidTimeZone,
  parseQuotaProviderSpecs,
  type UsageAnalyticsService,
  type UsageLimitService,
  type UsageBucket,
  type UsageRangePreset,
  type UsageStatsQuery,
} from "./index.ts";
import { createHarnessAccountLimits } from "./harnessAccounts.ts";
import { createAlibabaCodingPlanSource, type AlibabaCodingPlanSource } from "./alibabaCodingPlan.ts";
import { resolveQuotaRuntime } from "./opencodeAuth.ts";
import { sessionCacheFacts } from "./analytics/sessionCache.ts";
import { createKeepWarmController, KEEP_ALIVE_PROMPT, KEEP_WARM_MAX_MINUTES, type KeepWarmController } from "./keepWarm.ts";
import { buildModelRouting, DEFAULT_ROUTING_WINDOW_DAYS, ROUTING_CATALOG_MAX_AGE_MS } from "./routing.ts";
import { parseAlertLedger, type UsageAlertLedger } from "./alertLedger.ts";
import { mergePersonAlertLedgers, readPersonAlertLedgers, type AlertLedgerSlot } from "./alertLedgerStore.ts";

const stringList = (value: unknown, max = 128): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw Object.assign(new Error("usage filters must be arrays"), { code: "invalid-input" });
  const list = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 256))
    .slice(0, max);
  return [...new Set(list)];
};

const rangeValue = (value: unknown): UsageRangePreset => {
  if (value === "7d" || value === "30d" || value === "90d" || value === "all" || value === "custom") return value;
  throw Object.assign(new Error("unsupported usage range"), { code: "invalid-input" });
};

const bucketValue = (value: unknown): UsageBucket | undefined => {
  if (value === undefined) return undefined;
  if (value === "hour" || value === "day" || value === "week" || value === "month") return value;
  throw Object.assign(new Error("unsupported usage bucket"), { code: "invalid-input" });
};

const parseStatsQuery = (value: unknown): UsageStatsQuery => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("usage query body must be an object"), { code: "invalid-input" });
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "range", "from", "to", "timezone", "projectIds", "sessionIds",
    "bucket", "detailLimit", "detailSort",
  ]);
  const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw Object.assign(new Error(`unsupported usage query field: ${unsupported[0]}`), { code: "invalid-input" });
  }
  const timezone = typeof input.timezone === "string" ? input.timezone.trim() : "";
  if (!isValidTimeZone(timezone)) {
    throw Object.assign(new Error("timezone must be an IANA timezone"), { code: "invalid-input" });
  }

  const range = rangeValue(input.range);
  const from = typeof input.from === "number" && Number.isFinite(input.from) ? input.from : undefined;
  const to = typeof input.to === "number" && Number.isFinite(input.to) ? input.to : undefined;
  if (range === "custom" && (from === undefined || to === undefined)) {
    throw Object.assign(new Error("custom range requires from and to"), { code: "invalid-input" });
  }
  if (range === "custom" && from !== undefined && to !== undefined && (to <= from || to - from > 20 * 366 * 86_400_000)) {
    throw Object.assign(new Error("custom range is outside the supported history window"), { code: "invalid-input" });
  }

  const detailLimit = typeof input.detailLimit === "number" && Number.isFinite(input.detailLimit)
    ? Math.max(1, Math.min(200, Math.round(input.detailLimit)))
    : undefined;

  return {
    range,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    timezone,
    ...(stringList(input.projectIds) !== undefined ? { projectIds: stringList(input.projectIds) } : {}),
    ...(stringList(input.sessionIds) !== undefined ? { sessionIds: stringList(input.sessionIds) } : {}),
    ...(bucketValue(input.bucket) ? { bucket: bucketValue(input.bucket) } : {}),
    ...(detailLimit !== undefined ? { detailLimit } : {}),
    ...(input.detailSort === "activity" || input.detailSort === "tokens" || input.detailSort === "cost" || input.detailSort === "turns"
      ? { detailSort: input.detailSort }
      : {}),
  };
};

/**
 * The identity the web client keys its report cache on. A fresh id per process
 * made every restart a cold open; the id now belongs to the deployment's
 * storage root, so a cached report survives a restart and is merely
 * revalidated. A different data directory still yields a different id.
 */
export function usageServerInstanceId(storageDir: string | undefined): string {
  if (!storageDir) return randomUUID();
  const file = join(storageDir, "usage-instance-v1.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown };
    if (typeof parsed.id === "string" && /^[0-9a-f-]{36}$/i.test(parsed.id)) return parsed.id;
  } catch {
    // Missing or unreadable: mint one below.
  }
  const id = randomUUID();
  try {
    mkdirSync(storageDir, { recursive: true });
    atomicWriteSync(file, JSON.stringify({ id }));
  } catch {
    // An unwritable root degrades to a per-process id, exactly as before.
  }
  return id;
}

const scopedProjects = async (
  host: ServerPackageHost,
  space: SpaceContext,
  requested: string[] | undefined,
): Promise<Project[]> => {
  const projects = await host.forSpace(space).projects.list();
  if (!requested?.length) return projects;
  const known = new Set(projects.map((project) => project.id));
  if (requested.some((id) => !known.has(id))) {
    throw Object.assign(new Error("one or more projects are unavailable"), { code: "invalid-input" });
  }
  return projects;
};

export interface KeepWarmRoutes {
  controller: KeepWarmController;
  /** Who asked: keep-alives are sent as that person, within their access. */
  owners: Map<string, SpaceContext>;
}

/** The session as the requester may see it; null hides a foreign one. */
const visibleSession = async (host: ServerPackageHost, space: SpaceContext, sessionId: string) => {
  if (!sessionId) return null;
  try {
    return await host.forSpace(space).sessions.snapshot(sessionId);
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "not-found") return null;
    throw error;
  }
};

export function usageRoutes(
  analytics: UsageAnalyticsService,
  host: ServerPackageHost,
  limits?: UsageLimitService,
  codingPlan?: AlibabaCodingPlanSource,
  keepWarm?: KeepWarmRoutes,
): RouteHandler {
  return async (request) => {
    const { path, method, json, body, space } = request;
    // The Alibaba Coding Plan estimate is computed from this Space's own
    // history, so it is the one limits source that differs per Space. It is
    // marked `scope: "space"` and every limits response names the server and
    // Space it answers for: the browser never restores or merges a per-Space
    // estimate across identities.
    const identity = { serverInstanceId: analytics.serverInstanceId, spaceId: space.spaceId };
    type CodingPlanResult =
      | { state: "unconfigured" }
      | { state: "unavailable" }
      | { state: "ok"; snapshot: QuotaSnapshot & { balances: []; pace: Record<string, never>; scope: "space" } };
    const codingPlanSnapshot = async (): Promise<CodingPlanResult> => {
      if (!codingPlan) return { state: "unconfigured" };
      try {
        if (!codingPlan.isConfigured()) return { state: "unconfigured" };
        return {
          state: "ok",
          snapshot: { ...(await codingPlan.snapshot(space)), balances: [], pace: {}, scope: "space" },
        };
      } catch {
        // A local estimate must not hide the other sources when analytics is unavailable.
        return { state: "unavailable" };
      }
    };

    if (path === "/api/usage/keep-warm" && keepWarm && (method === "GET" || method === "POST")) {
      const input = method === "POST" ? await body().catch(() => ({} as Record<string, unknown>)) : {};
      const raw = method === "GET" ? request.url.searchParams.get("sessionId") : input.sessionId;
      const sessionId = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
      const session = await visibleSession(host, space, sessionId);
      if (!session) {
        json(404, { error: "not-found", message: "session not found" });
        return true;
      }
      if (method === "GET") {
        json(200, keepWarm.controller.status(sessionId));
        return true;
      }
      const minutes = input.minutes;
      if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > KEEP_WARM_MAX_MINUTES) {
        json(400, { error: "invalid-input", message: `minutes must be 0–${KEEP_WARM_MAX_MINUTES}` });
        return true;
      }
      if (minutes === 0) {
        json(200, keepWarm.controller.cancel(sessionId));
        return true;
      }
      // Only a cache with a known lifetime can be kept warm on time.
      const facts = sessionCacheFacts(session, await host.forSpace(space).sessions.events(sessionId));
      if (!facts || facts.health.ttlMs === null) {
        json(409, { error: facts ? "unknown-ttl" : "no-cache", message: "this chat's prompt cache cannot be kept warm" });
        return true;
      }
      keepWarm.owners.set(sessionId, space);
      json(200, keepWarm.controller.start(sessionId, Date.now() + Math.round(minutes) * 60_000));
      void keepWarm.controller.tick();
      return true;
    }

    if (path === "/api/usage/identity" && method === "GET") {
      json(200, analytics.identity(space));
      return true;
    }

    if (path === "/api/usage/stats" && method === "POST") {
      try {
        const query = parseStatsQuery(await body());
        const projects = await scopedProjects(host, space, query.projectIds);
        json(200, await analytics.query(space, projects, query));
      } catch (error) {
        const invalid = error && typeof error === "object" && (error as { code?: unknown }).code === "invalid-input";
        json(invalid ? 400 : 500, {
          error: invalid ? "invalid-input" : "usage-unavailable",
          message: invalid && error instanceof Error ? error.message : "usage query unavailable",
        });
      }
      return true;
    }

    if (path === "/api/usage/limits" && method === "GET") {
      if (!limits) return false;
      const providers = limits.snapshots();
      const estimated = await codingPlanSnapshot();
      json(200, {
        ...identity,
        providers: estimated.state === "ok"
          ? [...providers.filter((provider) => provider.providerId !== estimated.snapshot.providerId), estimated.snapshot]
          : providers,
        fetchedAt: Date.now(),
      });
      return true;
    }

    // The requester's own alert ledger (alertLedgerStore.ts): what the limit
    // alerts already announced to this person, on any of their devices.
    if (path === "/api/usage/alerts/ledger" && (method === "GET" || method === "PUT")) {
      const dir = host.spaceStorage(space).packageDir("usage");
      try {
        if (method === "GET") {
          json(200, { ...identity, ...readPersonAlertLedgers(dir, space.userId) });
          return true;
        }
        const input = await body().catch(() => null);
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          json(400, { error: "invalid-input", message: "alert ledger body must be an object" });
          return true;
        }
        const incoming: Partial<Record<AlertLedgerSlot, UsageAlertLedger>> = {};
        if (input.host !== undefined) incoming.host = parseAlertLedger(input.host);
        // A per-Space ledger was judged for one server and Space; any other
        // copy is not this Space's and is left out.
        if (input.space !== undefined && input.serverInstanceId === identity.serverInstanceId && input.spaceId === identity.spaceId) {
          incoming.space = parseAlertLedger(input.space);
        }
        json(200, { ...identity, ...mergePersonAlertLedgers(dir, space.userId, incoming, Date.now()) });
      } catch {
        json(500, { error: "ledger-unavailable", message: "usage alert ledger unavailable" });
      }
      return true;
    }

    if (path === "/api/usage/limits/refresh" && method === "POST") {
      if (!limits) return false;
      const input = await body().catch(() => ({})) as { providerId?: unknown };
      const providerId = typeof input?.providerId === "string" ? input.providerId.trim() : "";
      try {
        if (codingPlan && providerId === codingPlan.id) {
          const estimated = await codingPlanSnapshot();
          // Not configured is an unknown source; a configured one whose
          // analytics read failed is unavailable, not missing.
          if (estimated.state === "unconfigured") throw Object.assign(new Error("unknown limits provider"), { code: "not-found" });
          if (estimated.state === "unavailable") throw new Error("Alibaba Coding Plan estimate unavailable");
          json(200, { ...identity, providers: [estimated.snapshot], fetchedAt: Date.now() });
        } else if (providerId) {
          json(200, { ...identity, providers: [await limits.refresh(providerId)], fetchedAt: Date.now() });
        } else {
          const providers = await limits.refreshAll();
          const estimated = await codingPlanSnapshot();
          json(200, {
            ...identity,
            providers: estimated.state === "ok"
              ? [...providers.filter((provider) => provider.providerId !== estimated.snapshot.providerId), estimated.snapshot]
              : providers,
            fetchedAt: Date.now(),
          });
        }
      } catch (error) {
        const missing = error && typeof error === "object" && (error as { code?: unknown }).code === "not-found";
        json(missing ? 404 : 500, {
          error: missing ? "not-found" : "limits-unavailable",
          message: missing ? "unknown limits provider" : "limits refresh unavailable",
        });
      }
      return true;
    }

    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const dataDir = packageDataDir(host);
  // The deployment identity and the limits files used to live in the shared
  // data root; adopt them so the instance id (and any tuned provider list)
  // survives the move unchanged.
  adoptLegacyPackageData(host, ["usage-instance-v1.json", "usage-limits-v1.json", "limits-providers.json"]);
  let accounts: { reconcile(): void } | undefined;
  const limits = createUsageLimitService({
    file: join(dataDir, "usage-limits-v1.json"),
    reconcile: () => accounts?.reconcile(),
  });
  if (process.env.POLYTH_FAKE_LIMITS === "1") limits.register(createFakeLimitProvider());
  try {
    const raw = readFileSync(join(dataDir, "limits-providers.json"), "utf8");
    for (const spec of parseQuotaProviderSpecs(JSON.parse(raw))) {
      limits.register(createHttpQuotaProvider(spec));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[usage] limits-providers.json ignored:", error instanceof Error ? error.message : error);
    }
  }
  for (const provider of discoverQuotaProviders()) limits.register(provider);
  const harnessAccounts = createHarnessAccountLimits({
    limits,
    // Harness packages register and remove accounts at runtime; the registry is
    // resolved on every reconcile and is simply absent when no harness runs.
    harnesses: () => host.services.get(serverServiceKey<HarnessRegistry>("harnesses"))?.providers() ?? [],
    reserved: new Set(limits.providerIds()),
  });

  const analytics = createUsageAnalyticsService({
    serverInstanceId: usageServerInstanceId(dataDir),
    source: {
      // One index per Space, read as server work so everyone's report comes
      // from the same complete materialization; `visibleSessions` narrows each
      // report to the chats its reader may open (Spaces §14.3).
      async projections(space, scope) {
        const sessions = host.forSpace(host.systemSpaceContext(space.spaceId)).sessions;
        if (scope?.sessionIds) {
          const rows = await Promise.all([...scope.sessionIds].map(async (id) => {
            try {
              return await sessions.snapshot(id);
            } catch (error) {
              if (error && typeof error === "object" && (error as { code?: unknown }).code === "not-found") return null;
              throw error;
            }
          }));
          return rows.filter((row): row is SessionProjection => row !== null);
        }
        return sessions.list(scope?.projectId);
      },
      events: (space, sessionId) => host.forSpace(host.systemSpaceContext(space.spaceId)).sessions.events(sessionId),
      async latestSeq(space, sessionId) {
        // Passive analytics must not materialize a provider runtime or dispatch
        // a queued turn merely to inspect the indexed event tail.
        const tail = await host.forSpace(host.systemSpaceContext(space.spaceId)).sessions
          .events(sessionId, 0, { limit: 1, prefetch: true });
        return tail.at(-1)?.seq ?? 0;
      },
      async visibleSessions(space) {
        if (space.userId.startsWith("system:")) return undefined;
        return new Set((await host.forSpace(space).sessions.list()).map((session) => session.id));
      },
    },
    storageDir: (space) => host.spaceStorage(space).packageDir("usage"),
    // Only an account needs the live name: its label is not derivable from its id.
    harnessLabel(harnessId) {
      const descriptor = host.services.get(serverServiceKey<HarnessRegistry>("harnesses"))?.get(harnessId)?.descriptor;
      const account = descriptor?.accountLabel?.trim();
      if (!descriptor || !account) return undefined;
      return descriptor.name.includes(account) ? descriptor.name : `${descriptor.name} · ${account}`;
    },
  });
  const codingPlan = createAlibabaCodingPlanSource({
    runtime: resolveQuotaRuntime(),
    observations: (space, from) => analytics.observations(space, from),
  });
  host.services.provide(serverServiceKey<UsageAnalyticsService>("usage-analytics"), analytics);
  host.services.provide(serverServiceKey<UsageLimitService>("usage-limits"), limits);
  host.services.provide(SERVER_MODEL_ROUTING, {
    async candidates(space, options = {}) {
      const now = Date.now();
      const windowDays = options.windowDays ?? DEFAULT_ROUTING_WINDOW_DAYS;
      const harnesses = host.services.get(serverServiceKey<HarnessRegistry>("harnesses"));
      const [observations, catalog] = await Promise.all([
        analytics.observations(space, now - windowDays * 86_400_000),
        // The catalog spawn validates against, never an old copy of it: a
        // harness that updated or retired models must show that here.
        host.services.get(SERVER_RUNTIME_CATALOG)?.models({ maxAgeMs: ROUTING_CATALOG_MAX_AGE_MS })
          .catch((error: unknown) => {
            console.warn("[usage] model catalog unavailable for delegation routing", error);
            return undefined;
          }),
      ]);
      return buildModelRouting({
        observations,
        // Cached snapshots only: a delegation decision must not wait on, or
        // spend, a provider quota request. The poller keeps them fresh.
        snapshots: limits.snapshots(),
        favorites: host.services.get(SERVER_MODEL_FAVORITES)?.favorites(space.userId) ?? [],
        ...(catalog ? { catalog } : {}),
        available: (harnessId) => Boolean(harnesses?.get(harnessId)),
        now,
        windowDays,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.harnessId ? { harnessId: options.harnessId } : {}),
        ...(options.pairs ? { pairs: options.pairs } : {}),
      });
    },
  });

  const keepWarmOwners = new Map<string, SpaceContext>();
  const keepWarm = createKeepWarmController({
    now: () => Date.now(),
    async facts(sessionId) {
      const projection = await host.store.projection(sessionId);
      return projection ? sessionCacheFacts(projection, await host.store.events(sessionId)) : null;
    },
    async ready(sessionId) {
      const owner = keepWarmOwners.get(sessionId);
      if (!owner) throw Object.assign(new Error("keep-warm owner missing"), { code: "not-found" });
      const sessions = host.forSpace(owner).sessions;
      const projection = await sessions.snapshot(sessionId);
      if (projection.status !== "idle") return false;
      return ((await sessions.queueList?.(sessionId)) ?? []).length === 0;
    },
    async send(sessionId) {
      const owner = keepWarmOwners.get(sessionId);
      if (!owner) throw Object.assign(new Error("keep-warm owner missing"), { code: "not-found" });
      await host.forSpace(owner).sessions.send(sessionId, {
        text: KEEP_ALIVE_PROMPT, keepAlive: true, hiddenUserMessage: true, delivery: "normal",
        memory: { read: "off", remember: "off" },
      });
    },
    onStop: (sessionId) => { keepWarmOwners.delete(sessionId); },
    onError: (error) => console.warn("[usage] keep-alive stopped", error instanceof Error ? error.message : error),
  });
  let keepWarmTimer: ReturnType<typeof setInterval> | undefined;

  return {
    remoteAccess: localOnlyRemoteAccess(["usage"]),
    routes: usageRoutes(analytics, host, limits, codingPlan, { controller: keepWarm, owners: keepWarmOwners }),
    onEnable() {
      accounts = harnessAccounts;
      limits.start();
      keepWarmTimer ??= setInterval(() => { void keepWarm.tick(); }, 5_000);
      keepWarmTimer.unref?.();
    },
    onDisable() {
      accounts = undefined;
      limits.stop();
      analytics.stop();
      if (keepWarmTimer) clearInterval(keepWarmTimer);
      keepWarmTimer = undefined;
      keepWarm.clear();
      keepWarmOwners.clear();
    },
  };
}
