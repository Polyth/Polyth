import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ControlPlane } from "@polyth/control-plane";
import type { MigrationStageArtifact, MigrationStageManifest } from "./migrationStage.ts";

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integerTime = (value: unknown, fallback: number): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;

function fail(code: string): never {
  throw Object.assign(new Error("Canonical resource migration cannot be materialized safely"), { code });
}

function copiedArtifact(
  manifest: MigrationStageManifest,
  stageRoot: string,
  kind: "projects" | "sessions",
): { artifact: MigrationStageArtifact; file: string } | null {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind);
  if (!artifact) fail("stage-incomplete");
  if (artifact.status === "absent") return null;
  if (artifact.status !== "copied" || !artifact.sha256 || artifact.bytes === undefined) fail("stage-quarantined");
  const file = join(stageRoot, artifact.file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== artifact.bytes) {
    fail("stage-artifact-changed");
  }
  const bytes = readFileSync(file);
  if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) fail("stage-artifact-changed");
  return { artifact, file };
}

interface ImportedProject {
  id: string;
  spaceId: string;
  createdAt: number;
}
interface ImportedSession {
  id: string;
  projectId: string;
  spaceId: string;
  createdAt: number;
}

function projectsFromStage(manifest: MigrationStageManifest, stageRoot: string, now: number): ImportedProject[] {
  const source = copiedArtifact(manifest, stageRoot, "projects");
  if (!source) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(source.file, "utf8")) as unknown; }
  catch { fail("invalid-stage-artifact"); }
  if (!Array.isArray(parsed)) fail("invalid-stage-artifact");
  const result: ImportedProject[] = [];
  for (const row of parsed) {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id
      || typeof row.spaceId !== "string" || !row.spaceId) fail("migration-resource-scope-missing");
    result.push({ id: row.id, spaceId: row.spaceId, createdAt: integerTime(row.createdAt, now) });
  }
  return result;
}

function sessionsFromStage(manifest: MigrationStageManifest, stageRoot: string, now: number): ImportedSession[] {
  const source = copiedArtifact(manifest, stageRoot, "sessions");
  if (!source) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source.file, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok") fail("invalid-stage-database");
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projections'").get();
    if (!table) return [];
    const rows = db.prepare("SELECT session_id AS id,data FROM projections ORDER BY session_id").all() as Array<{ id: string; data: string }>;
    const result: ImportedSession[] = [];
    for (const row of rows) {
      let projection: unknown;
      try { projection = JSON.parse(row.data) as unknown; } catch { fail("invalid-stage-artifact"); }
      if (!isRecord(projection) || typeof row.id !== "string" || !row.id
        || typeof projection.projectId !== "string" || !projection.projectId
        || typeof projection.spaceId !== "string" || !projection.spaceId) {
        fail("migration-resource-scope-missing");
      }
      result.push({
        id: row.id,
        projectId: projection.projectId,
        spaceId: projection.spaceId,
        createdAt: integerTime(projection.createdAt, now),
      });
    }
    return result;
  } finally {
    try { db?.close(); } catch { /* preserve migration result */ }
  }
}

function ownerProofs(manifest: MigrationStageManifest): Map<string, string> {
  const result = new Map<string, string>();
  for (const proof of manifest.inventory.ownership) {
    if (proof.resourceKind !== "project" && proof.resourceKind !== "session") continue;
    const key = `${proof.resourceKind}\0${proof.resourceId}`;
    const existing = result.get(key);
    if (existing && existing !== proof.ownerUserId) fail("migration-resource-owner-conflict");
    result.set(key, proof.ownerUserId);
  }
  return result;
}

export interface CanonicalResourceImportResult {
  projectsImported: number;
  sessionsImported: number;
}

/**
 * Materialize resources only while the reviewed legacy capsule is being
 * converted inside the unpublished temporary control-plane. Legacy stores are
 * already durable, so imported resources start active directly; the live
 * runtime uses resource_provisioning for every new cross-store write.
 */
export function materializeCanonicalResources(
  control: ControlPlane,
  manifest: MigrationStageManifest,
  stageRoot: string,
  now: number,
): CanonicalResourceImportResult {
  const projects = projectsFromStage(manifest, stageRoot, now);
  const sessions = sessionsFromStage(manifest, stageRoot, now);
  const proofs = ownerProofs(manifest);
  const seen = new Set<string>();

  const orgForSpace = (spaceId: string): string => {
    const row = control.get<{ orgId: string }>("SELECT org_id AS orgId FROM spaces WHERE id=?", spaceId);
    if (!row) fail("migration-resource-space-missing");
    return row.orgId;
  };
  const ownerFor = (kind: "project" | "session", id: string): string => {
    const owner = proofs.get(`${kind}\0${id}`);
    if (!owner || !control.get("SELECT 1 FROM principals WHERE id=? AND status='active'", owner)) {
      fail("migration-resource-owner-unproven");
    }
    return owner;
  };
  const insert = (
    kind: "project" | "session",
    id: string,
    spaceId: string,
    parentId: string | null,
    createdAt: number,
  ): void => {
    if (seen.has(id)) fail("migration-resource-id-collision");
    seen.add(id);
    const owner = ownerFor(kind, id);
    control.run(
      `INSERT INTO resources(
         id,kind,org_id,space_id,parent_id,owner_principal_id,created_by,
         visibility,lifecycle,created_at_ms,updated_at_ms
       ) VALUES(?,?,?,?,?,?,?,'space','active',?,?)`,
      id, kind, orgForSpace(spaceId), spaceId, parentId, owner, owner, createdAt, Math.max(createdAt, now),
    );
  };

  control.transaction(() => {
    for (const project of projects) insert("project", project.id, project.spaceId, null, project.createdAt);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    for (const session of sessions) {
      const project = projectById.get(session.projectId);
      if (!project || project.spaceId !== session.spaceId) fail("migration-resource-parent-mismatch");
      insert("session", session.id, session.spaceId, session.projectId, session.createdAt);
    }
    if (projects.length || sessions.length) {
      control.audit("system:legacy-migration", "migration.resources-materialized", manifest.id);
    }
  });

  return { projectsImported: projects.length, sessionsImported: sessions.length };
}
