import type { RouteHandler } from "@polyth/contracts";
import type { LocalModelManager } from "./localModels.ts";

const statusOf = (code?: string): number => {
  switch (code) {
    case "local_model_missing": return 404;
    case "local_model_downloading": return 409;
    case "local_model_failed": return 500;
    case "network_error": return 502;
    case "session_expired": return 409;
    default: return 500;
  }
};

export function localModelRoutes(models: LocalModelManager): RouteHandler {
  return async ({ path, method, json }) => {
    try {
      if (path === "/api/dictation/models" && method === "GET") {
        json(200, { models: await models.list() });
        return true;
      }
      let match = path.match(/^\/api\/dictation\/models\/([^/]+)$/);
      if (match && method === "GET") {
        json(200, await models.status(decodeURIComponent(match[1]!)));
        return true;
      }
      if (match && method === "DELETE") {
        await models.remove(decodeURIComponent(match[1]!));
        json(200, { ok: true });
        return true;
      }
      match = path.match(/^\/api\/dictation\/models\/([^/]+)\/download$/);
      if (match && method === "POST") {
        const id = decodeURIComponent(match[1]!);
        const current = await models.status(id);
        if (current.state === "installed") {
          json(200, current);
          return true;
        }
        if (current.state !== "downloading") {
          // The request deliberately does not await a ~475 MB installation.
          // Progress/error state is observable through GET and retry is the same
          // explicit POST; nothing downloads merely because the package starts.
          void models.download(id).catch(() => {});
        }
        json(202, await models.status(id));
        return true;
      }
      return false;
    } catch (error) {
      const failure = error as Error & { code?: string };
      json(statusOf(failure.code), {
        error: failure.code ?? "local_model_failed",
        message: failure.message,
      });
      return true;
    }
  };
}
