import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLegacyJson, digestLegacyFile, digestLegacySidecar, readLegacyFile, type LegacyFileDigest } from "./legacyFiles.ts";
import { parseLegacyAuthState } from "./legacyAuth.ts";

export const LEGACY_OWNER_ALIAS = "usr_owner";

export type LegacySourceKind =
  | "auth"
  | "tenancy"
  | "projects"
  | "sessions"
  | "profile-owners";

export type LegacyIssueSeverity = "blocking" | "review";

export interface LegacyMigrationIssue {
  code: string;
  severity: LegacyIssueSeverity;
  source: LegacySourceKind;
  resourceId?: string;
  detail: string;
}

export interface LegacySourceEvidence {
  kind: LegacySourceKind;
  path: string;
  present: boolean;
  sha256?: string;
  bytes?: number;
  counts: Record<string, number>;
  /** Nonempty WAL/journal payloads participate in the fingerprint. Empty
   * auxiliary files and SHM carry no committed data. */
  sidecars?: Record<string, LegacyFileDigest>;
}

export type LegacyOwnershipProofKind =
  | "explicit-space-owner"
  | "explicit-profile-owner"
  | "verified-legacy-owner"
  | "project-space-owner";

export interface LegacyOwnershipProof {
  resourceKind: "user" | "space" | "project" | "session" | "agent-profile";
  resourceId: string;
  ownerUserId: string;
  source: LegacySourceKind;
  proof: LegacyOwnershipProofKind;
}

export interface LegacyPlannedAdoption {
  kind: "user-alias" | "project" | "session" | "agent-profile";
  resourceId: string;
  ownerUserId: string;
  source: LegacySourceKind;
  reason: LegacyOwnershipProofKind | "legacy-alias";
}

export interface LegacyMigrationInventory {
  schemaVersion: 1;
  legacyOwnerAlias: typeof LEGACY_OWNER_ALIAS;
  sourceRoot: string;
  sources: LegacySourceEvidence[];
  ownership: LegacyOwnershipProof[];
  plannedAdoptions: LegacyPlannedAdoption[];
  issues: LegacyMigrationIssue[];
  safeToStage: boolean;
  inventoryDigest: string;
}

export interface LegacyInventoryOptions {
  dataDir: string;
  profileOwnersFile?: string;
}

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function relativeEvidencePath(root: string, file: string): string {
  const rel = relative(root, file);
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) ? rel : file;
}

function sourceEvidence(kind: LegacySourceKind, root: string, file: string): LegacySourceEvidence {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { kind, path: relativeEvidencePath(root, file), present: true, counts: {} };
    }
    const digest = digestLegacyFile(file);
    return {
      kind, path: relativeEvidencePath(root, file), ...digest, counts: {},
      ...(kind === "sessions" ? { sidecars: {
        wal: digestLegacySidecar(`${file}-wal`), journal: digestLegacySidecar(`${file}-journal`),
      } } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind, path: relativeEvidencePath(root, file), present: false, counts: {} };
    }
    return { kind, path: relativeEvidencePath(root, file), present: true, counts: {} };
  }
}

function parseJsonSource(
  source: LegacySourceEvidence,
  root: string,
  file: string,
  issues: LegacyMigrationIssue[],
): unknown | undefined {
  if (!source.present) return undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push({
        code: "unsafe-source-file",
        severity: "blocking",
        source: source.kind,
        detail: `${relativeEvidencePath(root, file)} is not a regular file`,
      });
      return undefined;
    }
    const { digest, data } = readLegacyFile(file);
    if (!data || digest.sha256 !== source.sha256) {
      issues.push({ code: "source-changed", severity: "blocking", source: source.kind, detail: "Source changed during inventory" });
      return undefined;
    }
    return JSON.parse(data.toString("utf8")) as unknown;
  } catch (error) {
    issues.push({
      code: "malformed-source",
      severity: "blocking",
      source: source.kind,
      detail: "Source is unreadable or is not valid bounded JSON",
    });
    return undefined;
  }
}

interface ParsedProject {
  id: string;
  path: string;
  spaceId?: string;
  remoteConnectionId?: string;
}

