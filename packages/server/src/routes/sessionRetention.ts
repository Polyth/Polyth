import { sessionRetentionSummary } from "@polyth/session";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";

export function sessionRetentionRoutes(spaces: SpaceServicesFor): RouteHandler {
  return async ({ path, method, url, body, json, space }) => {
    if (path !== "/api/session-retention") return false;
    if (method !== "GET" && method !== "POST") return false;
    // Retention sweeps only the caller's own Space — a bulk archive must never
    // reach across tenants.
    const { sessions } = spaces(space);
    const requestedDays = method === "GET"
      ? Number(url.searchParams.get("days") ?? 30)
      : Number((await body()).days ?? 30);
    const summary = sessionRetentionSummary(await sessions.list(), requestedDays);

    if (method === "GET") {
      json(200, {
        days: summary.days,
        cutoff: summary.cutoff,
        eligibleCount: summary.eligible.length,
      });
      return true;
    }
    const succeeded: string[] = [];
    const failed: Array<{ id: string; code: string }> = [];
    for (const session of summary.eligible) {
      try {
        await sessions.archive(session.id);
        succeeded.push(session.id);
      } catch (error) {
        failed.push({
          id: session.id,
          code: (error as { code?: string }).code ?? "internal",
        });
      }
    }
    json(200, { eligibleCount: summary.eligible.length, succeeded, failed });
    return true;
  };
}
