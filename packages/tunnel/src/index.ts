import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { TunnelDeviceDto } from "@polyth/contracts";
import { GRANT_PROFILE_PRESETS, normalizeDeviceGrants, type GrantProfileId } from "@polyth/contracts";

export interface TunnelDeviceRecord {
  id: string;
  endpointId: string;
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
}

export function grantsForProfile(profile: GrantProfileId): string[] {
  return normalizeDeviceGrants(GRANT_PROFILE_PRESETS[profile]);
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tunnel_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tunnel_device (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL UNIQUE,
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

  commitDevice(input: {
    endpointId: string;
    label: string;
    platform?: string;
    model?: string;
    appVersion?: string;
    grants: readonly string[];
    pairedVia: string;
  }): TunnelDeviceRecord {
    const now = Date.now();
    const existing = this.db.prepare("SELECT * FROM tunnel_device WHERE endpoint_id = ?").get(input.endpointId) as
      | { id: string; revoked_at: number | null; grant_revision: number; created_at: number } | undefined;
    if (existing && existing.revoked_at == null) {
      return this.device(existing.id)!;
    }
    const id = existing?.id ?? randomBytes(16).toString("hex");
    const grantRevision = (existing?.grant_revision ?? 0) + 1;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO tunnel_device(id, endpoint_id, label, platform, model, app_version, created_at, updated_at, last_seen_at, revoked_at, grant_revision, paired_via, last_transport)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          label=excluded.label,
          platform=excluded.platform,
          model=excluded.model,
          app_version=excluded.app_version,
          updated_at=excluded.updated_at,
          revoked_at=NULL,
          grant_revision=excluded.grant_revision,
          paired_via=excluded.paired_via
      `).run(
        id,
        input.endpointId,
        input.label,
        input.platform ?? null,
        input.model ?? null,
        input.appVersion ?? null,
        existing?.created_at ?? now,
        now,
        now,
        grantRevision,
        input.pairedVia,
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
      ).run(randomBytes(16).toString("hex"), "pairing-committed", id, now, JSON.stringify({ endpointFingerprint: fingerprintEndpoint(input.endpointId) }));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.device(id)!;
  }

  device(id: string): TunnelDeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tunnel_device WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  deviceByEndpoint(endpointId: string): TunnelDeviceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tunnel_device WHERE endpoint_id = ?").get(endpointId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.hydrate(row);
  }

  list(): TunnelDeviceRecord[] {
    const rows = this.db.prepare("SELECT * FROM tunnel_device ORDER BY updated_at DESC").all() as Record<string, unknown>[];
    return rows.map((row) => this.hydrate(row));
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
    this.db.prepare("UPDATE tunnel_device SET revoked_at = NULL, grant_revision = grant_revision + 1, updated_at = ? WHERE id = ?").run(now, id);
    this.audit("device-restored", { deviceId: id });
    return this.device(id);
  }

  forget(id: string): boolean {
    const current = this.device(id);
    if (!current?.revokedAt) return false;
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
    };
  }
}

export function createTunnelStore(path: string): TunnelStore {
  return new TunnelStore(path);
}