interface ParsedSpace {
  id: string;
}

function pathKey(project: ParsedProject): string {
  if (project.remoteConnectionId) return `remote:${project.remoteConnectionId}:${normalize(project.path)}`;
  return `local:${resolve(project.path)}`;
}

function overlappingLocalPaths(a: ParsedProject, b: ParsedProject): boolean {
  if (a.remoteConnectionId || b.remoteConnectionId) return false;
  const ap = resolve(a.path);
  const bp = resolve(b.path);
  if (ap === bp) return true;
  const ar = relative(ap, bp);
  const br = relative(bp, ap);
  return (!!ar && ar !== ".." && !ar.startsWith(`..${sep}`) && !isAbsolute(ar)) || (!!br && br !== ".." && !br.startsWith(`..${sep}`) && !isAbsolute(br));
}

function inspectSqlite(
  source: LegacySourceEvidence,
  file: string,
  issues: LegacyMigrationIssue[],
): {
  sessions: Array<{ id: string; projectId?: string; spaceId?: string }>;
  profileIds: string[];
} {
  const result = { sessions: [] as Array<{ id: string; projectId?: string; spaceId?: string }>, profileIds: [] as string[] };
  if (!source.present) return result;
  let db: DatabaseSync | undefined;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { if (!lstatSync(`${file}${suffix}`).isFile()) throw new Error("unsafe-sidecar"); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok") throw new Error("SQLite quick_check failed");
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    source.counts.tables = tables.size;
    if (tables.has("events")) {
      const row = db.prepare("SELECT count(*) AS n FROM events").get() as { n: number | bigint };
      source.counts.events = Number(row.n);
    }
    if (tables.has("session_queue")) {
      const row = db.prepare("SELECT count(*) AS n FROM session_queue").get() as { n: number | bigint };
      source.counts.queuedMessages = Number(row.n);
    }
    if (tables.has("projections")) {
      const rows = db.prepare("SELECT session_id AS id, data FROM projections ORDER BY session_id").all() as Array<{ id: string; data: string }>;
      source.counts.sessions = rows.length;
      for (const row of rows) {
        let parsed: unknown;
        try { parsed = JSON.parse(row.data) as unknown; }
        catch {
          issues.push({ code: "malformed-session-projection", severity: "blocking", source: "sessions", resourceId: row.id, detail: "projection JSON is malformed" });
          continue;
        }
        if (!isRecord(parsed)) {
          issues.push({ code: "malformed-session-projection", severity: "blocking", source: "sessions", resourceId: row.id, detail: "projection is not an object" });
          continue;
        }
        result.sessions.push({
          id: row.id,
          ...(nonEmpty(parsed.projectId) ? { projectId: parsed.projectId } : {}),
          ...(nonEmpty(parsed.spaceId) ? { spaceId: parsed.spaceId } : {}),
        });
      }
    }
    if (tables.has("agent_profiles")) {
      const rows = db.prepare("SELECT id FROM agent_profiles ORDER BY id").all() as Array<{ id: string }>;
      result.profileIds = rows.map((row) => row.id);
      source.counts.agentProfiles = result.profileIds.length;
    }
  } catch (error) {
    issues.push({
      code: "malformed-session-db",
      severity: "blocking",
      source: "sessions",
      detail: "Sessions database cannot be safely inventoried",
    });
  } finally {
    try { db?.close(); } catch { /* read-only inventory */ }
  }
  return result;
}

