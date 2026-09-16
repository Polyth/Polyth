import { createHash } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inventoryLegacyMigration, LEGACY_OWNER_ALIAS } from "./legacyMigration.ts";
import { parseLegacyTenancyState, type TenancyFile } from "./legacyTenancy.ts";
import { verifyMigrationStage, type MigrationStageManifest } from "./migrationStage.ts";

const fail = (code: string): never => {
  throw Object.assign(new Error("Legacy resource ownership cannot be adopted safely"), { code });
};
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export interface ApplyLegacyResourceAdoptionsOptions {
  dataDir: string;
  stageDir: string;
  expectedManifestDigest: string;
  profileOwnersFile?: string;
  now?: () => number;
}
export interface AppliedLegacyResourceAdoptions {
  migrationId: string;
  projectsAdopted: number;
  sessionsAdopted: number;
  labelsAdopted: number;
  profilesAdopted: number;
  tenancyCreated: boolean;
  nextInventoryDigest: string;
  remainingAdoptions: number;
}

function stageArtifact(manifest: MigrationStageManifest, kind: "tenancy" | "projects" | "sessions" | "profile-owners") {
  const artifact = manifest.artifacts.find(entry => entry.kind === kind);
  if (!artifact) fail("stage-incomplete");
  return artifact;
}
function readStageJson(manifest: MigrationStageManifest, stageRoot: string, kind: "tenancy" | "projects" | "profile-owners"): unknown | undefined {
  const artifact = stageArtifact(manifest, kind);
  if (artifact.status === "absent") return undefined;
  if (artifact.status !== "copied") fail("stage-quarantined");
  return JSON.parse(readFileSync(join(stageRoot, artifact.file), "utf8")) as unknown;
}
function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function atomicJson(file: string, value: unknown): void {
  const parent = dirname(file);
  const temporary = `${file}.migration-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    syncDirectory(parent);
  } catch (cause) {
    try { rmSync(temporary, { force: true }); } catch { /* preserve failure */ }
    throw cause;
  }
}
function emptyTenancy(): TenancyFile {
  return { version: 1, users: [], spaces: [], memberships: [], selections: {} };
}
function fallbackSpaceId(inventoryDigest: string, ownerUserId: string): string {
  return ownerUserId === LEGACY_OWNER_ALIAS
    ? `spc_${inventoryDigest.slice(24, 48)}`
    : `spc_${hash(`${inventoryDigest}\0${ownerUserId}`).slice(0, 24)}`;
}
function spaceForOwner(tenancy: TenancyFile, ownerUserId: string): string | undefined {
  const memberships = tenancy.memberships.filter(member => member.userId === ownerUserId);
  const defaults = tenancy.spaces.filter(space => space.isDefault).map(space => space.id);
  return memberships.find(member => defaults.includes(member.spaceId))?.spaceId ?? memberships[0]?.spaceId;
}
function ensureOwnerSpace(tenancy: TenancyFile, ownerUserId: string, inventoryDigest: string, now: number): { spaceId: string; changed: boolean } {
  const existing = spaceForOwner(tenancy, ownerUserId);
  if (existing) return { spaceId: existing, changed: false };
  if (!tenancy.users.some(user => user.id === ownerUserId)) {
    tenancy.users.push({ id: ownerUserId, name: ownerUserId === LEGACY_OWNER_ALIAS ? "Owner" : ownerUserId, createdAt: now });
  }
  const spaceId = fallbackSpaceId(inventoryDigest, ownerUserId);
  const usedSlugs = new Set(tenancy.spaces.map(space => space.slug));
  let slug = ownerUserId === LEGACY_OWNER_ALIAS ? "personal" : `personal-${hash(ownerUserId).slice(0, 8)}`;
  if (usedSlugs.has(slug)) slug = `${slug}-${inventoryDigest.slice(0, 8)}`;
  tenancy.spaces.push({ id: spaceId, name: "Personal", slug, createdAt: now, updatedAt: now, isDefault: true });
  tenancy.memberships.push({ userId: ownerUserId, spaceId, role: "owner", createdAt: now });
  return { spaceId, changed: true };
}

/**
 * Offline, verified-capsule resource adoption. Each store is crash-atomic on its
 * own and the order is monotonic: tenancy -> projects -> sessions -> profiles.
 * A crash between stores leaves no canonical authority and is safely resumable
 * by taking a new inventory/stage from the now-more-explicit legacy state.
 */
export function applyLegacyResourceAdoptions(opts: ApplyLegacyResourceAdoptionsOptions): AppliedLegacyResourceAdoptions {
  const manifest = verifyMigrationStage(opts.stageDir, opts.expectedManifestDigest);
  if (manifest.status !== "verified" || !manifest.inventory.safeToStage || manifest.inventory.issues.length) fail("stage-quarantined");
  const dataRoot = realpathSync.native(resolve(opts.dataDir));
  if (dataRoot !== manifest.inventory.sourceRoot) fail("stage-source-mismatch");

  // Before the first write, prove live sources still equal the reviewed capsule.
  const live = inventoryLegacyMigration({ dataDir: dataRoot, ...(opts.profileOwnersFile ? { profileOwnersFile: opts.profileOwnersFile } : {}) });
  if (live.inventoryDigest !== manifest.inventory.inventoryDigest) fail("source-changed");

  const resourceAdoptions = manifest.inventory.plannedAdoptions.filter(adoption => adoption.kind !== "user-alias");
  if (resourceAdoptions.length === 0) {
    return {
      migrationId: manifest.id, projectsAdopted: 0, sessionsAdopted: 0,
      labelsAdopted: 0, profilesAdopted: 0, tenancyCreated: false,
      nextInventoryDigest: live.inventoryDigest, remainingAdoptions: 0,
    };
  }

  const stageRoot = realpathSync.native(resolve(opts.stageDir));
  const tenancyRaw = readStageJson(manifest, stageRoot, "tenancy");
  const tenancy = tenancyRaw === undefined ? emptyTenancy() : parseLegacyTenancyState(tenancyRaw);
  const now = opts.now?.() ?? Date.now();
  const owners = new Set(resourceAdoptions.map(adoption => adoption.ownerUserId));
  const ownerSpaces = new Map<string, string>();
  let tenancyChanged = tenancyRaw === undefined;
  for (const owner of owners) {
    const ensured = ensureOwnerSpace(tenancy, owner, manifest.inventory.inventoryDigest, now);
    ownerSpaces.set(owner, ensured.spaceId);
    tenancyChanged ||= ensured.changed;
  }
  if (tenancyChanged) atomicJson(join(dataRoot, "tenancy.json"), tenancy);

  const projectsRaw = readStageJson(manifest, stageRoot, "projects");
  const projects = projectsRaw === undefined ? [] : projectsRaw;
  if (!Array.isArray(projects)) fail("invalid-stage-artifact");
  const projectRows = new Map<string, Record<string, unknown>>();
  for (const row of projects) {
    if (!isRecord(row) || typeof row.id !== "string") fail("invalid-stage-artifact");
    projectRows.set(row.id, row);
  }
  let projectsAdopted = 0;
  for (const adoption of resourceAdoptions.filter(row => row.kind === "project")) {
    const project = projectRows.get(adoption.resourceId);
    const target = ownerSpaces.get(adoption.ownerUserId);
    if (!project || !target) fail("migration-adoption-target-missing");
    if (typeof project.spaceId === "string" && project.spaceId !== target) fail("migration-adoption-conflict");
    if (!project.spaceId) { project.spaceId = target; projectsAdopted++; }
  }
  if (projectsAdopted) atomicJson(join(dataRoot, "projects.json"), projects);

  // Project ownership is now explicit, so session ownership can be stamped
  // without creating a transient session->Space / ownerless-project conflict.
  const projectSpace = new Map<string, string>();
  for (const row of projectRows.values()) if (typeof row.id === "string" && typeof row.spaceId === "string") projectSpace.set(row.id, row.spaceId);
  let sessionsAdopted = 0;
  let labelsAdopted = 0;
  const sessionAdoptions = new Map(
    resourceAdoptions.filter(row => row.kind === "session").map(row => [row.resourceId, row]),
  );
  const sessionsArtifact = stageArtifact(manifest, "sessions");
  if ((sessionAdoptions.size > 0 || owners.size > 0) && sessionsArtifact.status === "copied") {
    const sessionFile = join(dataRoot, manifest.inventory.sources.find(source => source.kind === "sessions")?.path ?? "sessions.db");
    let db: DatabaseSync | undefined;
    try {
      if (lstatSync(sessionFile).isSymbolicLink()) fail("unsafe-source-file");
      db = new DatabaseSync(sessionFile);
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE");
      const update = db.prepare("UPDATE projections SET data=? WHERE session_id=?");
      for (const [sessionId, adoption] of sessionAdoptions) {
        const row = db.prepare("SELECT data FROM projections WHERE session_id=?").get(sessionId) as { data: string } | undefined;
        if (!row) fail("migration-adoption-target-missing");
        const projection = JSON.parse(row.data) as Record<string, unknown>;
        const projectId = typeof projection.projectId === "string" ? projection.projectId : undefined;
        const target = projectId ? projectSpace.get(projectId) : undefined;
        if (!target || target !== ownerSpaces.get(adoption.ownerUserId)) fail("migration-adoption-conflict");
        if (projection.spaceId !== undefined && projection.spaceId !== target) fail("migration-adoption-conflict");
        if (projection.spaceId === undefined) {
          update.run(JSON.stringify({ ...projection, spaceId: target }), sessionId);
          sessionsAdopted++;
        }
      }
      const hasLabels = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='labels'").get();
      if (hasLabels) {
        const ownerless = Number((db.prepare("SELECT count(*) AS n FROM labels WHERE space_id IS NULL").get() as { n: number | bigint }).n);
        if (ownerless > 0) {
          if (ownerSpaces.size !== 1) fail("migration-label-ownership-ambiguous");
          const target = [...ownerSpaces.values()][0]!;
          labelsAdopted = Number(db.prepare("UPDATE labels SET space_id=? WHERE space_id IS NULL").run(target).changes);
        }
      }
      db.exec("COMMIT");
      const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      if (integrity?.quick_check !== "ok") fail("migration-session-integrity-failed");
    } catch (cause) {
      try { db?.exec("ROLLBACK"); } catch { /* preserve cause */ }
      throw cause;
    } finally { try { db?.close(); } catch { /* preserve result */ } }
  } else if (sessionAdoptions.size > 0) {
    fail("stage-incomplete");
  }

  let profilesAdopted = 0;
  const profileAdoptions = resourceAdoptions.filter(row => row.kind === "agent-profile");
  if (profileAdoptions.length) {
    const staged = readStageJson(manifest, stageRoot, "profile-owners");
    const ownersFile = staged === undefined ? { version: 1, owners: {} as Record<string, string> } : staged;
    if (!isRecord(ownersFile) || ownersFile.version !== 1 || !isRecord(ownersFile.owners)) fail("invalid-stage-artifact");
    const mapped = ownersFile.owners as Record<string, unknown>;
    for (const adoption of profileAdoptions) {
      const current = mapped[adoption.resourceId];
      if (current !== undefined && current !== adoption.ownerUserId) fail("migration-adoption-conflict");
      if (current === undefined) { mapped[adoption.resourceId] = adoption.ownerUserId; profilesAdopted++; }
    }
    const profileFile = opts.profileOwnersFile
      ? resolve(opts.profileOwnersFile)
      : join(dataRoot, manifest.inventory.sources.find(source => source.kind === "profile-owners")?.path ?? "agent-profile-owners.json");
    atomicJson(profileFile, ownersFile);
  }

  const next = inventoryLegacyMigration({ dataDir: dataRoot, ...(opts.profileOwnersFile ? { profileOwnersFile: opts.profileOwnersFile } : {}) });
  if (!next.safeToStage) fail("migration-post-adoption-invalid");
  return {
    migrationId: manifest.id,
    projectsAdopted,
    sessionsAdopted,
    labelsAdopted,
    profilesAdopted,
    tenancyCreated: tenancyChanged,
    nextInventoryDigest: next.inventoryDigest,
    remainingAdoptions: next.plannedAdoptions.filter(row => row.kind !== "user-alias").length,
  };
}
