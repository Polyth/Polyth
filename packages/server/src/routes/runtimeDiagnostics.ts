// Read-only view of why a project's OpenCode runtime is not usable. The
// composer asks for this the moment the model catalog comes back empty, so the
// user reads the actual reason ("OpenCode CLI was not found. Searched …")
// instead of being told to check something that is already running.
import type { RouteHandler } from "../http.ts";
import type { RuntimeDiagnostics } from "../runtimeDiagnostics.ts";

export function runtimeDiagnosticsRoutes(
  diagnostics: RuntimeDiagnostics,
): RouteHandler {
  return async ({ path, method, json }) => {
    if (path !== "/api/runtime/diagnostics" || method !== "GET") return false;
    const runtimes = diagnostics.list();
    json(200, { ok: runtimes.length === 0, runtimes });
    return true;
  };
}
