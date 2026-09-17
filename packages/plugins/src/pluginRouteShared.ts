import type { OpenCodePluginConfigEntry, SecureSafeService, SpaceContext } from "@polyth/contracts";
import { serverServiceKey, type ServerPackageHost } from "./serverPackage.ts";
import type { PackageOpaqueVault } from "./connections.ts";

export interface PluginConfigService {
  listPlugins(): Promise<OpenCodePluginConfigEntry[]>;
  applyPlugins(plugins: unknown[]): Promise<OpenCodePluginConfigEntry[]>;
  removePlugin(spec: string): Promise<{
    plugins: OpenCodePluginConfigEntry[];
    removed: boolean;
  }>;
}

/**
 * Request-facing secrets are resolved from an already-authorized SpaceContext.
 * `forSpaceId` exists only for opaque package-connection keys whose canonical
 * key already embeds the Space id (`pkgconn:<spaceId>:...`).
 */
export interface SpaceSecureSafeRegistry {
  forSpace(space: SpaceContext): SecureSafeService;
  forSpaceId(spaceId: string): SecureSafeService | undefined;
}

export const SPACE_SECURE_SAFE =
  serverServiceKey<SpaceSecureSafeRegistry>("secure-safe.spaces");

export const notFound = (message = "plugin UI bundle not found") =>
  Object.assign(new Error(message), { code: "not-found" });

const spaceIdFromOpaqueKey = (key: string): string | null => {
  const match = /^pkgconn:(spc_[A-Za-z0-9-]{1,200}):/.exec(key);
  return match?.[1] ?? null;
};

function routedPackageVault(registry: SpaceSecureSafeRegistry): PackageOpaqueVault {
  const safe = (key: string): SecureSafeService => {
    const spaceId = spaceIdFromOpaqueKey(key);
    const resolved = spaceId ? registry.forSpaceId(spaceId) : undefined;
    if (!resolved) {
      throw Object.assign(new Error("Space-owned Secure Safe is unavailable for this credential"), {
        code: "HOST_UNAVAILABLE",
      });
    }
    return resolved;
  };
  return {
    putOpaque(key, value) { safe(key).putOpaque(key, value); },
    getOpaque(key) { return safe(key).getOpaque(key); },
    deleteOpaque(key) { safe(key).deleteOpaque(key); },
    deleteOpaqueByPrefix(prefix) { safe(prefix).deleteOpaqueByPrefix(prefix); },
  };
}

export function optionalSecretVault(host?: ServerPackageHost): PackageOpaqueVault | undefined {
  const spaces = host?.services.get(SPACE_SECURE_SAFE);
  if (spaces) return routedPackageVault(spaces);
  // Rolling-upgrade/test compatibility only. Production provides the Space
  // registry from the secure-safe package before request handling starts.
  const safe = host?.services.get(serverServiceKey<SecureSafeService>("secure-safe"));
  return safe?.putOpaque ? safe : undefined;
}

export function secretVault(host?: ServerPackageHost): PackageOpaqueVault {
  const safe = optionalSecretVault(host);
  if (!safe) {
    throw Object.assign(new Error("Secure Safe is not available"), { code: "HOST_UNAVAILABLE" });
  }
  return safe;
}
