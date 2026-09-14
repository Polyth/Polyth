import { archivedSessionRetentionSummary, sessionRetentionSummary } from "@polyth/session";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";

export function sessionRetentionRoutes(spaces: SpaceServicesFor): RouteHandler {
  return async (rc) => {
    const { path, method, url, body, json } = rc;
    if (path !== "/api/session-retention") return false;
    if (method !== "GET" && method !== "POST") return false;
    // Retention sweeps only the caller's own Space — bulk archive/purge must
    // never reach across tenants.
    const { sessions } = spaces(rc.space);
    const input = method === "POST" ? await body() : undefined;
    const target = method === "GET"
      ? url.searchParams.get("target") ?? "sessions"
      : input?.target === undefined ? "sessions" : String(input.target);
    if (target !== "sessions" && target !== "archives") {
      json(400, { error: "invalid-input", message: "target must be sessions or archives" });
      return true;
    }
    const requestedDays = method === "GET"
      ? Number(url.searchParams.get("days") ?? 30)
      : Number(input?.days ?? 30);
    const rows = await sessions.list();
    const summary = target === "archives"
      ? archivedSessionRetentionSummary(rows, requestedDays)
      : sessionRetentionSummary(rows, requestedDays);

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
    const allArchives = target === "archives" && input?.all === true;
    const eligible = allArchives
      ? rows.filter((session) => session.status === "archived")
      : summary.eligible;
    const action = target === "archives"
      ? "delete"
      : input?.action === undefined ? "archive" : String(input.action);
    if (action !== "archive" && action !== "delete") {
      json(400, { error: "invalid-input", message: "action must be archive or delete" });
      return true;
    }
    for (const session of eligible) {
      try {
        if (action === "delete") {
          if (!sessions.delete) throw Object.assign(new Error("session deletion unavailable"), { code: "unsupported" });
          await sessions.delete(session.id);
        } else {
          await sessions.archive(session.id);
        }
        succeeded.push(session.id);
      } catch (error) {
        failed.push({
          id: session.id,
          code: (error as { code?: string }).code ?? "internal",
        });
      }
    }
    json(200, { eligibleCount: eligible.length, succeeded, failed });
    return true;
  };
}
