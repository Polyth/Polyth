import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { openControlPlane, type ControlPlane } from "@polyth/control-plane";
import { parseLegacyAuthState, type LegacyAuthState } from "./legacyAuth.ts";
import { LEGACY_OWNER_ALIAS } from "./legacyMigration.ts";
import { parseLegacyTenancyState, type TenancyFile } from "./legacyTenancy.ts";
import { verifyMigrationStage, type MigrationStageManifest } from "./migrationStage.ts";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => {
  throw Object.assign(new Error("Legacy migration cannot be activated safely"), { code });
};

export interface AppliedLegacyMigration {
  migrationId: string;
  manifestDigest: string;
  installationId: string;
  usersImported: number;
  spacesImported: number;
  credentialsImported: number;
  sessionsRevoked: number;
  generatedLogins: Record<string, string>;
}

export interface ApplyLegacyMigrationOptions {
  dataDir: string;
  stageDir: string;
  expectedManifestDigest: string;
  now?: () => number;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function absent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw cause;
  }
}

function copiedJson(manifest: MigrationStageManifest, stageRoot: string, kind: "auth" | "tenancy"): unknown | undefined {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) fail("stage-incomplete");
  if (artifact.status === "absent") return undefined;
  if (artifact.status !== "copied" || !artifact.sha256) fail("stage-quarantined");
  const file = join(stageRoot, artifact.file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("stage-artifact-changed");
  const bytes = readFileSync(file);
  if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) fail("stage-artifact-changed");
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { fail("invalid-stage-artifact"); }
}

function effectiveCredentials(auth: LegacyAuthState): Map<string, string> {
  const result = new Map<string, string>();
  if (auth.passwordHash) result.set(LEGACY_OWNER_ALIAS, auth.passwordHash);
  // This matches the legacy runtime: an explicit v2 credential supersedes the
  // historical owner passwordHash for the same account.
  for (const credential of auth.credentials) result.set(credential.userId, credential.passwordHash);
  return result;
}

function allocateLogins(userIds: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const userId of userIds) {
    let candidate = userId === LEGACY_OWNER_ALIAS ? "owner" : userId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate) || used.has(candidate)) {
      candidate = `legacy-${hash(userId).slice(0, 24)}`;
    }
    if (used.has(candidate)) fail("migration-login-collision");
    used.add(candidate);
    result.set(userId, candidate);
  }
  return result;
}

function populate(control: ControlPlane, manifest: MigrationStageManifest, auth: LegacyAuthState, tenancy: TenancyFile, now: number): AppliedLegacyMigration {
  const ownerProven = manifest.inventory.ownership.some((proof) =>
    proof.resourceKind === "user" && proof.resourceId === LEGACY_OWNER_ALIAS
      && proof.ownerUserId === LEGACY_OWNER_ALIAS && proof.proof === "verified-legacy-owner");
  if (!ownerProven) fail("migration-owner-unproven");

  // Canonical `ready` means the whole installation is governed. Publishing an
  // identity authority while projects/sessions/profiles still require legacy
  // ownership stamping would reopen ambient-owner semantics through resources.
  if (manifest.inventory.plannedAdoptions.length > 0) fail("migration-resource-adoption-required");

  const credentials = effectiveCredentials(auth);
  const users = new Map(tenancy.users.map((user) => [user.id, user]));
  for (const userId of credentials.keys()) {
    if (!users.has(userId)) users.set(userId, { id: userId, name: userId === LEGACY_OWNER_ALIAS ? "Owner" : userId, createdAt: now });
  }
  if (!users.has(LEGACY_OWNER_ALIAS)) users.set(LEGACY_OWNER_ALIAS, { id: LEGACY_OWNER_ALIAS, name: "Owner", createdAt: now });
  const userIds = [...users.keys()].sort();
  const logins = allocateLogins(userIds);
  const organizationId = `org_${manifest.inventory.inventoryDigest.slice(0, 24)}`;
  const fallbackSpaceId = `spc_${manifest.inventory.inventoryDigest.slice(24, 48)}`;
  const spaces = tenancy.spaces.map((space) => ({ ...space }));
  const memberships = tenancy.memberships.map((member) => ({ ...member }));

  if (!memberships.some((member) => member.userId === LEGACY_OWNER_ALIAS)) {
    const usedSlugs = new Set(spaces.map((space) => space.slug));
    let fallbackSlug = "personal";
    if (usedSlugs.has(fallbackSlug)) fallbackSlug = `personal-${manifest.inventory.inventoryDigest.slice(0, 8)}`;
    spaces.push({
      id: fallbackSpaceId,
      name: "Personal",
      slug: fallbackSlug,
      createdAt: now,
      updatedAt: now,
      isDefault: true,
    });
    memberships.push({ userId: LEGACY_OWNER_ALIAS, spaceId: fallbackSpaceId, role: "owner", createdAt: now });
  }

  control.transaction(() => {
    for (const userId of userIds) {
      const user = users.get(userId)!;
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", user.id);
      control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)", user.id, user.name, user.createdAt, Math.max(user.createdAt, now));
    }

    control.run("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)", organizationId, "Imported Polyth", `imported-${manifest.inventory.inventoryDigest.slice(0, 12)}`);
    for (const userId of userIds) {
      control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES(?,?,?)", organizationId, userId, userId === LEGACY_OWNER_ALIAS ? "owner" : "member");
    }
    control.run("INSERT INTO instance_roles(user_id,role) VALUES(?,'owner')", LEGACY_OWNER_ALIAS);

    const membershipOwners = new Map<string, string>();
    for (const member of memberships) if (member.role === "owner" && !membershipOwners.has(member.spaceId)) membershipOwners.set(member.spaceId, member.userId);
    for (const space of spaces) {
      control.run(
        "INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,color,icon,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",
        space.id,
        organizationId,
        space.name,
        space.slug,
        space.isDefault && membershipOwners.get(space.id) === LEGACY_OWNER_ALIAS ? "personal" : "shared",
        space.isDefault ? 1 : 0,
        space.color ?? null,
        space.icon ?? null,
        space.createdAt,
        space.updatedAt,
      );
    }
    for (const member of memberships) {
      control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES(?,?,?,?)", member.spaceId, member.userId, member.role, member.createdAt);
    }

    for (const [deviceKey, spaceId] of Object.entries(tenancy.selections)) {
      for (const member of memberships) if (member.spaceId === spaceId) {
        control.run("INSERT OR IGNORE INTO device_selections(device_key,user_id,space_id) VALUES(?,?,?)", deviceKey, member.userId, spaceId);
      }
    }

    for (const [userId, passwordHash] of credentials) {
      control.run("INSERT INTO password_credentials(user_id,login_name,password_hash,changed_at_ms) VALUES(?,?,?,?)", userId, logins.get(userId)!, passwordHash, now);
    }

    control.run("INSERT INTO legacy_imports(name,digest,imported_at_ms) VALUES(?,?,?)", "migration-stage", manifest.manifestDigest, now);
    for (const source of manifest.inventory.sources) if (source.present && source.sha256 && (source.kind === "auth" || source.kind === "tenancy")) {
      control.run("INSERT INTO legacy_imports(name,digest,imported_at_ms) VALUES(?,?,?)", `${source.kind}.json`, source.sha256, now);
    }
    control.run("UPDATE installation SET state='ready',revision=revision+1 WHERE singleton=1");
    control.bumpEpoch();
    control.audit(LEGACY_OWNER_ALIAS, "migration.legacy-identity-adopted", manifest.id);
  });

  const installationId = control.installation().id;
  return {
    migrationId: manifest.id,
    manifestDigest: manifest.manifestDigest,
    installationId,
    usersImported: userIds.length,
    spacesImported: spaces.length,
    credentialsImported: credentials.size,
    sessionsRevoked: auth.sessions.length,
    generatedLogins: Object.fromEntries([...logins].filter(([userId]) => credentials.has(userId))),
  };
}

