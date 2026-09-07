// Composer prompt history: a scoped read of durable composer submissions.
import type { PromptHistoryScope, RouteHandler } from "@polyth/contracts";
import {
  PROMPT_HISTORY_DEFAULT_LIMIT,
  PROMPT_HISTORY_MAX_LIMIT,
  PROMPT_HISTORY_MIN_LIMIT,
} from "@polyth/contracts";
import type { Store } from "@polyth/session";
import type { SpaceServicesFor } from "../spaceScope.ts";

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

function parseScope(raw: string): PromptHistoryScope {
  if (raw === "session") return "session";
  if (raw === "space") return "space";
  throw invalid("scope must be session or space");
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === "") return PROMPT_HISTORY_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) {
    throw invalid(`limit must be an integer from ${PROMPT_HISTORY_MIN_LIMIT} to ${PROMPT_HISTORY_MAX_LIMIT}`);
  }
  const n = Number(raw);
  if (n < PROMPT_HISTORY_MIN_LIMIT || n > PROMPT_HISTORY_MAX_LIMIT) {
    throw invalid(`limit must be an integer from ${PROMPT_HISTORY_MIN_LIMIT} to ${PROMPT_HISTORY_MAX_LIMIT}`);
  }
  return n;
}

export function promptHistoryRoutes(deps: {
  spaces: SpaceServicesFor;
  store: Store;
}): RouteHandler {
  return async (rc) => {
    if (rc.path !== "/api/prompt-history" || rc.method !== "GET") return false;
    const scope = parseScope(rc.url.searchParams.get("scope") ?? "session");
    const limit = parseLimit(rc.url.searchParams.get("limit"));
    const sessionId = rc.url.searchParams.get("sessionId") ?? undefined;
    if (scope === "session") {
      if (!sessionId) throw invalid("sessionId is required when scope is session");
      // Ownership check: a foreign id answers not-found, never an empty list
      // that would distinguish "exists elsewhere" from "unknown".
      await deps.spaces(rc.space).sessions.snapshot(sessionId);
    }
    const entries = await deps.store.listPromptHistory({
      spaceId: rc.space.spaceId,
      ...(scope === "session" ? { sessionId } : {}),
      limit,
    });
    rc.json(200, { entries });
    return true;
  };
}
