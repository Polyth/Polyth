import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, RouteHandler, SpaceContext } from "@polyth/contracts";
import {
  atomicWriteSync,
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  buildProviderUsageOverview,
  createFakeQuotaProvider,
  createHttpQuotaProvider,
  createUsageService,
  discoverQuotaProviders,
  parseQuotaProviderSpecs,
  type UsageService,
} from "./index.ts";

interface UsagePreferencesEnvelope {
  revision: number;
  settings: JsonObject;
}

const MAX_USAGE_PREFS_BYTES = 128 * 1024;

const preferenceFile = (host: ServerPackageHost, space: SpaceContext): string =>
  join(host.spaceStorage(space).packageDir("usage"), "preferences.json");

const readPreferences = (host: ServerPackageHost, space: SpaceContext): UsagePreferencesEnvelope => {
  try {
    const parsed = JSON.parse(readFileSync(preferenceFile(host, space), "utf8")) as Partial<UsagePreferencesEnvelope>;
    return {
      revision: typeof parsed.revision === "number" && Number.isInteger(parsed.revision) && parsed.revision > 0
        ? parsed.revision
        : 0,
      settings: parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
        ? parsed.settings
        : {},
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[usage] preferences ignored:", cause instanceof Error ? cause.message : cause);
    }
    return { revision: 0, settings: {} };
  }
};

const writePreferences = (
  host: ServerPackageHost,
  space: SpaceContext,
  raw: unknown,
): UsagePreferencesEnvelope => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("usage preferences must be an object"), { code: "invalid-input" });
  }
  const settings = raw as JsonObject;
  const serializedSettings = JSON.stringify(settings);
  if (serializedSettings.length > MAX_USAGE_PREFS_BYTES) {
    throw Object.assign(new Error("usage preferences are too large"), { code: "invalid-input" });
  }
  const current = readPreferences(host, space);
  const next: UsagePreferencesEnvelope = { revision: current.revision + 1, settings };
  atomicWriteSync(preferenceFile(host, space), JSON.stringify(next));
  return next;
};

export function usageRoutes(usage: UsageService, host?: ServerPackageHost): RouteHandler {
  return async ({ path, method, json, body, space }) => {
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
    if (analytics && path === "/api/usage/analytics" && method === "GET") {
      try {
        json(200, await analytics.query(space, parseUsageAnalyticsQuery(url.searchParams)));
      } catch (cause) {
        const invalid = (cause as { code?: string }).code === "invalid-input";
        json(invalid ? 400 : 500, {
          error: invalid ? "invalid-input" : "usage-analytics-failed",
          message: cause instanceof Error ? cause.message : "Could not build usage analytics",
        });
      }
      return true;
    }
    if (host && path === "/api/usage/preferences" && method === "GET") {
      json(200, readPreferences(host, space));
      return true;
    }
    if (host && path === "/api/usage/preferences" && (method === "PUT" || method === "POST")) {
      const input = await body();
      try {
        json(200, writePreferences(host, space, input.settings));
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        json(code === "invalid-input" ? 400 : 500, {
          error: cause instanceof Error ? cause.message : "Could not save usage preferences",
        });
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
