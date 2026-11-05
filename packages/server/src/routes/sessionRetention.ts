import { archivedSessionRetentionSummary, sessionOwnsIsolatedCheckout, sessionRetentionSummary } from "@polyth/session";
import type { RouteHandler } from "../http.ts";
import type { SpaceServicesFor } from "../spaceScope.ts";

/** `releaseCheckouts` is the host's unscoped removal: only ever called with a
 *  session this person just archived through their Space-scoped service, which
 *  proves access to the tree. Without it isolated sessions are always skipped. */
export function sessionRetentionRoutes(
  spaces: SpaceServicesFor,
  releaseCheckouts?: (sessionId: string) => Promise<void>,
): RouteHandler {
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
    // Removing isolated work takes an explicit `false`; an older client asks nothing.
    const skipIsolated = !releaseCheckouts || (method === "GET"
      ? url.searchParams.get("skipIsolated") !== "false"
      : input?.skipIsolated !== false);
    const rows = await sessions.list();
    const summary = target === "archives"
      ? archivedSessionRetentionSummary(rows, requestedDays)
      : sessionRetentionSummary(rows, requestedDays, undefined, { skipIsolated });
    const expired = [...summary.eligible, ...summary.checkouts];

    if (method === "GET") {
      json(200, {
        days: summary.days,
        cutoff: summary.cutoff,
        eligibleCount: expired.length,
      });
      return true;
    }
    const succeeded: string[] = [];
    const failed: Array<{ id: string; code: string }> = [];
    const allArchives = target === "archives" && input?.all === true;
    const eligible = allArchives
      ? rows.filter((session) => session.status === "archived")
      : expired;
    const action = target === "archives"
      ? "delete"
      : input?.action === undefined ? "archive" : String(input.action);
    if (action !== "archive" && action !== "delete") {
      json(400, { error: "invalid-input", message: "action must be archive or delete" });
      return true;
    }
    // Every isolated session and everything above it: only those trees need a release.
    const holdingCheckouts = new Set<string>();
    if (!skipIsolated) {
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const row of rows.filter(sessionOwnsIsolatedCheckout)) {
        for (let current: typeof row | undefined = row; current && !holdingCheckouts.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
          holdingCheckouts.add(current.id);
        }
      }
    }
    for (const session of eligible) {
      try {
        // An archived session's history is the Archive section's to delete.
        const alreadyArchived = target === "sessions" && session.status === "archived";
        if (action === "delete" && !alreadyArchived) {
          if (!sessions.delete) throw Object.assign(new Error("session deletion unavailable"), { code: "unsupported" });
          await sessions.delete(session.id);
        } else {
          await sessions.archive(session.id);
          if (holdingCheckouts.has(session.id)) await releaseCheckouts?.(session.id);
        }
        succeeded.push(session.id);
      } catch (error) {
        const code = (error as { code?: string }).code ?? "internal";
        // Deleting a parent takes its tree with it, so a child later in the
        // list is already gone. That is the outcome this request asked for.
        if (code === "not-found") succeeded.push(session.id);
        else failed.push({ id: session.id, code });
      }
    }
    json(200, { eligibleCount: eligible.length, succeeded, failed });
    return true;
  };
}
