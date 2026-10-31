import type { RouteHandler } from "@polyth/contracts";
import type { LocalRuntimeManager } from "./localRuntime.ts";

export function localRuntimeRoutes(runtime: LocalRuntimeManager): RouteHandler {
  return async ({ path, method, json }) => {
    if (path !== "/api/dictation/runtime") return false;
    try {
      if (method === "GET") {
        json(200, await runtime.status());
        return true;
      }
      if (method === "POST") {
        const status = await runtime.status();
        if (status.state === "unsupported") {
          json(503, status);
          return true;
        }
        if (status.state === "installed") {
          json(200, status);
          return true;
        }
        // Explicit user-triggered action. The request returns immediately and
        // settings poll the status route for progress; no runtime is downloaded
        // at boot or implicitly on the first microphone click.
        void runtime.download().catch(() => {});
        json(202, await runtime.status());
        return true;
      }
      if (method === "DELETE") {
        await runtime.remove();
        json(200, { ok: true });
        return true;
      }
      return false;
    } catch (error) {
      const failure = error as Error & { code?: string };
      json(failure.code === "network_error" ? 502 : 500, {
        error: failure.code ?? "local_model_failed",
        message: failure.message,
      });
      return true;
    }
  };
}
