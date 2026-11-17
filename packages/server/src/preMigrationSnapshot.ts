// A copy of each canonical database whose schema this server version is about
// to migrate, taken under the data-directory writer lease before anything
// opens it for writing. Updates are forward-only (an older control plane
// refuses a newer database), so this copy is what takes an update back,
// whichever way the update arrived (npm, archive, Homebrew, Docker, checkout).
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_PLANE_FILE, pendingControlPlaneMigrations } from "@polyth/control-plane";
import { pendingSessionMigrations } from "@polyth/session";

/** Directory inside the data directory that holds the snapshots. */
export const PRE_MIGRATION_DIR = "pre-migration";
/** Snapshots kept per database; older ones are removed. */
export const PRE_MIGRATION_KEEP = 3;
/** Free space a snapshot must leave behind, beyond the copy itself. */
const FREE_SPACE_RESERVE = 512 * 1024 * 1024;

export interface MigrationDatabase {
  label: string;
  file: string;
  pending: (file: string) => number;
}

export interface SnapshotResult {
  label: string;
  pending: number;
  snapshot?: string;
  skipped?: "no-space" | "failed";
}

export function canonicalDatabases(dataDir: string): MigrationDatabase[] {
  return [
    { label: "control-plane", file: join(dataDir, "control-plane", CONTROL_PLANE_FILE), pending: pendingControlPlaneMigrations },
    { label: "sessions", file: join(dataDir, "sessions.db"), pending: pendingSessionMigrations },
  ];
}

const fileSize = (path: string): number => { try { return statSync(path).size; } catch { return 0; } };

/** ISO time without characters some filesystems refuse. */
const stamp = (time: number): string => new Date(time).toISOString().replace(/[:.]/g, "-");

/**
 * Snapshots the databases with pending migrations into
 * `<dataDir>/pre-migration/<label>-before-<version>-<time>.sqlite`. Never
 * throws: a failed or skipped snapshot is logged and the server starts.
 */
export function snapshotBeforeMigrations(dataDir: string, options: {
  version: string;
  databases?: MigrationDatabase[];
  now?: () => number;
  freeBytes?: (dir: string) => number;
  log?: (message: string) => void;
}): SnapshotResult[] {
  const log = options.log ?? ((message: string) => console.warn(message));
  const freeBytes = options.freeBytes ?? ((dir: string) => {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  });
  const results: SnapshotResult[] = [];
  for (const database of options.databases ?? canonicalDatabases(dataDir)) {
    if (!existsSync(database.file)) continue;
    let pending: number;
    try {
      pending = database.pending(database.file);
    } catch (error) {
      // The owner's own open reports a damaged database; nothing to copy here.
      log(`[polyth] pre-migration snapshot of ${database.label} skipped: ${(error as Error).message}`);
      continue;
    }
    if (pending <= 0) continue;
    const dir = join(dataDir, PRE_MIGRATION_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const size = fileSize(database.file) + fileSize(`${database.file}-wal`);
    if (freeBytes(dir) < size + FREE_SPACE_RESERVE) {
      log(`[polyth] pre-migration snapshot of ${database.label} skipped: not enough free space for ${Math.ceil(size / 1_048_576)} MB; ${pending} migration(s) will run without a copy`);
      results.push({ label: database.label, pending, skipped: "no-space" });
      continue;
    }
    const safeVersion = options.version.replace(/[^0-9A-Za-z.-]/g, "_");
    const target = join(dir, `${database.label}-before-${safeVersion}-${stamp((options.now ?? Date.now)())}.sqlite`);
    const partial = `${target}.partial`;
    const started = Date.now();
    try {
      const db = new DatabaseSync(database.file, { readOnly: true });
      try {
        db.prepare("VACUUM INTO ?").run(partial);
      } finally {
        db.close();
      }
      chmodSync(partial, 0o600);
      renameSync(partial, target);
    } catch (error) {
      rmSync(partial, { force: true });
      log(`[polyth] pre-migration snapshot of ${database.label} failed: ${(error as Error).message}`);
      results.push({ label: database.label, pending, skipped: "failed" });
      continue;
    }
    log(`[polyth] ${database.label}: ${pending} schema migration(s) pending; copy saved to ${target} in ${Date.now() - started} ms`);
    pruneSnapshots(dir, database.label);
    results.push({ label: database.label, pending, snapshot: target });
  }
  return results;
}

function pruneSnapshots(dir: string, label: string): void {
  const prefix = `${label}-before-`;
  const snapshots = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite"))
    .map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  for (const old of snapshots.slice(PRE_MIGRATION_KEEP)) rmSync(join(dir, old.name), { force: true });
}
