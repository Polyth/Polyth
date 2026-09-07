// Cross-package seams only. Package-manager internals stay on relative imports.
export { parseManifest, TRUST_GRANTS, type ManagedPluginManifest } from "./managedManifest.ts";
export { createPluginRegistry, type PluginLogEntry, type PluginRegistry, type PluginRegistryOptions } from "./managedRegistry.ts";
export { redactSecrets } from "./redact.ts";
export { isSupportedInstallSource } from "./installSourceContract.ts";

export {
  loadServerEntry,
  type ServerPluginFactory,
  type TrustedServerPluginHost,
} from "./trustedServerEntry.ts";
export {
  createServerServiceRegistry,
  discoverServerPackages,
  INFRASTRUCTURE_PACKAGE_DIRS,
  loadServerPackage,
  localOnlyRemoteAccess,
  serverServiceKey,
  type AppendEventOptions,
  type DiscoveredServerPackage,
  type HttpServerContext,
  type PackageSpaceAdminView,
  type ServerBroadcast,
  type ServerOneShotOptions,
  type ServerPackage,
  type ServerPackageFactory,
  type ServerPackageHost,
  type ServerRuntimePool,
  type ServerServiceRegistry,
  type SessionRuntimeBinding,
} from "./serverPackage.ts";
export { PairedSocketRegistry } from "./pairedSockets.ts";
export {
  allowWsCapability,
  claimWsUpgrade,
  closeWs,
  defaultWsIdentity,
  denyUpgrade,
  liveWsPrincipal,
  normalizeWsAttachAuth,
  type WsAttachAuth,
  type WsAuthorize,
  type WsUpgradeClaim,
} from "./wsAttach.ts";
export {
  publishBackgroundWork,
  transitionBackgroundWork,
  type BackgroundWorkTransition,
} from "./backgroundWork.ts";
export { atomicWrite, atomicWriteSync } from "./atomicWrite.ts";
