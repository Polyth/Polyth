import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { TunnelDeviceDto } from "@polyth/contracts";
import { GRANT_PROFILE_PRESETS, REMOTE_CAPABILITY, normalizeDeviceGrants, type GrantProfileId } from "@polyth/contracts";

const LEGACY_OWNER_USER_ID = "usr_owner";

const unknownPairing = (): Error =>
  Object.assign(new Error("unknown pairing"), { code: "not-found" });

export interface TunnelDeviceRecord {
  id: string;
  endpointId: string;
  ownerUserId: string;
  label: string;
  platform: string | null;
  model: string | null;
  appVersion: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  grantRevision: number;
  pairedVia: string;
  lastTransport: string | null;
  grants: string[];
  pairingId: string | null;
  pairingState: "pending" | "host-acknowledged" | "active" | "failed";
}

export function grantsForProfile(profile: GrantProfileId): string[] {
  const grants = [...GRANT_PROFILE_PRESETS[profile]];
  // Voice input is an interactive capability: it belongs with session
  // messaging/control, not the read-only observe profile. Keep the canonical
  // profile contract stable while allowing the tunnel layer to opt into a
  // package-owned capability that older servers did not know about.
  if (profile !== "observe") grants.push(REMOTE_CAPABILITY.dictationUse);
  return normalizeDeviceGrants(grants);
}

export function fingerprintEndpoint(endpointId: string): string {
  return endpointId.slice(0, 4) + "…" + endpointId.slice(-4);
}

