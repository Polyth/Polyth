import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ControlPlane } from "@polyth/control-plane";

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const recovery = (): never => {
  throw Object.assign(new Error("Agent Profile ownership requires operator recovery"), { code: "recovery-required" });
};

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) recovery();
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    if ((cause as { code?: unknown } | null)?.code === "recovery-required") throw cause;
    recovery();
  }
}

/**
 * Canonical runtime invariant for account-owned Agent Profiles. Profiles are
 * deliberately not Space resources: one account may use the same profile in
 * multiple Spaces. The legacy owner sidecar therefore remains the ownership
 * projection, but canonical runtime accepts it only when it is complete,
 * one-to-one with the durable profile rows, and points at active canonical
 * users. This makes the historical `unmapped -> usr_owner` fallback unreachable
 * after canonical cutover.
 */
export function verifyCanonicalAgentProfileOwnership(opts: {
  dataDir: string;
  control: ControlPlane;
}): void {
  const sessionFile = join(opts.dataDir, "sessions.db");
  const ownersFile = join(opts.dataDir, "agent-profile-owners.json");

  if (!regularFile(sessionFile)) {
    if (existsSync(ownersFile)) recovery();
    return;
  }

  let db: DatabaseSync | undefined;
  let profileIds: string[] = [];
  try {
    db = new DatabaseSync(sessionFile, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const hasProfiles = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_profiles'",
    ).get();
    if (hasProfiles) {
      profileIds = (db.prepare("SELECT id FROM agent_profiles ORDER BY id").all() as Array<{ id: unknown }>).map((row) => {
        if (typeof row.id !== "string" || !PROFILE_ID.test(row.id)) recovery();
        return row.id;
      });
    }
  } catch (cause) {
    if ((cause as { code?: unknown } | null)?.code === "recovery-required") throw cause;
    recovery();
  } finally {
    try { db?.close(); } catch { /* preserve preflight result */ }
  }

  const hasOwners = regularFile(ownersFile);
  if (profileIds.length === 0) {
    if (!hasOwners) return;
  } else if (!hasOwners) {
    recovery();
  }

  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(ownersFile, "utf8")) as unknown; }
  catch { recovery(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) recovery();
  const value = parsed as { version?: unknown; owners?: unknown };
  if (value.version !== 1 || !value.owners || typeof value.owners !== "object" || Array.isArray(value.owners)) recovery();
  const owners = value.owners as Record<string, unknown>;
  const ownerIds = Object.keys(owners).sort();
  if (ownerIds.length !== profileIds.length || ownerIds.some((id, index) => id !== profileIds[index])) recovery();

  for (const profileId of profileIds) {
    const owner = owners[profileId];
    if (typeof owner !== "string" || !USER_ID.test(owner)) recovery();
    const active = opts.control.get<{ id: string }>(
      `SELECT u.id
         FROM users u
         JOIN principals p ON p.id=u.id
        WHERE u.id=? AND p.kind='user' AND p.status='active'`,
      owner,
    );
    if (!active) recovery();
  }
}
