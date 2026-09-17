import { requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import type { RouteHandler } from "../http.ts";
import type { PackageRegistry } from "../packages.ts";

export function packageRoutes(registry: PackageRegistry): RouteHandler {
  return async (rc) => {
    if (rc.path === "/api/packages" && rc.method === "GET") {
      rc.json(200, { packages: registry.list() });
      return true;
    }

    const match = rc.path.match(/^\/api\/packages\/([^/]+)$/);
    if (match && rc.method === "PATCH") {
      requireInstanceOwnerAuthority(rc, "package enablement changes require the instance owner");
      const body = await rc.body();
      if (typeof body.enabled !== "boolean") {
        throw Object.assign(new Error("enabled must be a boolean"), {
          code: "invalid-input",
          field: "enabled",
        });
      }
      rc.json(200, await registry.setEnabled(match[1]!, body.enabled));
      return true;
    }

    return false;
  };
}
