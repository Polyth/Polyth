import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Destination, type Environment, type Platform, RelayFault } from "./types.ts";

const SCHEMA_VERSION = 1;
const CLAIM_TTL_MS = 5 * 60_000;

type SubscriptionRow = {
  id: string;
  version: number;
  platform: Platform;
  environment: Environment | null;
  token_nonce: Uint8Array;
  token_cipher: Uint8Array;
  token_tag: Uint8Array;
  binding: string;
  manage_hash: Uint8Array;
  sender_hash: Uint8Array | null;
  claim_hash: Uint8Array;
  created_at: number;
  claim_expires_at: number;
  claim_used_at: number | null;
  revoked_at: number | null;
  dead_at: number | null;
};

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

const sameDigest = (stored: Uint8Array | null, supplied: Buffer): boolean =>
  Boolean(stored && stored.length === supplied.length && timingSafeEqual(Buffer.from(stored), supplied));

function opaqueFailure(): never {
  // Incorrect tokens, bindings, expiry, and use all deliberately have one shape.
  throw new RelayFault("unauthorized");
}

export interface StoreOptions {
  file: string;
  masterKey: Buffer;
  now: () => number;
  randomBytes?: (size: number) => Buffer;
}

export interface CreatedSubscription {
  subscriptionId: string;
  claimExpiresAt: number;
}

/**
 * The only persistent record owned by the relay. Capability values and provider
 * tokens never leave this class in plaintext except for a just-authorized send.
 */
export class RelayStore {
  private readonly db: DatabaseSync;
  private readonly options: StoreOptions;