/**
 * Apply only a separately verified, non-quarantined capsule. The canonical
 * authority is built under a private temporary root and becomes visible to the
 * installation only by the final directory rename after it is already ready.
 * Legacy remembered sessions are intentionally revoked rather than translated.
 */
export function applyLegacyIdentityMigration(opts: ApplyLegacyMigrationOptions): AppliedLegacyMigration {
  const manifest = verifyMigrationStage(opts.stageDir, opts.expectedManifestDigest);
  if (manifest.status !== "verified" || !manifest.inventory.safeToStage || manifest.inventory.issues.length) fail("stage-quarantined");

  const dataRoot = realpathSync.native(resolve(opts.dataDir));
  if (dataRoot !== manifest.inventory.sourceRoot) fail("stage-source-mismatch");
  const controlRoot = join(dataRoot, "control-plane");
  if (!absent(controlRoot)) fail("canonical-authority-exists");

  const stageRoot = realpathSync.native(resolve(opts.stageDir));
  const authRaw = copiedJson(manifest, stageRoot, "auth");
  const tenancyRaw = copiedJson(manifest, stageRoot, "tenancy");
  if (authRaw === undefined) fail("migration-owner-unproven");
  const auth = parseLegacyAuthState(authRaw, LEGACY_OWNER_ALIAS).stored;
  const tenancy = tenancyRaw === undefined
    ? { version: 1, users: [], spaces: [], memberships: [], selections: {} } satisfies TenancyFile
    : parseLegacyTenancyState(tenancyRaw);

  const temporary = join(dataRoot, `.control-plane-adopt-${manifest.id}`);
  if (!absent(temporary)) fail("migration-temporary-exists");
  mkdirSync(temporary, { mode: 0o700 });
  chmodSync(temporary, 0o700);
  syncDirectory(dataRoot);

  let control: ControlPlane | undefined;
  let published = false;
  try {
    control = openControlPlane({ directory: temporary });
    const result = populate(control, manifest, auth, tenancy, opts.now?.() ?? Date.now());
    control.close();
    control = undefined;

    // Reopen before publication so migration/schema/integrity checks exercise
    // exactly the bytes that will become authoritative.
    const check = openControlPlane({ directory: temporary });
    try {
      if (check.installation().state !== "ready") fail("migration-not-ready");
      if (!check.get("SELECT 1 FROM instance_roles WHERE user_id=? AND role='owner'", LEGACY_OWNER_ALIAS)) fail("migration-owner-unproven");
      if (!check.get("SELECT 1 FROM legacy_imports WHERE name='migration-stage' AND digest=?", manifest.manifestDigest)) fail("migration-provenance-missing");
    } finally { check.close(); }

    renameSync(join(temporary, "control-plane"), controlRoot);
    published = true;
    syncDirectory(dataRoot);
    rmSync(temporary, { recursive: true, force: true });
    return result;
  } catch (cause) {
    try { control?.close(); } catch { /* preserve migration failure */ }
    if (!published) {
      try { rmSync(temporary, { recursive: true, force: true }); } catch { /* preserve migration failure */ }
    }
    const code = (cause as NodeJS.ErrnoException).code;
    if (code && /^(?:stage-|migration-|canonical-|recovery-|invalid-)/.test(code)) throw cause;
    fail("migration-apply-failed");
  }
}
