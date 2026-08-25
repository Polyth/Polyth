import type { RouteHandler } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { FusionService } from "./index.ts";

export function fusionRoutes(fusion: FusionService): RouteHandler {
  return async ({ path, method, body, json }) => {
    let match = path.match(/^\/api\/sessions\/([^/]+)\/fuse$/);
    if (match && method === "POST") {
      const input = await body();
      const models = Array.isArray(input.models) ? input.models.map(String) : [];
      const { id } = await fusion.start(match[1]!, {
        text: String(input.text ?? ""),
        models,
      });
      json(200, { fusionId: id });
      return true;
    }
    match = path.match(/^\/api\/fusions\/([^/]+)$/);
    if (match && method === "GET") {
      const state = fusion.get(match[1]!);
      if (!state) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, fusion.snapshot(state));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= fusionRoutes(host.services.require(
        serverServiceKey<FusionService>("fusion"),
      ));
    },
  };
}
