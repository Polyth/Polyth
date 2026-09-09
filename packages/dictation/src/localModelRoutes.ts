import type { RouteHandler } from "@polyth/contracts";
import type { LocalModelManager } from "./localModels.ts";
import type { LocalRuntimeManager } from "./localRuntime.ts";

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

export function localModelRoutes(models: LocalModelManager, runtime?: LocalRuntimeManager): RouteHandler {
  const withRuntime = async <T extends object>(value: T): Promise<T & { runtime?: Awaited<ReturnType<LocalRuntimeManager["status"]>> }> => ({
    ...value,
    ...(runtime ? { runtime: await runtime.status() } : {}),
  });

  return async ({ path, method, json }) => {
    try {
      if (path === "/api/dictation/models" && method === "GET") {
        json(200, await withRuntime({ models: await models.list() }));
        return true;
      }
      let match = path.match(/^\/api\/dictation\/models\/([^/]+)$/);
      if (match && method === "GET") {
        json(200, await withRuntime(await models.status(decodeURIComponent(match[1]!))));
        return true;
      }
      if (match && method === "DELETE") {
        // Runtime is shared by future local models, so deleting one model does
        // not discard it. `/api/dictation/runtime` owns explicit runtime repair/removal.
        await models.remove(decodeURIComponent(match[1]!));
        json(200, { ok: true });
        return true;
      }
      match = path.match(/^\/api\/dictation\/models\/([^/]+)\/download$/);
      if (match && method === "POST") {
        const id = decodeURIComponent(match[1]!);
        const current = await models.status(id);
        const runtimeStatus = runtime ? await runtime.status() : null;
        const runtimeReady = runtimeStatus === null || runtimeStatus.state === "installed";
        if (current.state === "installed" && runtimeReady) {
          json(200, await withRuntime(current));
          return true;
        }
        if (current.state !== "installed" && current.state !== "downloading") {
          void models.download(id).catch(() => {});
        }
        if (runtime && runtimeStatus?.state !== "installed" && runtimeStatus?.state !== "downloading" && runtimeStatus?.state !== "unsupported") {
          void runtime.download().catch(() => {});
        }
        json(202, await withRuntime(await models.status(id)));
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
