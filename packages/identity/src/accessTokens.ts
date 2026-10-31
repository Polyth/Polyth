// Command-line access for the account-first identity authority.
//
// Three things live here, all owned by a person:
//
// - Access tokens: bearer credentials for the `polyth` CLI. A token is either
//   a `device` token (minted by the device-authorization flow after the person
//   approves a code in the signed-in web UI) or an `automation` token (created
//   directly in the web UI for scripts). Only a SHA-256 of the token is stored.
//   A token speaks for its owner, is capped by an explicit grant list (the same
//   remote capabilities paired devices use), may be pinned to one Space, and
//   dies with the account's auth epoch (password change, logout everywhere,
//   suspension) exactly like a browser session.
// - Device authorizations: the short-lived pending half of the device flow.
//   The CLI holds a secret device code; the person types the short user code
//   into the UI. No plaintext token is stored: it is minted when the CLI
//   redeems an approved code, once.
// - CLI trust: one owner-chosen mode that lets a CLI on this machine (or on a
//   private network) act as that owner without any token. It is off by
//   default and only a signed-in owner can change it.
//
// The capability vocabulary belongs to `@polyth/contracts`; the host injects a
// normalizer and the named profiles so this package stays contract-free.
import { randomBytes, randomInt } from 'node:crypto';
import { controlError, type ControlPlane } from '@polyth/control-plane';
import type { SessionService } from './sessions.ts';
import { opaqueId, tokenHash } from './validation.ts';

export type AccessTokenKind = 'device' | 'automation';
export type CliTrustMode = 'off' | 'loopback' | 'private-network';
export const CLI_TRUST_MODES: readonly CliTrustMode[] = ['off', 'loopback', 'private-network'];

export interface AccessTokenSummary {
  id: string;
  kind: AccessTokenKind;
  label: string;
  grants: string[];
  spaceId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revision: number;
}

/** What a valid bearer token resolves to. Never contains the token. */
export interface ResolvedAccessToken {
  id: string;
  userId: string;
  kind: AccessTokenKind;
  grants: string[];
  spaceId: string | null;
}

export interface IssuedAccessToken { token: string; summary: AccessTokenSummary }

export interface DeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceAuthorizationDetails {
  userCode: string;
  label: string;
  profile: string;
  grants: string[];
  clientAddress: string | null;
  createdAt: number;
  expiresAt: number;
}

export type DeviceRedeemResult =
  | { status: 'pending'; interval: number }
  | { status: 'issued'; token: string; summary: AccessTokenSummary };

export interface CliTrust {
  mode: CliTrustMode;
  /** The owner the no-token CLI acts as; null while off. */
  userId: string | null;
  /** 0 before the first write. */
  revision: number;
  updatedAt: number | null;
}

export interface AccessTokenPolicy {
  /** Validate an explicit grant list; throws `invalid-input`. */
  normalizeGrants(raw: unknown): string[];
  /** Named grant profiles offered to people (e.g. read/control). */
  profiles: Readonly<Record<string, readonly string[]>>;
}

/** Token text: a recognizable prefix for secret scanners + 256 random bits. */
export const ACCESS_TOKEN_PREFIX = 'pth_';
const ACCESS_TOKEN_PATTERN = /^pth_[a-f0-9]{64}$/;
const DEVICE_CODE_PATTERN = /^[a-f0-9]{64}$/;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const DEVICE_TTL_MS = 10 * 60_000;
const DEVICE_POLL_INTERVAL_S = 3;
const MAX_PENDING_PER_ADDRESS = 5;
const MAX_PENDING_TOTAL = 50;
const MAX_TOKEN_DAYS = 3650;
const LAST_USED_WRITE_MS = 60_000;

export const validAccessToken = (value: unknown): value is string =>
  typeof value === 'string' && ACCESS_TOKEN_PATTERN.test(value);

const label = (value: unknown, fallback: string): string => {
  const raw = typeof value === 'string' ? value : fallback;
  const clean = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80);
  if (!clean) throw controlError('invalid-input', 'A label is required');
  return clean;
};

