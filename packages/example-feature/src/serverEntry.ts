// Proof-of-concept discovered server package: opts in via the
// `polyth.serverEntry` marker in package.json and is wired into the package
// lifecycle by discovery alone — no imports or registration in the server
// composition root.
import type { AgentCapabilityContributionRegistry, Disposable, RouteHandler } from "@polyth/contracts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";

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
  let contribution: Disposable | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["example-feature"]),
    routes: exampleFeatureRoutes(host),
    onEnable() {
      const registry = host.services.get(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
      contribution = registry?.register("example-feature", {
        descriptor: {
          id: "example-feature.ping",
          kind: "tool",
          owner: "example-feature",
          scope: "space",
          revision: "1",
          name: "ping",
          description: "Return pong. Proves a package can contribute an agent tool without importing a harness.",
          inputSchema: { type: "object", properties: {} },
          trust: "pure",
          mutating: false,
        },
        execute: async () => ({ output: "pong" }),
      });
    },
    onDisable() {
      contribution?.dispose();
      contribution = undefined;
    },
  };
}
