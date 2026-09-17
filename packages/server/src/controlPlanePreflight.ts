import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  recoveryRequired,
  type InstallationState,
} from "@polyth/control-plane";

const STATES = new Set<InstallationState>([
  "uninitialized",
  "claimed",
  "configuring",
  "ready",
  "recovery",
]);

const regularFile = (path: string): boolean => {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw recoveryRequired();
  }
};

export type CanonicalInstallationPreflight =
  | { kind: "absent" }
  | { kind: "existing"; id: string; state: InstallationState };

/**
 * Read-only discriminator used before the process owns the data-directory
 * writer lease. It never creates directories, opens SQLite read/write, applies
 * migrations or changes the installation sentinel. Full validation still runs
 * through openControlPlane() after the lease is held.
 */
export function inspectCanonicalInstallation(dataDir: string): CanonicalInstallationPreflight {
  const root = join(dataDir, "control-plane");
  const sentinel = join(root, "installation.json");
  const file = join(root, "control.sqlite");
  const hasSentinel = regularFile(sentinel);
  const hasDatabase = regularFile(file);
  if (!hasSentinel && !hasDatabase) return { kind: "absent" };
  if (!hasSentinel || !hasDatabase) throw recoveryRequired();

  let sentinelValue: unknown;
  try { sentinelValue = JSON.parse(readFileSync(sentinel, "utf8")) as unknown; }
  catch { throw recoveryRequired(); }
  const marker = sentinelValue as { version?: unknown; id?: unknown } | null;
  if (!marker || marker.version !== 1 || typeof marker.id !== "string"
    || !/^[a-f0-9-]{36}$/.test(marker.id)) throw recoveryRequired();

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok") throw recoveryRequired();
    const row = db.prepare(
      "SELECT id,state FROM installation WHERE singleton=1",
    ).get() as { id?: unknown; state?: unknown } | undefined;
    if (!row || row.id !== marker.id || typeof row.state !== "string"
      || !STATES.has(row.state as InstallationState)) throw recoveryRequired();
    return { kind: "existing", id: marker.id, state: row.state as InstallationState };
  } catch (cause) {
    if ((cause as { code?: unknown } | null)?.code === "recovery-required") throw cause;
    throw recoveryRequired();
  } finally {
    try { db?.close(); } catch { /* preserve preflight result */ }
  }
}
