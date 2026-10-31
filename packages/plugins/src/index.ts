// Cross-package seams only. Package-manager internals stay on relative imports.
export { parseManifest, TRUST_GRANTS, type ManagedPluginManifest } from "./managedManifest.ts";
export { createPluginRegistry, MAX_ARCHIVE_BYTES, MAX_SCREENSHOT_BYTES, type InstallOptions, type PackageUpdateSettings, type PluginLogEntry, type PluginRegistry, type PluginRegistryOptions } from "./managedRegistry.ts";
export { runAutoUpdates, runLocalSourceUpdates, startAutoUpdater, AUTO_UPDATE_INTERVAL_MS, LOCAL_SOURCE_TICK_MS } from "./autoUpdate.ts";
export type { ForkStrategy, ForkTracking } from "./forkSources.ts";
export type { RepositoryArchiveDownloader } from "./installSources.ts";
export { redactSecrets } from "./redact.ts";
export { adoptLegacyPackageData, packageDataDir, packageDataRoot, type PackageDataHost } from "./packageData.ts";
export {
  DEFAULT_REPOSITORY_REF,
  describeInstallSource,
  isRepositorySource,
  isSupportedInstallSource,
  type InstallSourceDescription,
  type InstallSourceKind,
} from "./installSourceContract.ts";

export {
  loadServerEntry,
  type ServerPluginFactory,
  type TrustedServerPluginHost,
} from "./trustedServerEntry.ts";
export { discoverServerPackages } from "./projectCompositionDiscovery.ts";
export {
  createServerServiceRegistry,
  bindPackageServices,
  INFRASTRUCTURE_PACKAGE_DIRS,
  loadServerPackage,
  localOnlyRemoteAccess,
  SERVER_APPLICATION_SURFACE,
  SERVER_OPENCODE_RUNTIME_POLICY,
  SERVER_SESSION_TITLE_GENERATOR,
  SERVER_SESSION_WATCHES,
  SERVER_SESSION_ISOLATION,
  SERVER_MODEL_FAVORITES,
  SERVER_MODEL_ROUTING,
  SERVER_RUNTIME_CATALOG,
  SERVER_TURN_COMPLETION_BUS,
  SERVER_TURN_STOPPED_BUS,
  SERVER_PERMISSION_WAITING_BUS,
  AGENT_EVENT_SOURCES,
  SESSION_ATTENTION_SERVICE,
  SESSION_PURPOSES,
  SERVER_BEHAVIOR_SECTIONS,
  serverServiceKey,
  type AppendEventOptions,
  type DiscoveredServerPackage,
  type HttpServerContext,
  type PackageSpaceAdminView,
  type ServerBroadcast,
  type ServerApplicationSurface,
  type ServerOpenCodeRuntimePolicy,
  type ServerOneShotOptions,
  type ServerPackage,
  type ServerPackageFactory,
  type ServerPackageHost,
  type ServerRuntimePool,
  type ServerServiceRegistry,
  type ServerSessionTitleGenerator,
  type ServerSessionTitleMode,
  type ServerSessionTitlePolicy,
  type ServerSessionWatchCreateInput,
  type ServerSessionWatchDelivery,
  type ServerSessionWatchDto,
  type ServerSessionWatchReason,
  type ServerSessionWatchService,
  type ServerDelegatedMergeResult,
  type ServerDelegatedSessionCreated,
  type ServerDelegatedSessionInput,
  type ServerSessionIsolationService,
  type ServerModelFavoritesService,
  type ServerModelRoutingCandidate,
  type ServerModelRoutingQuota,
  type ServerModelRoutingReport,
  type ServerModelRoutingService,
  type ServerRuntimeCatalogService,
  type ServerTurnCompletedEvent,
  type ServerTurnCompletionBus,
  type ServerTurnStoppedBus,
  type ServerTurnStoppedEvent,
  type ServerPermissionWaitingBus,
  type ServerPermissionWaitingEvent,
  type AgentEventPublication,
  type AgentEventSourceDescriptor,
  type AgentEventSources,
  type SessionPurposeRegistry,
  type ServerBehaviorSectionRegistry,
  type SessionRuntimeBinding,
} from "./serverPackage.ts";
export {
  SPACE_SECURE_SAFE,
  type SpaceSecureSafeRegistry,
} from "./pluginRouteShared.ts";
export {
  collapseRepeatedPackageNamespace,
  isPackageOpaqueKey,
  LEGACY_OPAQUE_OWNERS,
  legacyOpaqueOwner,
  packageOpaqueKey,
  packageScopedSecureSafe,
} from "./opaqueNamespace.ts";
export { packageWorkspace, type PackageWorkspace } from "./packageWorkspace.ts";
export {
  resolveConnectionOwner,
  type ConnectionOrigin,
  type ConnectionOwner,
  type PackageServicePolicy,
  type PeopleHost,
  type PersonPackageStorage,
  type ResolveConnectionOwnerInput,
} from "./personConnections.ts";
export {
  RUNTIME_SYSTEM_PRINCIPAL_ID,
  systemAppendSessionEvent,
  systemSessionsForProject,
  systemSessionsForSession,
} from "./systemSessions.ts";
export {
  PairedSocketRegistry,
  closeAuthSessionSockets,
  closeAuthUserSessionSockets,
  closeAuthUserSockets,
} from "./pairedSockets.ts";
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
  publishRecoveredBackgroundWork,
  recoverBackgroundWork,
  transitionBackgroundWork,
  type BackgroundWorkTransition,
} from "./backgroundWork.ts";
export { atomicWrite, atomicWriteSync } from "./atomicWrite.ts";
export { readSpaceEnabled, writeSpaceEnabled } from "./spaceEnabled.ts";
