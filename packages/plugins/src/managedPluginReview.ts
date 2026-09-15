import type { InstalledPluginDto, SpaceStorage } from "@polyth/contracts";
import type { PluginRegistry } from "./managedRegistry.ts";
import { currentConnectionReviewItems } from "./connectionFingerprint.ts";
import { missingGrants, readConnectionFingerprints, readGrants } from "./grants.ts";

/** Candidate-version review is owned by the registry because it compares two
 * installed versions. This decorator covers the other case: a freshly
 * installed (or legacy-disabled) sandbox package whose current version has not
 * yet received the Space-scoped authority required for enable. */
export function withInitialPermissionReview(
  registry: Pick<PluginRegistry, "canonicalManifest">,
  storage: SpaceStorage,
  plugin: InstalledPluginDto,
): InstalledPluginDto {
  if (plugin.runtimeKind !== "sandboxed" || plugin.enabled || plugin.permissions.review) return plugin;
  const manifest = registry.canonicalManifest(plugin.id);
  const missing = missingGrants(readGrants(storage, plugin.id), manifest.capabilities ?? []);
  const missingNames = new Set(missing.map((item) => item.name));
  const capabilities = plugin.permissions.requested.filter((item) => missingNames.has(item.name));
  const connections = currentConnectionReviewItems(
    manifest.connections ?? [],
    readConnectionFingerprints(storage, plugin.id),
  );
  if (capabilities.length === 0 && connections.length === 0) return plugin;
  return {
    ...plugin,
    permissions: {
      ...plugin.permissions,
      review: { capabilities, connections },
    },
  };
}
