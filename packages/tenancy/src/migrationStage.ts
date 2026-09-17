// Operator-only, offline preparation. This journal is a migration checkpoint,
// NEVER a second user/session authority. No function here activates a server or
// changes a source file. The capsule covers identity migration inputs, not all
// installation assets, encryption keys, attachments or project working trees.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLegacyJson, digestLegacyFile, legacyFileError, readLegacyFile, LEGACY_JSON_MAX_BYTES } from "./legacyFiles.ts";
import {
  inventoryLegacyMigration, type LegacyInventoryOptions, type LegacyMigrationInventory,
  type LegacySourceEvidence, type LegacySourceKind,
} from "./legacyMigration.ts";

const JOURNAL = "migration.sqlite";
// Stable capsule names, not paths taken from an imported manifest.
const NAMES = {
  auth: "auth.json", tenancy: "tenancy.json", projects: "projects.json",
  sessions: "sessions.db", "profile-owners": "agent-profile-owners.json",
} as const satisfies Record<LegacySourceKind, string>;
const kinds = Object.keys(NAMES) as LegacySourceKind[];
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
function fail(code: string): never { throw legacyFileError(code); }
const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export interface MigrationStageArtifact {
  kind: LegacySourceKind;
  status: "absent" | "blocked" | "copied";
  file: string;
  sha256?: string;
  bytes?: number;
}
export interface MigrationStageManifest {
  schemaVersion: 1;
  id: string;
  scope: "identity-migration-inputs";
  status: "copying" | "verified" | "quarantined";
  createdAt: number;
  inventory: LegacyMigrationInventory;
  artifacts: MigrationStageArtifact[];
  manifestDigest: string;
}
export interface StageLegacyMigrationOptions extends LegacyInventoryOptions {
  stageDir: string;
  /** Required operator acknowledgement of a particular dry-run, not latest. */
  expectedInventoryDigest: string;
  /** Synchronous operator progress, no credentials or source contents. */
  onArtifact?: (artifact: Readonly<MigrationStageArtifact>) => void;
}
interface StageRow { id: string; status: MigrationStageManifest["status"]; created_at: number; inventory: string }

