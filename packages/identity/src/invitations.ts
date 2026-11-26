import { randomBytes } from 'node:crypto';
import { controlError, type ControlPlane } from '@polyth/control-plane';
import { validateNewPassword, type PasswordService } from './passwords.ts';
import { requireOwnerCredential } from './access.ts';
import { createIdentityLimiter } from './rateLimit.ts';
import { opaqueId, tokenHash } from './validation.ts';
import type { SessionService } from './sessions.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const DEFAULT_TTL = 7 * DAY, MIN_TTL = HOUR, MAX_TTL = 30 * DAY;
const PREFIX = 'pinv_';
const invalid = (): Error => controlError('invalid-invitation', 'This invitation link is not valid any more. Ask for a new one.');

interface Row { id: string; user_id: string; expires_at_ms: number }

/** One-time invitation links: an instance owner issues a code for a local
 *  account, the invited person redeems it to choose their own password. Only
 *  the code's hash is stored; the code itself is returned once, by `issue`. */
export function createInvitations(control: ControlPlane, passwords: PasswordService, sessions: SessionService, now: () => number) {
  const limiter = createIdentityLimiter({ now });
  const hasOwnerRole = (userId: string): boolean => !!control.get("SELECT 1 FROM instance_roles WHERE user_id=? AND role='owner'", userId);
  const owner = (token: string): string => {
    const actor = sessions.require(token, true);
    if (!hasOwnerRole(actor.userId)) throw controlError('forbidden', 'Instance owner access required');
    return actor.userId;
  };
  const ownerGuard = (token: string): void => { sessions.require(token); requireOwnerCredential(control); owner(token); };
  const admit = (address: string | undefined): void => limiter.admit(address, `invitation:${address ?? 'unknown'}`);
  /** The live invitation behind a code, or null; never says why not. */
  const find = (code: unknown): (Row & { name: string; login: string }) | null => {
    if (typeof code !== 'string' || !code.startsWith(PREFIX) || code.length > 200) return null;
    return control.get<Row & { name: string; login: string }>(
      `SELECT i.id,i.user_id,i.expires_at_ms,u.display_name AS name,c.login_name AS login
         FROM account_invitations i JOIN principals p ON p.id=i.user_id JOIN users u ON u.id=i.user_id
         JOIN password_credentials c ON c.user_id=i.user_id
        WHERE i.code_hash=? AND i.consumed_at_ms IS NULL AND i.revoked_at_ms IS NULL AND i.expires_at_ms>?
          AND p.status='active' AND u.managed=0`,
      tokenHash('invitation', code), now(),
    ) ?? null;
  };
  const revokeLive = (userId: string): number => Number(control.run(
    'UPDATE account_invitations SET revoked_at_ms=? WHERE user_id=? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL', now(), userId,
  ).changes);
  return {
    issue(token: string, userId: string, opts: { ttlMs?: number } = {}): { code: string; expiresAt: number } {
      ownerGuard(token);
      const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, Number.isFinite(opts.ttlMs) ? Math.floor(opts.ttlMs!) : DEFAULT_TTL));
      const code = PREFIX + randomBytes(32).toString('base64url');
      return control.transaction(() => {
        const actor = owner(token);
        if (actor === userId || hasOwnerRole(userId)) throw controlError('forbidden', 'Owners set their own password in Account settings');
        const target = control.get<{ status: string; managed: number }>(
          'SELECT p.status,u.managed FROM principals p JOIN users u ON u.id=p.id WHERE p.id=?', userId);
        if (!target) throw controlError('not-found', 'Account not found');
        if (target.managed) throw controlError('managed-identity', 'This account signs in through its identity provider');
        if (target.status !== 'active') throw controlError('invalid-transition', 'This account is disabled');
        if (!control.get('SELECT 1 FROM password_credentials WHERE user_id=?', userId)) throw controlError('invalid-input', 'This account has no password sign-in');
        revokeLive(userId);
        const time = now(), expiresAt = time + ttl;
        control.run('INSERT INTO account_invitations(id,user_id,code_hash,created_by,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?)',
          opaqueId('inv'), userId, tokenHash('invitation', code), actor, time, expiresAt);
        control.audit(actor, 'identity.invitation-issued', userId);
        return { code, expiresAt };
      });
    },
    revoke(token: string, userId: string): { revoked: number } {
      ownerGuard(token);
      return control.transaction(() => {
        const actor = owner(token);
        const revoked = revokeLive(userId);
        if (revoked) control.audit(actor, 'identity.invitation-revoked', userId);
        return { revoked };
      });
    },
    pending(token: string, userId: string): { expiresAt: number } | null {
      ownerGuard(token);
      const row = control.get<{ expires_at_ms: number }>(
        `SELECT expires_at_ms FROM account_invitations WHERE user_id=? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL AND expires_at_ms>?
          ORDER BY created_at_ms DESC,rowid DESC LIMIT 1`, userId, now());
      return row ? { expiresAt: row.expires_at_ms } : null;
    },
    preview(code: string, address?: string): { name: string; login: string; expiresAt: number } {
      admit(address);
      const row = find(code);
      if (!row) throw invalid();
      return { name: row.name, login: row.login, expiresAt: row.expires_at_ms };
    },
    async accept(input: { code: string; password: string; address?: string; label?: string }) {
      admit(input.address);
      if (!find(input.code)) throw invalid();
      validateNewPassword(input.password);
      const encoded = await passwords.hash(input.password);
      return control.transaction(() => {
        const row = find(input.code);
        if (!row) throw invalid();
        const used = control.run('UPDATE account_invitations SET consumed_at_ms=? WHERE id=? AND consumed_at_ms IS NULL AND revoked_at_ms IS NULL', now(), row.id);
        if (Number(used.changes) !== 1) throw invalid();
        control.run('UPDATE password_credentials SET password_hash=?,changed_at_ms=? WHERE user_id=?', encoded, now(), row.user_id);
        control.run('UPDATE principals SET auth_epoch=auth_epoch+1 WHERE id=?', row.user_id);
        control.run('DELETE FROM auth_sessions WHERE user_id=?', row.user_id);
        control.bumpEpoch();
        control.audit(row.user_id, 'auth.password-changed', row.user_id);
        control.audit(row.user_id, 'identity.invitation-accepted', row.user_id);
        return sessions.issue(row.user_id, input.label);
      });
    },
    /** Called when an account leaves `active`; its links stop working. */
    revokeFor(userId: string): number { return revokeLive(userId); },
  };
}
