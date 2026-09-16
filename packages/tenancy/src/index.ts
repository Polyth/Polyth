// @polyth/tenancy — the platform-layer tenancy boundary.
//
// A Space is the tenant: the unit that owns projects, sessions, files, secrets,
// integrations, and executions. This package owns the registry (who exists, who
// belongs where), the request → SpaceContext pipeline, tenant-separated storage
// with canonical path validation, and the audit trail.
//
// It deliberately knows nothing about HTTP, sessions, or OpenCode: the server
// composes it, and feature packages receive an already-resolved SpaceContext
// rather than re-deriving tenancy for themselves.
export {
  createTenancyStore,
  noSuchSpace,
  slugify,
  SPACE_SLUG,
  type CreateSpaceInput,
  type TenancyFile,
  type TenancyStore,
} from "./store.ts";
export {
  createIdentityResolver,
  createSpaceResolver,
  deploymentProfileFromEnv,
  type Identity,
  type IdentityResolver,
  type SpaceHints,
  type SpaceResolver,
} from "./context.ts";
export {
  createSpaceStorage,
  resolveInside,
  spaceDirName,
  spacesRoot,
  spaceStorageDir,
  SPACE_SUBDIRS,
} from "./paths.ts";
export { AUDIT, createAuditSink, redact, type AuditSink } from "./audit.ts";
export {
  inventoryLegacyMigration,
  LEGACY_OWNER_ALIAS,
  type LegacyInventoryOptions,
  type LegacyMigrationInventory,
  type LegacyMigrationIssue,
  type LegacyOwnershipProof,
  type LegacyPlannedAdoption,
  type LegacySourceEvidence,
  type LegacySourceKind,
} from "./legacyMigration.ts";
export {
  BOOTSTRAP_USER_ID,
  DEFAULT_SPACE_NAME,
  migrateToSpaces,
  unownedProjects,
  type MigrationResult,
  type MigrationTargets,
} from "./migrate.ts";
export {
  loadLegacyAuthState,
  parseLegacyAuthState,
  type LegacyCredential,
  type LegacyAuthSession,
  type LegacyAuthState,
} from "./legacyAuth.ts";
export {
  stageLegacyMigration,
  verifyMigrationStage,
  type MigrationStageArtifact,
  type MigrationStageManifest,
  type StageLegacyMigrationOptions,
} from "./migrationStage.ts";
export {
  parseLegacyTenancyState,
  loadLegacyTenancyState,
  type LegacyTenancyIssue,
} from "./legacyTenancy.ts";