function directory(path: string, privateOnly = false): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (privateOnly && process.platform !== "win32" && (stat.mode & 0o077) !== 0)) fail("unsafe-stage-directory");
  return realpathSync.native(path);
}
function sync(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) fail("unsafe-stage-file");
}
function regularOrAbsent(path: string): boolean {
  try { privateFile(path); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
function checkStageRoot(root: string): void {
  const rootNames = new Set([JOURNAL, `${JOURNAL}-journal`, "sources"]);
  for (const name of readdirSync(root)) {
    if (!rootNames.has(name)) fail("unexpected-stage-content");
    if (name === "sources") directory(join(root, name), true);
    else if (name === JOURNAL) privateFile(join(root, name));
    else regularOrAbsent(join(root, name)); // another writer can finish its rollback journal
  }
}
function checkStageLayout(root: string, allowIncomplete: boolean): void {
  checkStageRoot(root);
  const sources = join(root, "sources");
  try {
    directory(sources, true);
    const allowed = new Set<string>(Object.values(NAMES));
    // Interrupted VACUUM INTO can leave a private destination rollback journal.
    if (allowIncomplete) allowed.add("sessions.db-journal");
    for (const name of readdirSync(sources)) {
      if (!allowed.has(name)) fail("unexpected-stage-content");
      privateFile(join(sources, name));
    }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !allowIncomplete) throw e; }
}
function openJournal(root: string, fresh: boolean, inventory?: LegacyMigrationInventory): DatabaseSync {
  const file = join(root, JOURNAL);
  if (fresh) closeSync(openSync(file, "wx", 0o600));
  else privateFile(file);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL");
    if (fresh) {
      db.exec("BEGIN IMMEDIATE");
      db.exec(`CREATE TABLE stage (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1),
        id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('copying','verified','quarantined')),
        created_at INTEGER NOT NULL, inventory TEXT NOT NULL CHECK(json_valid(inventory))
      ) STRICT;
      CREATE TABLE artifacts (
        kind TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('absent','blocked','copied')),
        file TEXT NOT NULL UNIQUE, sha256 TEXT, bytes INTEGER
      ) STRICT;`);
      db.prepare("INSERT INTO stage VALUES(1,1,?,'copying',?,?)").run(randomUUID(), Date.now(), canonicalLegacyJson(inventory));
      db.exec("COMMIT");
      sync(root);
    }
    if ((db.prepare("PRAGMA quick_check").get() as {quick_check: string}).quick_check !== "ok") fail("invalid-stage-journal");
    return db;
  } catch (cause) { db.close(); throw cause; }
}
function manifest(db: DatabaseSync): MigrationStageManifest {
  const row = db.prepare("SELECT id,status,created_at,inventory FROM stage WHERE singleton=1 AND version=1").get() as StageRow | undefined;
  if (!row || !/^[a-f0-9-]{36}$/.test(row.id) || !["copying", "verified", "quarantined"].includes(row.status)
    || !Number.isSafeInteger(row.created_at) || row.created_at < 0) fail("invalid-stage-journal");
  const raw = db.prepare("SELECT kind,status,file,sha256,bytes FROM artifacts ORDER BY kind").all() as Array<{kind: LegacySourceKind; status: MigrationStageArtifact["status"]; file: string; sha256: string|null; bytes: number|null}>;
  const artifacts: MigrationStageArtifact[] = raw.map(({kind,status,file,sha256,bytes}) => ({
    kind, status, file, ...(sha256 !== null ? {sha256} : {}), ...(bytes !== null ? {bytes} : {}),
  }));
  const inventory = JSON.parse(row.inventory) as LegacyMigrationInventory;
  const material = { schemaVersion: 1 as const, id: row.id, scope: "identity-migration-inputs" as const,
    status: row.status, createdAt: row.created_at, inventory, artifacts };
  return { ...material, manifestDigest: sha(canonicalLegacyJson(material)) };
}
function checkArtifact(root: string, artifact: MigrationStageArtifact): void {
  if (!kinds.includes(artifact.kind) || artifact.file !== `sources/${NAMES[artifact.kind]}`
    || !["absent", "blocked", "copied"].includes(artifact.status)) fail("invalid-stage-artifact");
  const file = join(root, "sources", NAMES[artifact.kind]);
  if (artifact.status !== "copied") {
    if (artifact.sha256 !== undefined || artifact.bytes !== undefined) fail("invalid-stage-artifact");
    if (regularOrAbsent(file)) fail("unexpected-stage-content");
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") || !Number.isSafeInteger(artifact.bytes)
    || artifact.bytes! < 0) fail("invalid-stage-artifact");
  privateFile(file);
  const digest = digestLegacyFile(file);
  if (digest.sha256 !== artifact.sha256 || digest.bytes !== artifact.bytes) fail("stage-artifact-changed");
}
function sourcePath(inventory: LegacyMigrationInventory, source: LegacySourceEvidence, opts: LegacyInventoryOptions): string {
  return source.kind === "profile-owners" && opts.profileOwnersFile
    ? resolve(opts.profileOwnersFile) : join(inventory.sourceRoot, NAMES[source.kind]);
}
function captureDatabase(source: string, target: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { if (!lstatSync(`${source}${suffix}`).isFile()) fail("unsafe-source-file"); }
    catch (cause) { if (!suffix || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  closeSync(openSync(target, "wx", 0o600));
  const input = new DatabaseSync(source, {readOnly: true});
  try {
    input.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000");
    if ((input.prepare("PRAGMA quick_check").get() as {quick_check: string}).quick_check !== "ok") fail("invalid-source-database");
    // Supported by the minimum Node/SQLite version; includes committed WAL and
    // every table, not just the known projections. Destination is precreated600.
    input.prepare("VACUUM INTO ?").run(target);
  } finally { input.close(); }
  const output = new DatabaseSync(target, {readOnly: true});
  try {
    if ((output.prepare("PRAGMA quick_check").get() as {quick_check: string}).quick_check !== "ok") fail("invalid-stage-database");
  } finally { output.close(); }
  sync(target);
}

/** Run with the installation stopped. Before/after fingerprints reject drift,
 * but are not an OS lock over arbitrary legacy JSON writers. On SIGKILL the
 * journal transaction rolls back; a retry discards only its uncommitted copies.
 * Completed stages are verified and returned unchanged, never recopied. */
export function stageLegacyMigration(opts: StageLegacyMigrationOptions): MigrationStageManifest {
  if (!/^[a-f0-9]{64}$/.test(opts.expectedInventoryDigest)) fail("invalid-inventory-digest");
  const inventory = inventoryLegacyMigration(opts);
  if (inventory.inventoryDigest !== opts.expectedInventoryDigest) fail("source-changed");
  if (inventory.issues.some(issue => issue.code === "unsafe-data-root")) fail("unsafe-source-root");
  const parent = directory(dirname(resolve(opts.stageDir)));
  const root = join(parent, basename(resolve(opts.stageDir)));
  if (inside(inventory.sourceRoot, root) || inside(root, inventory.sourceRoot)) fail("stage-overlaps-source");
  for (const source of inventory.sources) if (inside(root, sourcePath(inventory, source, opts))) fail("stage-overlaps-source");
  let fresh = false;
  try { mkdirSync(root, {mode: 0o700}); fresh = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  directory(root, true);
  if (fresh) sync(parent);
  if (!fresh) checkStageRoot(root);
  let db: DatabaseSync | undefined;
  let transaction = false;
  try {
    db = openJournal(root, fresh, inventory);
    db.exec("BEGIN IMMEDIATE"); transaction = true;
    const before = manifest(db);
    checkStageLayout(root, before.status === "copying");
    if (canonicalLegacyJson(before.inventory) !== canonicalLegacyJson(inventory)) fail("stage-source-mismatch");
    if (before.status !== "copying") {
      checkStageLayout(root, false);
      if (before.artifacts.length !== kinds.length) fail("invalid-stage-journal");
      for (const artifact of before.artifacts) checkArtifact(root, artifact);
      db.exec("COMMIT"); transaction = false;
      return before;
    }
    if (before.artifacts.length !== 0) fail("invalid-stage-journal");
    const folder = join(root, "sources");
    try { mkdirSync(folder, {mode:0o700}); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    directory(folder, true);
    checkStageLayout(root, true);
    // Only an initialized, matching, incomplete stage owns these fixed paths.
    for (const name of [...Object.values(NAMES), "sessions.db-journal"]) {
      const file = join(folder, name);
      if (regularOrAbsent(file)) unlinkSync(file);
    }
    const insert = db.prepare("INSERT INTO artifacts(kind,status,file,sha256,bytes) VALUES(?,?,?,?,?)");
    let blocked = false;
    for (const source of inventory.sources) {
      const target = join(folder, NAMES[source.kind]);
      const artifact: MigrationStageArtifact = {kind:source.kind, file:`sources/${NAMES[source.kind]}`, status:"absent"};
      if (source.present) {
        // Unsafe/unreadable inputs stay visible as missing backup coverage.
        if (!source.sha256 || (source.kind !== "sessions" && (source.bytes ?? 0) > LEGACY_JSON_MAX_BYTES)
          || inventory.issues.some(issue => issue.source === source.kind
          && ["unsafe-source-file", "source-changed", "malformed-session-db"].includes(issue.code))) {
          artifact.status = "blocked"; blocked = true;
        } else {
          const input = sourcePath(inventory, source, opts);
          if (source.kind === "sessions") captureDatabase(input, target);
          else {
            const read = readLegacyFile(input);
            if (!read.data || read.digest.sha256 !== source.sha256) fail("source-changed");
            writeFileSync(target, read.data, {flag:"wx", mode:0o600}); sync(target);
          }
          const digest = digestLegacyFile(target);
          if (!digest.sha256 || digest.bytes === undefined) fail("invalid-stage-artifact");
          artifact.status = "copied"; artifact.sha256 = digest.sha256; artifact.bytes = digest.bytes;
        }
      }
      insert.run(artifact.kind, artifact.status, artifact.file, artifact.sha256 ?? null, artifact.bytes ?? null);
      opts.onArtifact?.(Object.freeze({...artifact}));
    }
    if (inventoryLegacyMigration(opts).inventoryDigest !== opts.expectedInventoryDigest) fail("source-changed");
    // Review-only topology is safe to inventory, NOT safe for unattended apply.
    const status = blocked || inventory.issues.length > 0 ? "quarantined" : "verified";
    db.prepare("UPDATE stage SET status=? WHERE singleton=1").run(status);
    sync(folder); sync(root);
    const result = manifest(db);
    db.exec("COMMIT"); transaction = false;
    return result;
  } catch (cause) {
    if (transaction) { try { db?.exec("ROLLBACK"); } catch { /* preserve failure */ } }
    // Never include OS/SQLite messages or paths containing source material.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code && /^(?:stage-|source-|unsafe-|invalid-|unexpected-|unreadable-)/.test(code)) throw legacyFileError(code);
    throw legacyFileError("stage-incomplete");
  } finally { db?.close(); }
}

/** Verifies a capsule against a separately recorded digest. This proves byte
 * integrity, not authenticity or permission to install it. No source reread. */
export function verifyMigrationStage(stageDir: string, expectedManifestDigest: string): MigrationStageManifest {
  if (!/^[a-f0-9]{64}$/.test(expectedManifestDigest)) fail("invalid-manifest-digest");
  let db: DatabaseSync | undefined;
  try {
    const root = directory(resolve(stageDir), true);
    checkStageLayout(root, false);
    privateFile(join(root, JOURNAL));
    db = new DatabaseSync(join(root, JOURNAL), {readOnly:true});
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    if ((db.prepare("PRAGMA quick_check").get() as {quick_check: string}).quick_check !== "ok") fail("invalid-stage-journal");
    const result = manifest(db);
    if (result.status === "copying" || result.artifacts.length !== kinds.length
      || new Set(result.artifacts.map(row => row.kind)).size !== kinds.length) fail("stage-incomplete");
    if (result.manifestDigest !== expectedManifestDigest) fail("stage-manifest-changed");
    for (const artifact of result.artifacts) checkArtifact(root, artifact);
    return result;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code && /^(?:stage-|unsafe-|invalid-|unexpected-)/.test(code)) throw legacyFileError(code);
    throw legacyFileError("invalid-stage-journal");
  } finally { db?.close(); }
}