/** Accepts `ABCD-EFGH`, `abcdefgh`, spaces — normalizes to `ABCDEFGH`. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null;
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  return code.length === 8 && [...code].every((ch) => USER_CODE_ALPHABET.includes(ch)) ? code : null;
}
const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;
const newUserCode = (): string => Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('');

interface TokenRow {
  id: string; user_id: string; kind: AccessTokenKind; label: string; grants_json: string;
  space_id: string | null; created_at_ms: number; last_used_at_ms: number | null;
  expires_at_ms: number | null; revision: number;
}

export function createAccessTokens(
  control: ControlPlane,
  sessions: SessionService,
  now: () => number,
  policy: AccessTokenPolicy | null,
) {
  const requirePolicy = (): AccessTokenPolicy => {
    if (!policy) throw controlError('unavailable', 'Command-line access is unavailable');
    return policy;
  };
  const parseGrants = (raw: string): string[] => {
    try {
      const value = JSON.parse(raw) as unknown;
      return requirePolicy().normalizeGrants(value);
    } catch {
      return []; // A corrupt row grants nothing.
    }
  };
  const summary = (row: TokenRow): AccessTokenSummary => ({
    id: row.id, kind: row.kind, label: row.label, grants: parseGrants(row.grants_json), spaceId: row.space_id,
    createdAt: row.created_at_ms, lastUsedAt: row.last_used_at_ms, expiresAt: row.expires_at_ms, revision: row.revision,
  });
  const grantsFor = (input: { profile?: unknown; grants?: unknown }): { profile: string; grants: string[] } => {
    const { profiles, normalizeGrants } = requirePolicy();
    if (input.grants !== undefined) {
      const grants = normalizeGrants(input.grants);
      if (!grants.length) throw controlError('invalid-input', 'Choose at least one permission');
      return { profile: 'custom', grants };
    }
    const name = typeof input.profile === 'string' ? input.profile : '';
    const preset = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
    if (!preset) throw controlError('invalid-input', `Unknown access profile; use one of ${Object.keys(profiles).join(', ')}`);
    return { profile: name, grants: normalizeGrants([...preset]) };
  };
  const activeUser = (userId: string): { auth_epoch: number } | undefined => control.get<{ auth_epoch: number }>(
    "SELECT p.auth_epoch FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind='user' AND p.status='active'",
    userId,
  );
  const isOwner = (userId: string): boolean => !!control.get(
    `SELECT 1 FROM instance_roles r JOIN principals p ON p.id=r.user_id
      WHERE r.user_id=? AND r.role='owner' AND p.status='active' AND p.kind='user'`,
    userId,
  );
  const assertMember = (userId: string, spaceId: string): void => {
    const member = control.get(
      "SELECT 1 FROM space_memberships WHERE space_id=? AND principal_id=? AND state='active'",
      spaceId, userId,
    );
    // A Space the person does not belong to answers exactly like a missing one.
    if (!member) throw controlError('not-found', 'Space not found');
  };
  const insertToken = (input: {
    userId: string; kind: AccessTokenKind; label: string; grants: string[];
    spaceId: string | null; expiresAt: number | null;
  }): IssuedAccessToken => {
    const user = activeUser(input.userId);
    if (!user) throw controlError('unauthorized', 'Authentication required');
    const token = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
    const id = opaqueId('tok');
    const time = now();
    control.run(
      `INSERT INTO access_tokens(id,user_id,kind,label,token_hash,grants_json,space_id,auth_epoch,created_at_ms,expires_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id, input.userId, input.kind, input.label, tokenHash('access', token), JSON.stringify(input.grants),
      input.spaceId, user.auth_epoch, time, input.expiresAt,
    );
    control.audit(input.userId, `cli.token-created.${input.kind}`, id);
    const row = control.get<TokenRow>('SELECT * FROM access_tokens WHERE id=?', id)!;
    return { token, summary: summary(row) };
  };

  return {
    profiles(): Record<string, string[]> {
      const { profiles } = requirePolicy();
      return Object.fromEntries(Object.entries(profiles).map(([name, grants]) => [name, [...grants]]));
    },

    /** Trusted host lookup for one bearer token. Never throws for bad input. */
    resolve(token: string | null | undefined): ResolvedAccessToken | null {
      if (!policy || !validAccessToken(token) || control.installation().state !== 'ready') return null;
      const time = now();
      const row = control.get<TokenRow>(
        `SELECT t.* FROM access_tokens t JOIN principals p ON p.id=t.user_id
          WHERE t.token_hash=? AND t.revoked_at_ms IS NULL AND (t.expires_at_ms IS NULL OR t.expires_at_ms>?)
            AND p.kind='user' AND p.status='active' AND t.auth_epoch=p.auth_epoch AND t.created_at_ms<=?`,
        tokenHash('access', token), time, time,
      );
      if (!row) return null;
      if (row.last_used_at_ms === null || time - row.last_used_at_ms >= LAST_USED_WRITE_MS) {
        control.transaction(() => control.run('UPDATE access_tokens SET last_used_at_ms=? WHERE id=?', time, row.id));
      }
      return { id: row.id, userId: row.user_id, kind: row.kind, grants: parseGrants(row.grants_json), spaceId: row.space_id };
    },

    /** Revalidate an already-authenticated channel by token id (no secret).
     *  Never touches last-used; used to re-check long-lived requests. */
    live(id: string, expectedUserId: string): ResolvedAccessToken | null {
      if (!policy || !/^tok_[a-f0-9-]{36}$/.test(id) || control.installation().state !== 'ready') return null;
      const time = now();
      const row = control.get<TokenRow>(
        `SELECT t.* FROM access_tokens t JOIN principals p ON p.id=t.user_id
          WHERE t.id=? AND t.user_id=? AND t.revoked_at_ms IS NULL AND (t.expires_at_ms IS NULL OR t.expires_at_ms>?)
            AND p.kind='user' AND p.status='active' AND t.auth_epoch=p.auth_epoch`,
        id, expectedUserId, time,
      );
      return row ? { id: row.id, userId: row.user_id, kind: row.kind, grants: parseGrants(row.grants_json), spaceId: row.space_id } : null;
    },

    /** Tokens the signed-in person owns that can still be used. */
    list(sessionToken: string): AccessTokenSummary[] {
      const actor = sessions.require(sessionToken);
      const time = now();
      return control.all<TokenRow>(
        `SELECT t.* FROM access_tokens t JOIN principals p ON p.id=t.user_id
          WHERE t.user_id=? AND t.revoked_at_ms IS NULL AND t.auth_epoch=p.auth_epoch
            AND (t.expires_at_ms IS NULL OR t.expires_at_ms>?)
          ORDER BY t.created_at_ms DESC, t.id`,
        actor.userId, time,
      ).map(summary);
    },

    /** Web UI: create an automation token. Requires a recent sign-in. */
    create(sessionToken: string, input: {
      label?: unknown; profile?: unknown; grants?: unknown; spaceId?: unknown; expiresInDays?: unknown;
    }): IssuedAccessToken {
      const { grants } = grantsFor(input);
      const name = label(input.label, '');
      let expiresAt: number | null;
      if (input.expiresInDays === null) expiresAt = null;
      else {
        const days = input.expiresInDays === undefined ? 365 : Number(input.expiresInDays);
        if (!Number.isSafeInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) {
          throw controlError('invalid-input', `Expiry must be 1–${MAX_TOKEN_DAYS} days or never`);
        }
        expiresAt = now() + days * 24 * 60 * 60_000;
      }
      const spaceId = input.spaceId === undefined || input.spaceId === null ? null : String(input.spaceId);
      return control.transaction(() => {
        const actor = sessions.require(sessionToken, true);
        if (spaceId) assertMember(actor.userId, spaceId);
        return insertToken({ userId: actor.userId, kind: 'automation', label: name, grants, spaceId, expiresAt });
      });
    },

    /** Web UI: revoke one of the person's tokens. */
    revoke(sessionToken: string, id: string, expectedRevision: number): void {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw controlError('invalid-input', 'Expected revision is required');
      control.transaction(() => {
        const actor = sessions.require(sessionToken);
        const row = control.get<{ revision: number }>(
          'SELECT revision FROM access_tokens WHERE id=? AND user_id=? AND revoked_at_ms IS NULL', id, actor.userId,
        );
        if (!row) throw controlError('not-found', 'Token not found');
        if (row.revision !== expectedRevision) throw controlError('conflict', 'Token changed; refresh before retrying');
        control.run('UPDATE access_tokens SET revoked_at_ms=?,revision=revision+1 WHERE id=?', now(), id);
        control.bumpEpoch();
        control.audit(actor.userId, 'cli.token-revoked', id);
      });
    },

    /** CLI `logout`: a token may always revoke itself. */
    revokeSelf(token: string): boolean {
      if (!validAccessToken(token)) return false;
      return control.transaction(() => {
        const row = control.get<{ id: string; user_id: string }>(
          'SELECT id,user_id FROM access_tokens WHERE token_hash=? AND revoked_at_ms IS NULL', tokenHash('access', token),
        );
        if (!row) return false;
        control.run('UPDATE access_tokens SET revoked_at_ms=?,revision=revision+1 WHERE id=?', now(), row.id);
        control.bumpEpoch();
        control.audit(row.user_id, 'cli.token-revoked-self', row.id);
        return true;
      });
    },

    device: {
      /** Unauthenticated CLI call. Bounded so it cannot be used to flood. */
      start(input: { label?: unknown; profile?: unknown; address?: string }): DeviceAuthorizationStart {
        const { profile } = grantsFor({ profile: input.profile ?? 'control' });
        const name = label(input.label, 'Polyth CLI');
        const address = typeof input.address === 'string' ? input.address.slice(0, 64) : null;
        return control.transaction(() => {
          const time = now();
          control.run("DELETE FROM device_authorizations WHERE expires_at_ms<=? OR status='redeemed'", time);
          const total = control.get<{ n: number }>("SELECT count(*) AS n FROM device_authorizations WHERE status='pending'")!.n;
          const fromAddress = address
            ? control.get<{ n: number }>("SELECT count(*) AS n FROM device_authorizations WHERE status='pending' AND client_address=?", address)!.n
            : 0;
          if (total >= MAX_PENDING_TOTAL || fromAddress >= MAX_PENDING_PER_ADDRESS) {
            throw Object.assign(controlError('rate-limited', 'Too many pending sign-ins; try again later'), { retryAfterSec: 60 });
          }
          const deviceCode = randomBytes(32).toString('hex');
          let userCode = newUserCode();
          for (let tries = 0; control.get('SELECT 1 FROM device_authorizations WHERE user_code=?', userCode); tries++) {
            if (tries > 8) throw controlError('unavailable', 'Could not allocate a sign-in code');
            userCode = newUserCode();
          }
          control.run(
            `INSERT INTO device_authorizations(id,device_code_hash,user_code,label,profile,client_address,status,created_at_ms,expires_at_ms)
             VALUES(?,?,?,?,?,?,'pending',?,?)`,
            opaqueId('dev'), tokenHash('device', deviceCode), userCode, name, profile, address, time, time + DEVICE_TTL_MS,
          );
          return { deviceCode, userCode: formatUserCode(userCode), expiresIn: DEVICE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S };
        });
      },

      /** Web UI: show what is asking for access before the person decides. */
      lookup(sessionToken: string, rawCode: unknown): DeviceAuthorizationDetails {
        sessions.require(sessionToken);
        const code = normalizeUserCode(rawCode);
        const row = code ? control.get<{
          user_code: string; label: string; profile: string; client_address: string | null; created_at_ms: number; expires_at_ms: number;
        }>(
          "SELECT user_code,label,profile,client_address,created_at_ms,expires_at_ms FROM device_authorizations WHERE user_code=? AND status='pending' AND expires_at_ms>?",
          code, now(),
        ) : undefined;
        if (!row) throw controlError('not-found', 'This code is unknown or has expired');
        const { grants } = grantsFor({ profile: row.profile });
        return {
          userCode: formatUserCode(row.user_code), label: row.label, profile: row.profile, grants,
          clientAddress: row.client_address, createdAt: row.created_at_ms, expiresAt: row.expires_at_ms,
        };
      },

      /** Web UI: approve or deny. Approval requires a recent sign-in. */
      decide(sessionToken: string, rawCode: unknown, approve: boolean): void {
        const code = normalizeUserCode(rawCode);
        control.transaction(() => {
          const actor = sessions.require(sessionToken, approve);
          const row = code ? control.get<{ id: string }>(
            "SELECT id FROM device_authorizations WHERE user_code=? AND status='pending' AND expires_at_ms>?", code, now(),
          ) : undefined;
          if (!row) throw controlError('not-found', 'This code is unknown or has expired');
          control.run('UPDATE device_authorizations SET status=?,user_id=? WHERE id=?', approve ? 'approved' : 'denied', actor.userId, row.id);
          control.audit(actor.userId, approve ? 'cli.device-approved' : 'cli.device-denied', row.id);
        });
      },

      /** Unauthenticated CLI poll with the secret device code. */
      redeem(deviceCode: unknown): DeviceRedeemResult {
        if (typeof deviceCode !== 'string' || !DEVICE_CODE_PATTERN.test(deviceCode)) throw controlError('not-found', 'Unknown device code');
        return control.transaction(() => {
          const time = now();
          const row = control.get<{
            id: string; status: string; user_id: string | null; label: string; profile: string; expires_at_ms: number; last_poll_at_ms: number | null;
          }>(
            'SELECT id,status,user_id,label,profile,expires_at_ms,last_poll_at_ms FROM device_authorizations WHERE device_code_hash=?',
            tokenHash('device', deviceCode),
          );
          if (!row || row.status === 'redeemed') throw controlError('expired', 'This sign-in is no longer valid');
          if (row.expires_at_ms <= time) {
            control.run('DELETE FROM device_authorizations WHERE id=?', row.id);
            throw controlError('expired', 'This sign-in expired; start again');
          }
          if (row.status === 'denied') {
            control.run('DELETE FROM device_authorizations WHERE id=?', row.id);
            throw controlError('forbidden', 'Access was denied');
          }
          if (row.status === 'pending') {
            control.run('UPDATE device_authorizations SET last_poll_at_ms=? WHERE id=?', time, row.id);
            return { status: 'pending', interval: DEVICE_POLL_INTERVAL_S };
          }
          const { grants } = grantsFor({ profile: row.profile });
          const issued = insertToken({ userId: row.user_id!, kind: 'device', label: row.label, grants, spaceId: null, expiresAt: null });
          control.run("UPDATE device_authorizations SET status='redeemed',token_id=? WHERE id=?", issued.summary.id, row.id);
          return { status: 'issued', ...issued };
        });
      },
    },

    trust: {
      get(): CliTrust {
        const row = control.get<{ mode: CliTrustMode; user_id: string | null; revision: number; updated_at_ms: number }>(
          'SELECT mode,user_id,revision,updated_at_ms FROM cli_trust WHERE singleton=1',
        );
        if (!row) return { mode: 'off', userId: null, revision: 0, updatedAt: null };
        return { mode: row.mode, userId: row.user_id, revision: row.revision, updatedAt: row.updated_at_ms };
      },
      /** The owner a no-token CLI acts as, or null. Re-checked per request. */
      effective(): { mode: Exclude<CliTrustMode, 'off'>; userId: string } | null {
        const row = control.get<{ mode: CliTrustMode; user_id: string | null }>('SELECT mode,user_id FROM cli_trust WHERE singleton=1');
        if (!row || row.mode === 'off' || !row.user_id || !isOwner(row.user_id)) return null;
        return { mode: row.mode, userId: row.user_id };
      },
      /** Instance owner only, with a recent sign-in. */
      set(sessionToken: string, mode: unknown, expectedRevision: number): CliTrust {
        if (typeof mode !== 'string' || !(CLI_TRUST_MODES as readonly string[]).includes(mode)) {
          throw controlError('invalid-input', `Mode must be one of ${CLI_TRUST_MODES.join(', ')}`);
        }
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw controlError('invalid-input', 'Expected revision is required');
        return control.transaction(() => {
          const actor = sessions.require(sessionToken, true);
          if (!isOwner(actor.userId)) throw controlError('forbidden', 'Instance owner access required');
          const current = control.get<{ revision: number }>('SELECT revision FROM cli_trust WHERE singleton=1');
          if ((current?.revision ?? 0) !== expectedRevision) throw controlError('conflict', 'Setting changed; refresh before retrying');
          const time = now();
          const userId = mode === 'off' ? null : actor.userId;
          if (current) control.run('UPDATE cli_trust SET mode=?,user_id=?,revision=revision+1,updated_at_ms=? WHERE singleton=1', mode, userId, time);
          else control.run('INSERT INTO cli_trust(singleton,mode,user_id,revision,updated_at_ms) VALUES(1,?,?,1,?)', mode, userId, time);
          control.bumpEpoch();
          control.audit(actor.userId, `cli.trust-${mode}`);
          const row = control.get<{ revision: number }>('SELECT revision FROM cli_trust WHERE singleton=1')!;
          return { mode: mode as CliTrustMode, userId, revision: row.revision, updatedAt: time };
        });
      },
    },
  };
}
export type AccessTokenService = ReturnType<typeof createAccessTokens>;
