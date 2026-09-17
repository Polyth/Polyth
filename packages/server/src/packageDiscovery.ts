// Wires discovered workspace packages (polyth.serverEntry markers) into the
// package lifecycle: routes join the route registry on enable and leave it on
// disable, exactly like the previous hand-written registrations. One broken
// package logs and is skipped — it never blocks the rest of boot.
import type { Disposable } from "@polyth/contracts";
import {
  discoverServerPackages,
  loadServerPackage,
  type ServerPackage,
  type DiscoveredServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { PackageLifecycle } from "./packageLifecycle.ts";
import { governPackageHost } from "./packageHostAuthority.ts";
import type { RouteRegistry } from "./routeRegistry.ts";

export interface PackageDiscoveryDeps {
  /** The workspace packages/ directory to scan. */
  packagesDir: string;
  /** Pre-discovered manifests when the registry already scanned at boot. */
  discovered?: readonly DiscoveredServerPackage[];
  /** Shared host template; each package receives it with its own pluginId. */
  host: Omit<ServerPackageHost, "pluginId">;
  /** Optional per-package host factory (used to attach infrastructure-only seams). */
  hostFor?: (id: string) => ServerPackageHost;
  lifecycle: PackageLifecycle;
  routes: RouteRegistry;
  onError?: (id: string, error: unknown) => void;
}

export function registerServerPackage(
  deps: Pick<PackageDiscoveryDeps, "lifecycle" | "routes">,
  id: string,
  pkg: ServerPackage,
): void {
  let route: Disposable | null = null;
  deps.lifecycle.register(id, {
    async onEnable() {
      await pkg.onEnable?.();
      if (pkg.routes) route = deps.routes.add(id, pkg.routes, pkg.remoteAccess);
    },
    async onDisable() {
      await route?.dispose();
      route = null;
      try {
        await pkg.onDisable?.();
      } catch (error) {
        // A failed disable must not leave the package enabled but routeless.
        if (pkg.routes) route = deps.routes.add(id, pkg.routes, pkg.remoteAccess);
        throw error;
      }
    },
    stopIngress: () => pkg.stopIngress?.(),
  });
}

/** Discover, load, and register every workspace package that opts in via a
 *  polyth.serverEntry marker. Returns the ids that registered successfully. */
export async function registerDiscoveredPackages(
  deps: PackageDiscoveryDeps,
): Promise<string[]> {
  const registered: string[] = [];
  const packages = deps.discovered ?? await discoverServerPackages(deps.packagesDir);
  for (const discovered of packages) {
    try {
      const rawHost = deps.hostFor?.(discovered.id) ?? { ...deps.host, pluginId: discovered.id };
      const pkg = await loadServerPackage(discovered, governPackageHost(rawHost));
      registerServerPackage(deps, discovered.id, pkg);
      registered.push(discovered.id);
    } catch (error) {
      deps.onError?.(discovered.id, error);
    }
  }
  return registered;
}
