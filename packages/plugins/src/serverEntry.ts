import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { RouteHandler, RouteRequest, SecureSafeService } from "@polyth/contracts";
import { hasInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import {
  createPluginRegistry,
  localOnlyRemoteAccess,
  serverServiceKey,
  type PluginRegistry,
  type ServerPackage,
  type ServerPackageHost,
} from "./index.ts";
import { assertDeploymentPackageMutator } from "./lifecycleAuth.ts";
import { managedPluginRoutes, retireRemovedPackageConnections } from "./managedPluginRoutes.ts";
import { startAutoUpdater } from "./autoUpdate.ts";
import { opencodePluginRoutes } from "./opencodePluginRoutes.ts";
import { pluginAssetRoutes } from "./pluginAssetRoutes.ts";
import type { PluginConfigService } from "./pluginRouteShared.ts";
import { readSpaceEnabled } from "./spaceEnabled.ts";
import { bindTrustedServerSpaceGate } from "./trustedServerEntry.ts";
import type { RepositoryArchiveDownloader } from "./installSources.ts";

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

/** Is the current install/update the instance owner's (a route they called, or
 *  an auto-update they turned on)? Unset = neither. */
const ownerInstall = new AsyncLocalStorage<boolean>();

/** Run `fn` as an install the instance owner did (true) or did not (false) start. */
export const withInstallAuthority = <T>(owner: boolean, fn: () => T): T => ownerInstall.run(owner, fn);

/**
 * Private GitHub archives are fetched through the shared GitHub service with
 * the host's `gh` login: the installation's account (Spaces §14.4). Package
 * installs and updates are instance-owner actions — the routes assert it
 * (`assertDeploymentPackageMutator`) — so this asserts it again where the
 * host credential is used, and refuses any other caller.
 */
export function ownerRepositoryDownloader(download: () => RepositoryArchiveDownloader | undefined): RepositoryArchiveDownloader {
  return async (source, maxBytes) => {
    if (ownerInstall.getStore() !== true) {
      throw Object.assign(new Error("package installation uses the host's GitHub login and requires the instance owner"), { code: "forbidden" });
    }
    return await download()?.(source, maxBytes) ?? null;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  let registry: PluginRegistry | null = null;
  let trustedRouteGate: { dispose(): void } | null = null;
  let autoUpdater: { dispose(): void } | null = null;

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
    routes: async (request) => routes
      ? withInstallAuthority(Boolean(request.principal) && hasInstanceOwnerAuthority(request), () => routes!(request))
      : false,
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
          managedPackageServices: host.managedPackageServices,
          downloadRepository: ownerRepositoryDownloader(() =>
            host.services.get(serverServiceKey<{ downloadArchive?: RepositoryArchiveDownloader }>("github"))?.downloadArchive),
          packageSpaces,
          secrets: () => {
            const safe = host.services.get(serverServiceKey<SecureSafeService>("secure-safe"));
            return safe?.putOpaque ? safe : undefined;
          },
        });
        host.services.provide(serverServiceKey<PluginRegistry>("plugins.managed"), registry);
        const managed = managedPluginRoutes(registry, host);
        const owned = registry;
        autoUpdater?.dispose();
        // Auto-updates are ones the instance owner turned on; their timers keep this context.
        autoUpdater = withInstallAuthority(true, () => startAutoUpdater({
          registry: owned,
          apply: (id) => retireRemovedPackageConnections(owned, host, id, () => owned.update(id)),
        }));
        const handlers = [
          pluginAssetRoutes({
            plugins: registry,
            screenshot: (id, version, index) => registry!.screenshotFrame(id, version, index),
          }),
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
        autoUpdater?.dispose();
        autoUpdater = null;
        trustedRouteGate?.dispose();
        trustedRouteGate = null;
        throw cause;
      }
    },
    async onDisable() {
      autoUpdater?.dispose();
      autoUpdater = null;
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
