import type { RouteHandler } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { buildProviderUsageOverview, type UsageService } from "./index.ts";

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
  let routes: RouteHandler | null = null;
  let usage: UsageService | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      usage = host.services.require(serverServiceKey<UsageService>("usage"));
      routes ??= usageRoutes(usage);
      usage.start();
    },
    onDisable() {
      usage?.stop();
    },
  };
}