export class TunnelStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tunnel_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tunnel_device (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_USER_ID}',
        label TEXT NOT NULL,
        platform TEXT,
        model TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        grant_revision INTEGER NOT NULL,
        paired_via TEXT NOT NULL,
        last_transport TEXT
      );
      CREATE TABLE IF NOT EXISTS tunnel_device_grant (
        device_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        granted_by TEXT NOT NULL,
        PRIMARY KEY (device_id, capability),
        FOREIGN KEY (device_id) REFERENCES tunnel_device(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tunnel_pairing_owner (
        pairing_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tunnel_audit (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        device_id TEXT,
        connection_id TEXT,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );
    `);
    this.db.exec("INSERT OR IGNORE INTO tunnel_meta(key, value) VALUES ('schema', 1)");
    const columns = new Set((this.db.prepare("PRAGMA table_info(tunnel_device)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("owner_user_id")) {
      this.db.exec(`ALTER TABLE tunnel_device ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '${LEGACY_OWNER_USER_ID}'`);
    }
    if (!columns.has("pairing_id")) this.db.exec("ALTER TABLE tunnel_device ADD COLUMN pairing_id TEXT");
    if (!columns.has("pairing_state")) this.db.exec("ALTER TABLE tunnel_device ADD COLUMN pairing_state TEXT NOT NULL DEFAULT 'active'");
    this.db.prepare("UPDATE tunnel_device SET owner_user_id = ? WHERE owner_user_id IS NULL OR owner_user_id = ''").run(LEGACY_OWNER_USER_ID);
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tunnel_device_pairing_id ON tunnel_device(pairing_id) WHERE pairing_id IS NOT NULL");
    this.db.exec("CREATE INDEX IF NOT EXISTS tunnel_device_owner ON tunnel_device(owner_user_id)");
    this.db.exec("UPDATE tunnel_meta SET value = 3 WHERE key = 'schema'");
  }

  close(): void {
    this.db.close();
  }

  audit(eventType: string, opts: { deviceId?: string; connectionId?: string; metadata?: Record<string, unknown> } = {}): void {
    this.db.prepare(
      "INSERT INTO tunnel_audit(id, event_type, device_id, connection_id, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      randomBytes(16).toString("hex"),
      eventType,
      opts.deviceId ?? null,
      opts.connectionId ?? null,
      Date.now(),
      JSON.stringify(opts.metadata ?? {}),
    );
  }

  claimPairing(pairingId: string, userId: string): void {
    if (!pairingId || !userId) {
      throw Object.assign(new Error("pairing id and user id are required"), { code: "invalid-input" });
    }
    const existing = this.pairingOwner(pairingId);
    if (existing && existing !== userId) throw unknownPairing();
    this.db.prepare(
      "INSERT OR IGNORE INTO tunnel_pairing_owner(pairing_id, user_id, created_at) VALUES (?, ?, ?)",
    ).run(pairingId, userId, Date.now());
    if (this.pairingOwner(pairingId) !== userId) throw unknownPairing();
  }

  pairingOwner(pairingId: string): string | undefined {
    const row = this.db.prepare("SELECT user_id FROM tunnel_pairing_owner WHERE pairing_id = ?").get(pairingId) as
      | { user_id: string }
      | undefined;
    return row?.user_id;
  }

  releasePairingOwner(pairingId: string): void {
    this.db.prepare("DELETE FROM tunnel_pairing_owner WHERE pairing_id = ?").run(pairingId);
  }

  commitDevice(input: {
    endpointId: string;
    ownerUserId?: string;
    label: string;
    platform?: string;
    model?: string;
    appVersion?: string;
    grants: readonly string[];
    pairedVia: string;
  }): TunnelDeviceRecord {
    const device = this.prepareDevice({
      ...input,
      ownerUserId: input.ownerUserId ?? LEGACY_OWNER_USER_ID,
      pairingId: `legacy-${randomBytes(16).toString("hex")}`,
    });
    if (device.pairingState === "active") return device;
    this.markHostAcknowledged(device.pairingId!);
    return this.activatePairing(device.pairingId!);
  }

  prepareDevice(input: {
    pairingId: string;
    endpointId: string;
    ownerUserId?: string;
    label: string;
    platform?: string;
    model?: string;
    appVersion?: string;
    grants: readonly string[];
    pairedVia: string;
  }): TunnelDeviceRecord {
    const claimedOwner = input.ownerUserId ?? this.pairingOwner(input.pairingId);
    const byPairing = this.deviceByPairing(input.pairingId);
    if (byPairing) {
      if (byPairing.endpointId !== input.endpointId) throw new Error("pairing endpoint mismatch");
      if (claimedOwner && byPairing.ownerUserId !== claimedOwner) throw unknownPairing();
      return byPairing;
    }
    const ownerUserId = claimedOwner ?? LEGACY_OWNER_USER_ID;
    const now = Date.now();
    const existing = this.db.prepare("SELECT * FROM tunnel_device WHERE endpoint_id = ?").get(input.endpointId) as
      | { id: string; owner_user_id: string; revoked_at: number | null; grant_revision: number; created_at: number; pairing_state: string; pairing_id: string | null }
      | undefined;
    if (existing?.pairing_state === "active" && existing.revoked_at == null) {
      const active = this.device(existing.id)!;
      if (active.ownerUserId !== ownerUserId) throw unknownPairing();
      return active;
    }
    if (existing && (existing.pairing_state === "pending" || existing.pairing_state === "host-acknowledged")) {
      throw new Error("device already has an unfinished pairing");
    }
    const id = existing?.id ?? randomBytes(16).toString("hex");
    const grantRevision = (existing?.grant_revision ?? 0) + 1;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO tunnel_device(id, endpoint_id, owner_user_id, label, platform, model, app_version, created_at, updated_at, last_seen_at, revoked_at, grant_revision, paired_via, last_transport, pairing_id, pairing_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, 'pending')
        ON CONFLICT(id) DO UPDATE SET
          owner_user_id=excluded.owner_user_id,
          label=excluded.label,
          platform=excluded.platform,
          model=excluded.model,
          app_version=excluded.app_version,
          updated_at=excluded.updated_at,
          revoked_at=NULL,
          grant_revision=excluded.grant_revision,
          paired_via=excluded.paired_via,
          pairing_id=excluded.pairing_id,
          pairing_state='pending'
      `).run(
        id,
        input.endpointId,
        ownerUserId,
        input.label,
        input.platform ?? null,
        input.model ?? null,
        input.appVersion ?? null,
        existing?.created_at ?? now,
        now,
        now,
        grantRevision,
        input.pairedVia,
        input.pairingId,
      );
      this.db.prepare("DELETE FROM tunnel_device_grant WHERE device_id = ?").run(id);
      const insertGrant = this.db.prepare(
        "INSERT INTO tunnel_device_grant(device_id, capability, granted_at, granted_by) VALUES (?, ?, ?, ?)",
      );
      for (const capability of normalizeDeviceGrants(input.grants)) {
        insertGrant.run(id, capability, now, "local-admin");
      }
      this.db.prepare(
        "INSERT INTO tunnel_audit(id, event_type, device_id, connection_id, created_at, metadata_json) VALUES (?, ?, ?, NULL, ?, ?)",
      ).run(randomBytes(16).toString("hex"), "pairing-prepared", id, now, JSON.stringify({ pairingId: input.pairingId, endpointFingerprint: fingerprintEndpoint(input.endpointId) }));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.device(id)!;
  }

  markHostAcknowledged(pairingId: string): TunnelDeviceRecord {
    const current = this.deviceByPairing(pairingId);
    if (!current) throw new Error("unknown pairing");
    if (current.pairingState === "active" || current.pairingState === "host-acknowledged") return current;
    if (current.pairingState !== "pending") throw new Error("pairing is not pending");
    this.db.prepare("UPDATE tunnel_device SET pairing_state = 'host-acknowledged', updated_at = ? WHERE pairing_id = ? AND pairing_state = 'pending'")
      .run(Date.now(), pairingId);
    return this.deviceByPairing(pairingId)!;
  }

  activatePairing(pairingId: string): TunnelDeviceRecord {
    const current = this.deviceByPairing(pairingId);
    if (!current) throw new Error("unknown pairing");
    if (current.pairingState === "active") return current;
    if (current.pairingState !== "host-acknowledged") throw new Error("host has not acknowledged pairing");
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE tunnel_device SET pairing_state = 'active', updated_at = ? WHERE pairing_id = ? AND pairing_state = 'host-acknowledged'")
        .run(now, pairingId);
      this.db.prepare(
        "INSERT INTO tunnel_audit(id, event_type, device_id, connection_id, created_at, metadata_json) VALUES (?, 'pairing-committed', ?, NULL, ?, ?)",
      ).run(randomBytes(16).toString("hex"), current.id, now, JSON.stringify({ pairingId }));
      this.db.prepare("DELETE FROM tunnel_pairing_owner WHERE pairing_id = ?").run(pairingId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.deviceByPairing(pairingId)!;
  }

  failPairing(pairingId: string, includeActive = false): TunnelDeviceRecord | undefined {
    const current = this.deviceByPairing(pairingId);
    if (!current || current.pairingState === "failed" || (current.pairingState === "active" && !includeActive)) return undefined;
    const now = Date.now();
    this.db.prepare("UPDATE tunnel_device SET pairing_state = 'failed', revoked_at = ?, grant_revision = grant_revision + 1, updated_at = ? WHERE pairing_id = ?")
      .run(now, now, pairingId);
    this.releasePairingOwner(pairingId);
    this.audit("pairing-failed", { deviceId: current.id, metadata: { pairingId } });
    return this.deviceByPairing(pairingId);
  }

  recoverIncompletePairings(): TunnelDeviceRecord[] {
    const rows = this.db.prepare("SELECT pairing_id FROM tunnel_device WHERE pairing_state = 'pending'").all() as Array<{ pairing_id: string }>;
    const failed = rows.map((row) => this.failPairing(row.pairing_id)!).filter(Boolean);
    const acknowledged = this.db.prepare("SELECT id, pairing_id FROM tunnel_device WHERE pairing_state = 'host-acknowledged'").all() as Array<{ id: string; pairing_id: string }>;
    if (acknowledged.length) {
      const now = Date.now();
      this.db.exec("BEGIN");
      try {
        this.db.prepare("UPDATE tunnel_device SET pairing_state = 'active', updated_at = ? WHERE pairing_state = 'host-acknowledged'").run(now);
        const audit = this.db.prepare(
          "INSERT INTO tunnel_audit(id, event_type, device_id, connection_id, created_at, metadata_json) VALUES (?, 'pairing-recovered', ?, NULL, ?, ?)",
        );
        const releaseOwner = this.db.prepare("DELETE FROM tunnel_pairing_owner WHERE pairing_id = ?");
        for (const row of acknowledged) {
          audit.run(randomBytes(16).toString("hex"), row.id, now, JSON.stringify({ pairingId: row.pairing_id }));
          releaseOwner.run(row.pairing_id);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return failed;
  }

  device(id: string): TunnelDeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tunnel_device WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  deviceForUser(id: string, userId: string): TunnelDeviceRecord | undefined {
    const device = this.device(id);
    return device?.ownerUserId === userId ? device : undefined;
  }

  deviceByEndpoint(endpointId: string): TunnelDeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tunnel_device WHERE endpoint_id = ?").get(endpointId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  deviceByPairing(pairingId: string): TunnelDeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tunnel_device WHERE pairing_id = ?").get(pairingId) as Record<string, unknown> | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  list(userId?: string): TunnelDeviceRecord[] {
    const rows = userId
      ? this.db.prepare("SELECT * FROM tunnel_device WHERE pairing_state IN ('active', 'failed') AND owner_user_id = ? ORDER BY updated_at DESC").all(userId)
      : this.db.prepare("SELECT * FROM tunnel_device WHERE pairing_state IN ('active', 'failed') ORDER BY updated_at DESC").all();
    return (rows as Record<string, unknown>[]).map((row) => this.hydrate(row));
  }

  trustList(userId?: string): TunnelDeviceRecord[] {
    const rows = userId
      ? this.db.prepare("SELECT * FROM tunnel_device WHERE pairing_state = 'active' AND owner_user_id = ? ORDER BY updated_at DESC").all(userId)
      : this.db.prepare("SELECT * FROM tunnel_device WHERE pairing_state = 'active' ORDER BY updated_at DESC").all();
    return (rows as Record<string, unknown>[]).map((row) => this.hydrate(row));
  }

  rename(id: string, label: string): TunnelDeviceRecord | undefined {
    this.db.prepare("UPDATE tunnel_device SET label = ?, updated_at = ? WHERE id = ?").run(label, Date.now(), id);
    return this.device(id);
  }

  setGrants(id: string, grants: readonly string[]): TunnelDeviceRecord | undefined {
    const current = this.device(id);
    if (!current) return undefined;
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE tunnel_device SET grant_revision = grant_revision + 1, updated_at = ? WHERE id = ?").run(now, id);
      this.db.prepare("DELETE FROM tunnel_device_grant WHERE device_id = ?").run(id);
      const insertGrant = this.db.prepare(
        "INSERT INTO tunnel_device_grant(device_id, capability, granted_at, granted_by) VALUES (?, ?, ?, ?)",
      );
      for (const capability of normalizeDeviceGrants(grants)) insertGrant.run(id, capability, now, "local-admin");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.audit("grants-updated", { deviceId: id });
    return this.device(id);
  }

  revoke(id: string): TunnelDeviceRecord | undefined {
    const now = Date.now();
    this.db.prepare("UPDATE tunnel_device SET revoked_at = ?, grant_revision = grant_revision + 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, now, id);
    this.audit("device-revoked", { deviceId: id });
    return this.device(id);
  }

  restore(id: string): TunnelDeviceRecord | undefined {
    const now = Date.now();
    const result = this.db.prepare("UPDATE tunnel_device SET revoked_at = NULL, grant_revision = grant_revision + 1, updated_at = ? WHERE id = ? AND pairing_state = 'active'").run(now, id);
    if (result.changes === 0) return undefined;
    this.audit("device-restored", { deviceId: id });
    return this.device(id);
  }

  forget(id: string): boolean {
    const current = this.device(id);
    if (!current?.revokedAt) return false;
    if (current.pairingId) this.releasePairingOwner(current.pairingId);
    this.db.prepare("DELETE FROM tunnel_device WHERE id = ?").run(id);
    return true;
  }

  revokeAll(): string[] {
    const ids = this.list().filter((device) => !device.revokedAt).map((device) => device.id);
    for (const id of ids) this.revoke(id);
    return ids;
  }

  touch(id: string, transport?: string): void {
    this.db.prepare("UPDATE tunnel_device SET last_seen_at = ?, last_transport = COALESCE(?, last_transport), updated_at = ? WHERE id = ?")
      .run(Date.now(), transport ?? null, Date.now(), id);
  }

  toDto(record: TunnelDeviceRecord, online: boolean, activeConnectionCount = online ? 1 : 0): TunnelDeviceDto {
    return {
      id: record.id,
      label: record.label,
      ...(record.platform ? { platform: record.platform } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.appVersion ? { appVersion: record.appVersion } : {}),
      endpointFingerprint: fingerprintEndpoint(record.endpointId),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
      grantRevision: record.grantRevision,
      grants: record.grants,
      ...(record.lastTransport === "direct" || record.lastTransport === "relay"
        ? { lastTransport: record.lastTransport }
        : {}),
      online,
      activeConnectionCount,
    };
  }

  private hydrate(row: Record<string, unknown>): TunnelDeviceRecord {
    const id = String(row.id);
    const grants = this.db.prepare("SELECT capability FROM tunnel_device_grant WHERE device_id = ?").all(id) as Array<{ capability: string }>;
    return {
      id,
      endpointId: String(row.endpoint_id),
      ownerUserId: typeof row.owner_user_id === "string" && row.owner_user_id ? row.owner_user_id : LEGACY_OWNER_USER_ID,
      label: String(row.label),
      platform: row.platform == null ? null : String(row.platform),
      model: row.model == null ? null : String(row.model),
      appVersion: row.app_version == null ? null : String(row.app_version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at),
      revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
      grantRevision: Number(row.grant_revision),
      pairedVia: String(row.paired_via),
      lastTransport: row.last_transport == null ? null : String(row.last_transport),
      grants: grants.map((item) => item.capability),
      pairingId: row.pairing_id == null ? null : String(row.pairing_id),
      pairingState: row.pairing_state === "pending" || row.pairing_state === "host-acknowledged" || row.pairing_state === "failed"
        ? row.pairing_state
        : "active",
    };
  }
}

export function createTunnelStore(path: string): TunnelStore {
  return new TunnelStore(path);
}