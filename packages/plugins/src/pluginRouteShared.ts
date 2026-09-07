import type { OpenCodePluginConfigEntry, SecureSafeService } from "@polyth/contracts";
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

export const notFound = (message = "plugin UI bundle not found") =>
  Object.assign(new Error(message), { code: "not-found" });

export function secretVault(host?: ServerPackageHost): PackageOpaqueVault {
  const safe = host?.services.get(serverServiceKey<SecureSafeService>("secure-safe"));
  if (!safe?.putOpaque) {
    throw Object.assign(new Error("Secure Safe is not available"), { code: "HOST_UNAVAILABLE" });
  }
  return safe;
}
