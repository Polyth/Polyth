// HTTP face of the fusion plugin (PLAN §12/M3, wire protocol fixed).
import type { FusionService } from "@polyth/fusion";
import type { RouteHandler } from "../http.ts";

export function fusionRoutes(fusion: FusionService): RouteHandler {
  return async ({ path, method, body, json }) => {
    let m = path.match(/^\/api\/sessions\/([^/]+)\/fuse$/);
    if (m && method === "POST") {
      const b = await body();
      const models = Array.isArray(b.models) ? b.models.map((x) => String(x)) : [];
      const { id } = await fusion.start(m[1]!, { text: String(b.text ?? ""), models });
      json(200, { fusionId: id });
      return true;
    }

    m = path.match(/^\/api\/fusions\/([^/]+)$/);
    if (m && method === "GET") {
      const state = fusion.get(m[1]!);
      if (!state) { json(404, { error: "not-found" }); return true; }
      json(200, fusion.snapshot(state));
      return true;
    }

    return false;
  };
}