export function inventoryLegacyMigration(opts: LegacyInventoryOptions): LegacyMigrationInventory {
  let root = resolve(opts.dataDir);
  let unsafeRoot = false;
  try {
    unsafeRoot = !lstatSync(root).isDirectory();
    if (!unsafeRoot) root = realpathSync.native(root);
  } catch { unsafeRoot = true; }
  const files = {
    auth: join(root, "auth.json"),
    tenancy: join(root, "tenancy.json"),
    projects: join(root, "projects.json"),
    sessions: join(root, "sessions.db"),
    "profile-owners": opts.profileOwnersFile
      ? resolve(opts.profileOwnersFile)
      : join(root, "agent-profile-owners.json"),
  } satisfies Record<LegacySourceKind, string>;

  // Never follow a rejected data root merely to collect evidence.
  const sources = (Object.entries(files) as Array<[LegacySourceKind, string]>).map(([kind, file]) =>
    unsafeRoot ? { kind, path: relativeEvidencePath(root, file), present: false, counts: {} } as LegacySourceEvidence : sourceEvidence(kind, root, file));
  const byKind = Object.fromEntries(sources.map((source) => [source.kind, source])) as Record<LegacySourceKind, LegacySourceEvidence>;
  const issues: LegacyMigrationIssue[] = unsafeRoot ? [{ code: "unsafe-data-root", severity: "blocking", source: "tenancy", detail: "Data root must be an existing canonical directory" }] : [];
  const ownership: LegacyOwnershipProof[] = [];
  const adoptions: LegacyPlannedAdoption[] = [];
  const addOwnership = (proof: LegacyOwnershipProof): void => {
    const duplicate = ownership.find((entry) => entry.resourceKind === proof.resourceKind && entry.resourceId === proof.resourceId);
    if (duplicate && duplicate.ownerUserId !== proof.ownerUserId) {
      issues.push({
        code: "conflicting-owner-proof",
        severity: "blocking",
        source: proof.source,
        resourceId: proof.resourceId,
        detail: `${proof.resourceKind} has conflicting owners ${duplicate.ownerUserId} and ${proof.ownerUserId}`,
      });
      return;
    }
    if (!duplicate) ownership.push(proof);
  };
  const addAdoption = (adoption: LegacyPlannedAdoption): void => {
    const existing = adoptions.find((entry) => entry.kind === adoption.kind && entry.resourceId === adoption.resourceId);
    if (existing && existing.ownerUserId !== adoption.ownerUserId) {
      issues.push({
        code: "conflicting-adoption",
        severity: "blocking",
        source: adoption.source,
        resourceId: adoption.resourceId,
        detail: `${adoption.kind} would be assigned to both ${existing.ownerUserId} and ${adoption.ownerUserId}`,
      });
      return;
    }
    if (!existing) adoptions.push(adoption);
  };

  const knownUsers = new Set<string>();
  let verifiedLegacyOwner = false;

  const auth = parseJsonSource(byKind.auth, root, files.auth, issues);
  if (auth !== undefined) {
    try {
      const { stored } = parseLegacyAuthState(auth, LEGACY_OWNER_ALIAS);
      byKind.auth.counts.credentials = stored.credentials.length + (stored.passwordHash ? 1 : 0);
      byKind.auth.counts.sessions = stored.sessions.length;
      if (stored.passwordHash) {
        knownUsers.add(LEGACY_OWNER_ALIAS);
        verifiedLegacyOwner = true;
        addOwnership({ resourceKind: "user", resourceId: LEGACY_OWNER_ALIAS, ownerUserId: LEGACY_OWNER_ALIAS, source: "auth", proof: "verified-legacy-owner" });
      }
      for (const credential of stored.credentials) {
        knownUsers.add(credential.userId);
        if (credential.userId === LEGACY_OWNER_ALIAS) verifiedLegacyOwner = true;
      }
      // Sessions are revoked by migration, not used as evidence that a durable
      // user exists or that every unowned resource belongs to that user.
    } catch {
      issues.push({ code: "invalid-auth-shape", severity: "blocking", source: "auth", detail: "Auth state does not match a supported legacy format" });
    }
  }

  const spaces = new Map<string, ParsedSpace>();
  const spaceOwners = new Map<string, string>();
  const tenancy = parseJsonSource(byKind.tenancy, root, files.tenancy, issues);
  if (tenancy !== undefined) {
    if (!isRecord(tenancy) || !Array.isArray(tenancy.users) || !Array.isArray(tenancy.spaces) || !Array.isArray(tenancy.memberships)) {
      issues.push({ code: "invalid-tenancy-shape", severity: "blocking", source: "tenancy", detail: "tenancy.json does not match the legacy registry shape" });
    } else {
      byKind.tenancy.counts.users = tenancy.users.length;
      byKind.tenancy.counts.spaces = tenancy.spaces.length;
      byKind.tenancy.counts.memberships = tenancy.memberships.length;
      for (const row of tenancy.users) if (isRecord(row) && nonEmpty(row.id)) knownUsers.add(row.id);
      for (const row of tenancy.spaces) {
        if (!isRecord(row) || !nonEmpty(row.id)) {
          issues.push({ code: "invalid-space", severity: "blocking", source: "tenancy", detail: "space is missing an id" });
          continue;
        }
        if (spaces.has(row.id)) {
          issues.push({ code: "duplicate-space", severity: "blocking", source: "tenancy", resourceId: row.id, detail: "duplicate Space id" });
          continue;
        }
        spaces.set(row.id, { id: row.id });
      }
      for (const row of tenancy.memberships) {
        if (!isRecord(row) || !nonEmpty(row.userId) || !nonEmpty(row.spaceId) || !nonEmpty(row.role)) {
          issues.push({ code: "invalid-membership", severity: "blocking", source: "tenancy", detail: "membership row is incomplete" });
          continue;
        }
        if (!spaces.has(row.spaceId) || !knownUsers.has(row.userId)) {
          issues.push({ code: "orphan-membership", severity: "blocking", source: "tenancy", resourceId: `${row.spaceId}:${row.userId}`, detail: "membership references an unknown user or Space" });
          continue;
        }
        if (row.role === "owner") {
          const prior = spaceOwners.get(row.spaceId);
          if (prior && prior !== row.userId) {
            issues.push({ code: "multiple-space-owners", severity: "review", source: "tenancy", resourceId: row.spaceId, detail: `Space has multiple owner memberships (${prior}, ${row.userId})` });
          } else {
            spaceOwners.set(row.spaceId, row.userId);
          }
          addOwnership({ resourceKind: "space", resourceId: row.spaceId, ownerUserId: row.userId, source: "tenancy", proof: "explicit-space-owner" });
          if (row.userId === LEGACY_OWNER_ALIAS) verifiedLegacyOwner = true;
        }
      }
    }
  }

  if (verifiedLegacyOwner) {
    addAdoption({ kind: "user-alias", resourceId: LEGACY_OWNER_ALIAS, ownerUserId: LEGACY_OWNER_ALIAS, source: byKind.tenancy.present ? "tenancy" : "auth", reason: "legacy-alias" });
  }

  const projects: ParsedProject[] = [];
  const projectsRaw = parseJsonSource(byKind.projects, root, files.projects, issues);
  if (projectsRaw !== undefined) {
    if (!Array.isArray(projectsRaw)) {
      issues.push({ code: "invalid-project-registry", severity: "blocking", source: "projects", detail: "projects.json is not an array" });
    } else {
      byKind.projects.counts.projects = projectsRaw.length;
      const ids = new Set<string>();
      for (const row of projectsRaw) {
        if (!isRecord(row) || !nonEmpty(row.id) || !nonEmpty(row.path)) {
          issues.push({ code: "invalid-project", severity: "blocking", source: "projects", detail: "project row is missing id/path" });
          continue;
        }
        if (ids.has(row.id)) {
          issues.push({ code: "duplicate-project-id", severity: "blocking", source: "projects", resourceId: row.id, detail: "duplicate project id" });
          continue;
        }
        ids.add(row.id);
        const remote = isRecord(row.remote) && nonEmpty(row.remote.connectionId) ? row.remote.connectionId : undefined;
        const project: ParsedProject = {
          id: row.id,
          path: row.path,
          ...(nonEmpty(row.spaceId) ? { spaceId: row.spaceId } : {}),
          ...(remote ? { remoteConnectionId: remote } : {}),
        };
        projects.push(project);
      }
      const keyMap = new Map<string, ParsedProject>();
      for (const project of projects) {
        const key = pathKey(project);
        const other = keyMap.get(key);
        if (other && other.id !== project.id) {
          issues.push({ code: "duplicate-project-root", severity: "blocking", source: "projects", resourceId: project.id, detail: `same root as project ${other.id}` });
        } else keyMap.set(key, project);
      }
      for (let i = 0; i < projects.length; i++) for (let j = i + 1; j < projects.length; j++) {
        const a = projects[i]!, b = projects[j]!;
        if (pathKey(a) !== pathKey(b) && overlappingLocalPaths(a, b)) {
          issues.push({ code: "overlapping-project-roots", severity: "review", source: "projects", resourceId: `${a.id}:${b.id}`, detail: `${a.path} overlaps ${b.path}` });
        }
      }
    }
  }

  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const projectOwners = new Map<string, string>();
  for (const project of projects) {
    if (project.spaceId) {
      if (!spaces.has(project.spaceId)) {
        issues.push({ code: "project-missing-space", severity: "blocking", source: "projects", resourceId: project.id, detail: `unknown Space ${project.spaceId}` });
        continue;
      }
      const owner = spaceOwners.get(project.spaceId);
      if (!owner) {
        issues.push({ code: "project-space-without-owner", severity: "blocking", source: "projects", resourceId: project.id, detail: `Space ${project.spaceId} has no proven owner` });
        continue;
      }
      projectOwners.set(project.id, owner);
      addOwnership({ resourceKind: "project", resourceId: project.id, ownerUserId: owner, source: "projects", proof: "project-space-owner" });
    } else if (verifiedLegacyOwner && knownUsers.size === 1) {
      projectOwners.set(project.id, LEGACY_OWNER_ALIAS);
      addOwnership({ resourceKind: "project", resourceId: project.id, ownerUserId: LEGACY_OWNER_ALIAS, source: "projects", proof: "verified-legacy-owner" });
      addAdoption({ kind: "project", resourceId: project.id, ownerUserId: LEGACY_OWNER_ALIAS, source: "projects", reason: "verified-legacy-owner" });
    } else {
      issues.push({ code: "ownerless-project", severity: "blocking", source: "projects", resourceId: project.id, detail: "project has no Space and historical owner is unproven" });
    }
  }

  const sqlite = inspectSqlite(byKind.sessions, files.sessions, issues);
  for (const session of sqlite.sessions) {
    if (!session.projectId) {
      issues.push({ code: "session-without-project", severity: "blocking", source: "sessions", resourceId: session.id, detail: "session projection has no projectId" });
      continue;
    }
    const project = projectMap.get(session.projectId);
    if (!project) {
      issues.push({ code: "session-missing-project", severity: "blocking", source: "sessions", resourceId: session.id, detail: `unknown project ${session.projectId}` });
      continue;
    }
    if (session.spaceId && (!project.spaceId || session.spaceId !== project.spaceId)) {
      issues.push({ code: "session-space-conflict", severity: "blocking", source: "sessions", resourceId: session.id, detail: `session Space ${session.spaceId} disagrees with project Space ${project.spaceId}` });
      continue;
    }
    const owner = projectOwners.get(project.id);
    if (!owner) {
      issues.push({ code: "session-owner-unproven", severity: "blocking", source: "sessions", resourceId: session.id, detail: `project ${project.id} has no proven owner` });
      continue;
    }
    addOwnership({ resourceKind: "session", resourceId: session.id, ownerUserId: owner, source: "sessions", proof: project.spaceId ? "project-space-owner" : "verified-legacy-owner" });
    if (!session.spaceId) {
      addAdoption({ kind: "session", resourceId: session.id, ownerUserId: owner, source: "sessions", reason: project.spaceId ? "project-space-owner" : "verified-legacy-owner" });
    }
  }

  const profileOwnersRaw = parseJsonSource(byKind["profile-owners"], root, files["profile-owners"], issues);
  const explicitProfileOwners = new Map<string, string>();
  if (profileOwnersRaw !== undefined) {
    if (!isRecord(profileOwnersRaw) || profileOwnersRaw.version !== 1 || !isRecord(profileOwnersRaw.owners)) {
      issues.push({ code: "invalid-profile-owners", severity: "blocking", source: "profile-owners", detail: "profile owner sidecar has unknown shape" });
    } else {
      const entries = Object.entries(profileOwnersRaw.owners);
      byKind["profile-owners"].counts.owners = entries.length;
      for (const [profileId, owner] of entries) {
        if (!profileId || !nonEmpty(owner)) {
          issues.push({ code: "invalid-profile-owner", severity: "blocking", source: "profile-owners", resourceId: profileId || undefined, detail: "profile ownership row is incomplete" });
          continue;
        }
        explicitProfileOwners.set(profileId, owner);
      }
    }
  }
  const knownProfiles = new Set(sqlite.profileIds);
  for (const [profileId, owner] of explicitProfileOwners) {
    if (!knownProfiles.has(profileId)) {
      issues.push({ code: "orphan-profile-owner", severity: "blocking", source: "profile-owners", resourceId: profileId, detail: "owner sidecar references a missing agent profile" });
      continue;
    }
    if (!knownUsers.has(owner)) {
      issues.push({ code: "unknown-profile-owner", severity: "blocking", source: "profile-owners", resourceId: profileId, detail: `profile owner ${owner} is not a known legacy user` });
      continue;
    }
    addOwnership({ resourceKind: "agent-profile", resourceId: profileId, ownerUserId: owner, source: "profile-owners", proof: "explicit-profile-owner" });
  }
  for (const profileId of sqlite.profileIds) {
    if (explicitProfileOwners.has(profileId)) continue;
    if (verifiedLegacyOwner && knownUsers.size === 1) {
      addOwnership({ resourceKind: "agent-profile", resourceId: profileId, ownerUserId: LEGACY_OWNER_ALIAS, source: "profile-owners", proof: "verified-legacy-owner" });
      addAdoption({ kind: "agent-profile", resourceId: profileId, ownerUserId: LEGACY_OWNER_ALIAS, source: "profile-owners", reason: "verified-legacy-owner" });
    } else {
      issues.push({ code: "profile-owner-unproven", severity: "blocking", source: "profile-owners", resourceId: profileId, detail: "unmapped legacy profile has no verified historical owner" });
    }
  }

  if (!unsafeRoot) for (const source of sources) {
    const again = sourceEvidence(source.kind, root, files[source.kind]);
    const fingerprint = (entry: LegacySourceEvidence) => canonicalLegacyJson({
      present: entry.present, sha256: entry.sha256, bytes: entry.bytes, sidecars: entry.sidecars,
    });
    if (fingerprint(source) !== fingerprint(again) || (source.present && !source.sha256)) {
      issues.push({ code: "source-changed", severity: "blocking", source: source.kind, detail: "Source is unsafe, unreadable or changed during inventory" });
    }
  }

  for (const source of sources) source.counts.issues = issues.filter((issue) => issue.source === source.kind).length;
  ownership.sort((a, b) => `${a.resourceKind}:${a.resourceId}`.localeCompare(`${b.resourceKind}:${b.resourceId}`));
  adoptions.sort((a, b) => `${a.kind}:${a.resourceId}`.localeCompare(`${b.kind}:${b.resourceId}`));
  issues.sort((a, b) => `${a.source}:${a.resourceId ?? ""}:${a.code}`.localeCompare(`${b.source}:${b.resourceId ?? ""}:${b.code}`));

  const digestMaterial = {
    schemaVersion: 1,
    legacyOwnerAlias: LEGACY_OWNER_ALIAS,
    sources: sources.map(({ kind, path, present, sha256: hash, bytes, counts, sidecars }) => ({ kind, path, present, sha256: hash, bytes, counts, sidecars })),
    ownership,
    plannedAdoptions: adoptions,
    issues,
  };
  return {
    schemaVersion: 1,
    legacyOwnerAlias: LEGACY_OWNER_ALIAS,
    sourceRoot: root,
    sources,
    ownership,
    plannedAdoptions: adoptions,
    issues,
    safeToStage: !issues.some((issue) => issue.severity === "blocking"),
    inventoryDigest: sha256(canonicalLegacyJson(digestMaterial)),
  };
}
