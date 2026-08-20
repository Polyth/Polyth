// HTTP face of the quota service (WP12). Read-only telemetry: snapshots carry
// last-good data with stale/error state; pace is computed server-side from the
// sample history. Nothing here ever reaches a session event log.
import type { UsageService } from "@polyth/usage";
import type { RouteHandler } from "../http.ts";

export function usageRoutes(usage: UsageService): RouteHandler {
  return async ({ path, method, json, body }) => {
    if (path === "/api/usage/quotas" && method === "GET") {
      const snapshots = usage.snapshots();
      json(200, snapshots.map((s) => ({ ...s, pace: usage.pace(s.providerId) })));
      return true;
    }
    if (path === "/api/usage/quotas/refresh" && method === "POST") {
      const b = await body();
      const providerId = String(b.providerId ?? "");
      const snapshot = await usage.refresh(providerId);
      json(200, { ...snapshot, pace: usage.pace(providerId) });
      return true;
    }
    return false;
  };
}
