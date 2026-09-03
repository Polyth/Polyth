import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteHandler } from "@polyth/contracts";
import {
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

export function usageRoutes(usage: UsageService): RouteHandler {
  return async ({ path, method, json, body }) => {
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
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // WP12: quota telemetry. Built-in adapters discover the same OpenCode,
  // Claude Code, and polyth-managed credentials as polyth. The
  // browser only receives sanitized snapshots. The fake and hand-written HTTP
  // adapter paths remain available for development and private providers.
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
  const routes = usageRoutes(usage);
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
