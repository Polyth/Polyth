// Proof-of-concept discovered server package: opts in via the
// `polyth.serverEntry` marker in package.json and is wired into the package
// lifecycle by discovery alone — no imports or registration in the server
// composition root.
import type { RouteHandler } from "@polyth/contracts";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";

export function exampleFeatureRoutes(host: ServerPackageHost): RouteHandler {
  return async ({ path, method, json }) => {
    if (path === "/api/example-feature" && method === "GET") {
      json(200, { ok: true, package: host.pluginId });
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  return {
    remoteAccess: localOnlyRemoteAccess(["example-feature"]),
    routes: exampleFeatureRoutes(host),
  };
}