  constructor(options: StoreOptions) {
    this.options = options;
    if (options.masterKey.length !== 32) throw new RelayFault("storage");
    mkdirSync(dirname(options.file), { recursive: true });
    this.db = new DatabaseSync(options.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 2500");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
        environment TEXT CHECK(environment IN ('sandbox', 'production')),
        token_nonce BLOB NOT NULL,
        token_cipher BLOB NOT NULL,
        token_tag BLOB NOT NULL,
        binding TEXT NOT NULL,
        manage_hash BLOB NOT NULL,
        sender_hash BLOB,
        claim_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claim_expires_at INTEGER NOT NULL,
        claim_used_at INTEGER,
        sender_revoked_at INTEGER,
        revoked_at INTEGER,
        dead_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS subscriptions_claim_hash ON subscriptions(claim_hash);
    `);
    this.db.prepare("INSERT OR IGNORE INTO relay_meta(key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    subscriptionId: string;
    platform: Platform;
    environment?: Environment;
    providerToken: string;
    binding: string;
    manageToken: string;
    claimToken: string;
  }): CreatedSubscription {
    const now = this.options.now();
    const encrypted = this.encrypt(
      input.providerToken,
      input.subscriptionId,
      1,
      input.platform,
      input.environment,
    );
    const claimExpiresAt = now + CLAIM_TTL_MS;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO subscriptions(
        id, version, platform, environment, token_nonce, token_cipher, token_tag, binding,
        manage_hash, claim_hash, created_at, updated_at, claim_expires_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.subscriptionId, input.platform, input.environment ?? null,
          encrypted.nonce, encrypted.ciphertext, encrypted.tag, input.binding,
          digest(input.manageToken), digest(input.claimToken), now, now, claimExpiresAt,
        );
    });
    return { subscriptionId: input.subscriptionId, claimExpiresAt };
  }

  rotate(subscriptionId: string, manageToken: string, providerToken: string): void {
    const now = this.options.now();
    this.transaction(() => {
      const row = this.get(subscriptionId);
      if (!row || row.revoked_at || !sameDigest(row.manage_hash, digest(manageToken))) opaqueFailure();
      if (!validProviderToken(row.platform, providerToken)) throw new RelayFault("invalid");
      const version = row.version + 1;
      const encrypted = this.encrypt(providerToken, row.id, version, row.platform, row.environment ?? undefined);
      this.db.prepare(`UPDATE subscriptions SET version = version + 1, token_nonce = ?, token_cipher = ?, token_tag = ?,
        updated_at = ?, dead_at = NULL WHERE id = ? AND revoked_at IS NULL`)
        .run(encrypted.nonce, encrypted.ciphertext, encrypted.tag, now, subscriptionId);
    });
  }

  revokeManaged(subscriptionId: string, manageToken: string): void {
    this.transaction(() => {
      const row = this.get(subscriptionId);
      if (!row || !sameDigest(row.manage_hash, digest(manageToken))) opaqueFailure();
      this.db.prepare("UPDATE subscriptions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?")
        .run(this.options.now(), this.options.now(), subscriptionId);
    });
  }

  revokeSender(subscriptionId: string, senderToken: string): void {
    this.transaction(() => {
      const row = this.get(subscriptionId);
      if (!row || row.revoked_at || !sameDigest(row.sender_hash, digest(senderToken))) opaqueFailure();
      this.db.prepare("UPDATE subscriptions SET sender_hash = NULL, sender_revoked_at = ?, updated_at = ? WHERE id = ?")
        .run(this.options.now(), this.options.now(), subscriptionId);
    });
  }

  redeem(claimToken: string, binding: string, senderToken: string): string {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM subscriptions WHERE claim_hash = ?").get(digest(claimToken)) as SubscriptionRow | undefined;
      const now = this.options.now();
      if (!row || !sameDigest(row.claim_hash, digest(claimToken)) || !sameString(row.binding, binding)
        || row.claim_used_at || row.revoked_at || row.dead_at || row.claim_expires_at <= now) opaqueFailure();
      const result = this.db.prepare(`UPDATE subscriptions SET sender_hash = ?, claim_used_at = ?, updated_at = ?
        WHERE id = ? AND claim_used_at IS NULL AND revoked_at IS NULL AND dead_at IS NULL AND claim_expires_at > ?`)
        .run(digest(senderToken), now, now, row.id, now) as { changes?: number };
      if (result.changes !== 1) opaqueFailure();
      return row.id;
    });
  }

  /** The database authorization decision is serialized with revocation. */
  reserveDelivery(subscriptionId: string, senderToken: string): Destination {
    return this.transaction(() => {
      const row = this.get(subscriptionId);
      if (!row || row.revoked_at || row.dead_at || !sameDigest(row.sender_hash, digest(senderToken))) opaqueFailure();
      return {
        subscriptionId: row.id,
        version: row.version,
        platform: row.platform,
        ...(row.environment ? { environment: row.environment } : {}),
        providerToken: this.decrypt(row),
      };
    });
  }

  /** A stale provider result cannot retire a freshly rotated provider token. */
  markDead(subscriptionId: string, version: number): void {
    this.transaction(() => {
      this.db.prepare("UPDATE subscriptions SET dead_at = ?, updated_at = ? WHERE id = ? AND version = ? AND revoked_at IS NULL")
        .run(this.options.now(), this.options.now(), subscriptionId, version);
    });
  }

  private get(subscriptionId: string): SubscriptionRow | undefined {
    return this.db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(subscriptionId) as SubscriptionRow | undefined;
  }

  private encrypt(
    providerToken: string,
    subscriptionId: string,
    version: number,
    platform: Platform,
    environment?: Environment,
  ): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
    const nonce = this.options.randomBytes?.(12) ?? randomBytes(12);
    if (!Buffer.isBuffer(nonce) || nonce.length !== 12) throw new RelayFault("storage");
    const cipher = createCipheriv("aes-256-gcm", this.options.masterKey, nonce);
    cipher.setAAD(encryptionContext(subscriptionId, version, platform, environment));
    return { nonce, ciphertext: Buffer.concat([cipher.update(providerToken, "utf8"), cipher.final()]), tag: cipher.getAuthTag() };
  }

  private decrypt(row: SubscriptionRow): string {
    try {
      const nonce = Buffer.from(row.token_nonce);
      const tag = Buffer.from(row.token_tag);
      if (nonce.length !== 12 || tag.length !== 16) throw new Error("corrupt");
      const decipher = createDecipheriv("aes-256-gcm", this.options.masterKey, nonce);
      decipher.setAAD(encryptionContext(row.id, row.version, row.platform, row.environment ?? undefined));
      decipher.setAuthTag(tag);
      const value = Buffer.concat([decipher.update(Buffer.from(row.token_cipher)), decipher.final()]).toString("utf8");
      // This prevents a corrupted / wrong-key row from becoming an opaque outbound token.
      if (!/^[!-~]{10,4096}$/.test(value)) throw new Error("corrupt");
      return value;
    } catch {
      throw new RelayFault("storage");
    }
  }

  private transaction<T>(work: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* already closed/rolled back */ }
        throw error;
      }
    } catch (error) {
      if (error instanceof RelayFault) throw error;
      throw new RelayFault("unavailable");
    }
  }
}

const sameString = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const validProviderToken = (platform: Platform, value: string): boolean =>
  platform === "ios" ? /^[A-Za-z0-9+/=_:-]{16,512}$/.test(value) : /^[!-~]{10,4096}$/.test(value);

const encryptionContext = (
  subscriptionId: string,
  version: number,
  platform: Platform,
  environment?: Environment,
): Buffer => Buffer.from(
  `polyth-push-relay-provider-v1\0${subscriptionId}\0${version}\0${platform}\0${environment ?? ""}`,
  "utf8",
);
