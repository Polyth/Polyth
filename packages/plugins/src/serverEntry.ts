import { join } from "node:path";
import type { RouteHandler, SecureSafeService } from "@polyth/contracts";
import {
  createPluginRegistry,
  localOnlyRemoteAccess,
  serverServiceKey,
  type PluginRegistry,
  type ServerPackage,
  type ServerPackageHost,
} from "./index.ts";
import { managedPluginRoutes } from "./managedPluginRoutes.ts";
import { opencodePluginRoutes } from "./opencodePluginRoutes.ts";
import { pluginAssetRoutes } from "./pluginAssetRoutes.ts";
import type { PluginConfigService } from "./pluginRouteShared.ts";

export { managedPluginRoutes } from "./managedPluginRoutes.ts";
export { opencodePluginRoutes } from "./opencodePluginRoutes.ts";
export { pluginAssetRoutes } from "./pluginAssetRoutes.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  let registry: PluginRegistry | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["plugins"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const pluginsDir = join(host.storageDir, "plugins");
      registry = createPluginRegistry({
        dir: pluginsDir,
        trustedDir: process.env.POLYTH_TRUSTED_PLUGIN_DIR
          ?? join(host.storageDir, "trusted-plugins"),
        routes: host.routes,
        root: host.root,
        onChange: (packageId) => host.broadcast.pluginChanged?.(packageId),
        allowDevPath: process.env.POLYTH_ALLOW_DEV_PACKAGES === "1",
        packageSpaces: () => {
          const spaces = host.packageSpaces;
          if (!spaces) {
            throw Object.assign(new Error("package manager requires host.packageSpaces"), {
              code: "HOST_UNAVAILABLE",
            });
          }
          return spaces.call(host);
        },
        secrets: () => {
          const safe = host.services.get(serverServiceKey<SecureSafeService>("secure-safe"));
          return safe?.putOpaque ? safe : undefined;
        },
      });
      const handlers = [
        pluginAssetRoutes({ plugins: registry }),
        opencodePluginRoutes(host.services.require(
          serverServiceKey<PluginConfigService>("plugins.config"),
        )),
        managedPluginRoutes(registry, host),
      ];
      routes = async (request) => {
        for (const handler of handlers) {
          if (await handler(request)) return true;
        }
        return false;
      };
    },
    async onDisable() {
      await registry?.dispose();
      registry = null;
      routes = null;
    },
  };
}
