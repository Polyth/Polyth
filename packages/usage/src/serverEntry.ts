import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { collectUsageTelemetry } from "./telemetry.ts";
import {
  buildProviderUsageOverview,
  createFakeQuotaProvider,
  createHttpQuotaProvider,
  createUsageService,
  discoverQuotaProviders,
  parseQuotaProviderSpecs,
  type UsageService,
} from "./index.ts";

const MAX_TELEMETRY_RANGE_MS = 2 * 366 * 24 * 60 * 60_000;
const TELEMETRY_CACHE_MS = 15_000;

export function usageRoutes(usage: UsageService, host?: ServerPackageHost): RouteHandler {
  const telemetryCache = new Map<string, {
    expiresAt: number;
    value: Promise<Awaited<ReturnType<typeof collectUsageTelemetry>>>;
  }>();

  return async ({ path, method, url, json, body, space }) => {
    if (path === "/api/usage/quotas" && method === "GET") {
      const snapshots = usage.snapshots();
      const overview = new Map(
        buildProviderUsageOverview(snapshots).map((item) => [item.providerId, item]),
      );
      json(200, snapshots.map((snapshot) => ({
        ...snapshot,
        pace: usage.pace(snapshot.providerId),
        overview: overview.get(snapshot.providerId),
      })));
      return true;
    }
    if (path === "/api/usage/quotas/refresh" && method === "POST") {
      const input = await body();
      const providerId = String(input.providerId ?? "");
      const snapshot = await usage.refresh(providerId);
      json(200, {
        ...snapshot,
        pace: usage.pace(providerId),
        overview: buildProviderUsageOverview([snapshot])[0],
      });
      return true;
    }
    if (path === "/api/usage/telemetry" && method === "GET" && host) {
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > MAX_TELEMETRY_RANGE_MS) {
        json(400, {
          error: "invalid-input",
          message: "start/end must define a positive Usage range of at most two years",
        });
        return true;
      }
      const now = Date.now();
      const clippedEnd = Math.min(now, end);
      if (start >= clippedEnd) {
        json(400, { error: "invalid-input", message: "Usage range must include past time" });
        return true;
      }
      const key = `${space.spaceId}:${Math.round(start)}:${Math.round(clippedEnd)}`;
      for (const [cacheKey, entry] of telemetryCache) {
        if (entry.expiresAt <= now) telemetryCache.delete(cacheKey);
      }
      let cached = telemetryCache.get(key);
      if (!cached) {
        const scoped = host.forSpace(space);
        const value = scoped.projects.list().then((projects) => collectUsageTelemetry({
          store: host.store,
          spaceId: space.spaceId,
          projects,
          start,
          end: clippedEnd,
          now,
        }));
        cached = { expiresAt: now + TELEMETRY_CACHE_MS, value };
        telemetryCache.set(key, cached);
      }
      try {
        json(200, await cached.value);
      } catch (cause) {
        telemetryCache.delete(key);
        console.warn("[usage] telemetry aggregation failed:", cause instanceof Error ? cause.message : cause);
        json(500, { error: "telemetry-failed", message: "Could not aggregate Usage telemetry" });
      }
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // WP12: quota telemetry. Built-in adapters discover provider credentials
  // locally and expose only sanitized snapshots to the browser. The fake and
  // hand-written HTTP adapter paths remain available for development and
  // private providers.
  const usage = createUsageService({ file: join(host.storageDir, "quotas.json") });
  if (process.env.POLYTH_FAKE_QUOTAS === "1") usage.register(createFakeQuotaProvider());
  try {
    const specsRaw = readFileSync(join(host.storageDir, "quota-providers.json"), "utf8");
    for (const spec of parseQuotaProviderSpecs(JSON.parse(specsRaw))) {
      usage.register(createHttpQuotaProvider(spec));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[usage] quota-providers.json ignored:", e instanceof Error ? e.message : e);
    }
  }
  for (const provider of discoverQuotaProviders()) usage.register(provider);
  host.services.provide(serverServiceKey<UsageService>("usage"), usage);
  const routes = usageRoutes(usage, host);
  return {
    remoteAccess: localOnlyRemoteAccess(["usage"]),
    routes,
    onEnable() {
      usage.start();
    },
    onDisable() {
      usage.stop();
    },
  };
}
