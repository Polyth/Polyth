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
  bindPackageServices,
  discoverServerPackages,
  INFRASTRUCTURE_PACKAGE_DIRS,
  loadServerPackage,
  localOnlyRemoteAccess,
  SERVER_APPLICATION_SURFACE,
  serverServiceKey,
  type AppendEventOptions,
  type DiscoveredServerPackage,
  type HttpServerContext,
  type PackageSpaceAdminView,
  type ServerBroadcast,
  type ServerApplicationSurface,
  type ServerOneShotOptions,
  type ServerPackage,
  type ServerPackageFactory,
  type ServerPackageHost,
  type ServerRuntimePool,
  type ServerServiceRegistry,
  type SessionRuntimeBinding,
} from "./serverPackage.ts";
export { packageWorkspace, type PackageWorkspace } from "./packageWorkspace.ts";
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
export { readSpaceEnabled, writeSpaceEnabled } from "./spaceEnabled.ts";
