// HTTP face of the preview plugin (PLAN M3). Fixed protocol:
//   POST /api/preview/start {projectId, command?, port?} -> {url, port}
//   GET  /api/preview?projectId= -> {url, status: "off"|"starting"|"running"}
//   POST /api/preview/stop {projectId} -> {ok:true}
// No proxy — the web UI iframes the URL directly.
import type { ProjectService } from "@polyth/contracts";
import type { PreviewService } from "@polyth/preview";
import type { RouteHandler } from "../http.ts";

export function previewRoutes(deps: {
  projects: ProjectService;
  preview: PreviewService;
}): RouteHandler {
  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/preview")) return false;
    const q = (k: string) => url.searchParams.get(k);

    if (path === "/api/preview" && method === "GET") {
      const projectId = q("projectId") ?? "";
      if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
      json(200, deps.preview.get(projectId));
      return true;
    }
    if (method !== "POST") return false;
    const b = await body();
    const projectId = String(b.projectId ?? "");
    if (!projectId) throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    const project = await deps.projects.get(projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });

    if (path === "/api/preview/start") {
      json(200, await deps.preview.start(projectId, {
        cwd: project.path,
        ...(b.command ? { command: String(b.command) } : {}),
        ...(b.port ? { port: Number(b.port) } : {}),
      }));
      return true;
    }
    if (path === "/api/preview/stop") {
      await deps.preview.stop(projectId);
      json(200, { ok: true });
      return true;
    }
    return false;
  };
}
