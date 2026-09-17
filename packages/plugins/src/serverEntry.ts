import { join } from "node:path";
import type { RouteHandler, RouteRequest, SecureSafeService } from "@polyth/contracts";
import {
  createPluginRegistry,
  localOnlyRemoteAccess,
  serverServiceKey,
  type PluginRegistry,
  type ServerPackage,
  type ServerPackageHost,
} from "./index.ts";
import { assertDeploymentPackageMutator } from "./lifecycleAuth.ts";
import { managedPluginRoutes } from "./managedPluginRoutes.ts";
import { opencodePluginRoutes } from "./opencodePluginRoutes.ts";
import { pluginAssetRoutes } from "./pluginAssetRoutes.ts";
import type { PluginConfigService } from "./pluginRouteShared.ts";
import { readSpaceEnabled } from "./spaceEnabled.ts";
import { bindTrustedServerSpaceGate } from "./trustedServerEntry.ts";

export { managedPluginRoutes } from "./managedPluginRoutes.ts";
export { opencodePluginRoutes } from "./opencodePluginRoutes.ts";
export { pluginAssetRoutes } from "./pluginAssetRoutes.ts";

/**
 * A trusted Node server entry has deployment-wide execution authority even
 * though enablement is recorded per Space. Starting or stopping that runtime
 * therefore requires the instance owner; ordinary sandbox/UI package lifecycle
 * remains a Space-admin operation inside managedPluginRoutes().
 */
export function guardTrustedServerLifecycle(
  registry: Pick<PluginRegistry, "canonicalManifest">,
  request: RouteRequest,
): void {
  if (request.method !== "POST") return;
  const match = request.path.match(/^\/api\/plugins\/([^/]+)\/(enable|disable)$/);
  if (!match) return;
  const id = decodeURIComponent(match[1]!);
  if (registry.canonicalManifest(id).runtime?.server) {
    assertDeploymentPackageMutator(request);
  }
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  let registry: PluginRegistry | null = null;
  let trustedRouteGate: { dispose(): void } | null = null;

  const packageSpaces = () => {
    const spaces = host.packageSpaces;
    if (!spaces) {
      throw Object.assign(new Error("package manager requires host.packageSpaces"), {
        code: "HOST_UNAVAILABLE",
      });
    }
    return spaces.call(host);
  };

  return {
    remoteAccess: localOnlyRemoteAccess(["plugins"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      trustedRouteGate?.dispose();
      trustedRouteGate = bindTrustedServerSpaceGate((packageId, spaceId) => {
        const space = packageSpaces().find((item) => item.spaceId === spaceId);
        return space ? readSpaceEnabled(space.storage, packageId) : false;
      });

      try {
        const pluginsDir = join(host.storageDir, "plugins");
        registry = createPluginRegistry({
          dir: pluginsDir,
          trustedDir: process.env.POLYTH_TRUSTED_PLUGIN_DIR
            ?? join(host.storageDir, "trusted-plugins"),
          routes: host.routes,
          root: host.root,
          onChange: (packageId) => host.broadcast.pluginChanged?.(packageId),
          allowDevPath: process.env.POLYTH_ALLOW_DEV_PACKAGES === "1",
          packageSpaces,
          secrets: () => {
            const safe = host.services.get(serverServiceKey<SecureSafeService>("secure-safe"));
            return safe?.putOpaque ? safe : undefined;
          },
        });
        host.services.provide(serverServiceKey<PluginRegistry>("plugins.managed"), registry);
        const managed = managedPluginRoutes(registry, host);
        const handlers = [
          pluginAssetRoutes({ plugins: registry }),
          opencodePluginRoutes(host.services.require(
            serverServiceKey<PluginConfigService>("plugins.config"),
          )),
          async (request: RouteRequest) => {
            guardTrustedServerLifecycle(registry!, request);
            return managed(request);
          },
        ];
        routes = async (request) => {
          for (const handler of handlers) {
            if (await handler(request)) return true;
          }
          return false;
        };
      } catch (cause) {
        trustedRouteGate?.dispose();
        trustedRouteGate = null;
        throw cause;
      }
    },
    async onDisable() {
      try {
        await registry?.dispose();
      } finally {
        trustedRouteGate?.dispose();
        trustedRouteGate = null;
        registry = null;
        routes = null;
      }
    },
  };
}
