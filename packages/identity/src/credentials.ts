import { controlError, type ControlPlane } from '@polyth/control-plane';
import { validateNewPassword, type PasswordService } from './passwords.ts';
import { createIdentityLimiter } from './rateLimit.ts';
import { invalidCredentials, loginName, recoveryCode, tokenHash } from './validation.ts';
import type { SessionService } from './sessions.ts';

interface Credential { user_id: string; password_hash: string; status: string; managed: number; auth_epoch: number }
export function createCredentials(control: ControlPlane, passwords: PasswordService, sessions: SessionService, now: () => number) {
  const limiter = createIdentityLimiter({ now });
  const find = (login: string): Credential | undefined => control.get<Credential>(
    `SELECT c.user_id,c.password_hash,p.status,p.auth_epoch,u.managed FROM password_credentials c
     JOIN principals p ON p.id=c.user_id JOIN users u ON u.id=p.id WHERE c.login_name=?`, login,
  );
  const live = (row: Credential | undefined): row is Credential => !!row && row.status === 'active' && !row.managed && control.installation().state === 'ready';
  const unchanged = (before: Credential, after: Credential | undefined): boolean => live(after)
    && after.user_id === before.user_id && after.password_hash === before.password_hash && after.auth_epoch === before.auth_epoch;
  const invalidate = (userId: string): void => {
    control.run('UPDATE principals SET auth_epoch=auth_epoch+1 WHERE id=?', userId);
    control.run('DELETE FROM auth_sessions WHERE user_id=?', userId);
    control.bumpEpoch();
  };
  const accountLogin = (userId: string): string => {
    const row = control.get<{ login_name: string }>('SELECT login_name FROM password_credentials WHERE user_id=?', userId);
    if (!row) throw invalidCredentials();
    return row.login_name;
  };
  const breakGlassReason = (value: unknown): string => {
    if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 500 || /[\x00-\x1f\x7f]/.test(value)) {
      throw controlError('invalid-input', 'Break-glass reason must contain 10–500 printable characters');
    }
    return value.trim();
  };
  return {
    async login(input: { login: string; password: string; address?: string; label?: string }) {
      let login: string;
      try { login = loginName(input.login); } catch { throw invalidCredentials(); }
      limiter.admit(input.address, login);
      const observed = find(login);
      // Disabled and managed accounts perform the same dummy work as an unknown
      // login. A username, localhost, or an email never creates an identity.
      const checked = await passwords.verify(input.password, live(observed) ? observed.password_hash : null);
      if (!checked.valid || !live(observed)) throw invalidCredentials();
      const upgraded = checked.needsRehash ? await passwords.hash(input.password) : null;
      return control.transaction(() => {
        if (!unchanged(observed, find(login))) throw invalidCredentials();
        if (upgraded) {
          control.run('UPDATE password_credentials SET password_hash=?,changed_at_ms=? WHERE user_id=?', upgraded, now(), observed.user_id);
          control.audit(observed.user_id, 'auth.password-upgraded', observed.user_id);
        }
        return sessions.issue(observed.user_id, input.label);
      });
    },
    async reauthenticate(token: string, password: string, address?: string) {
      const actor = sessions.require(token), login = accountLogin(actor.userId);
      limiter.admit(address, login);
      const observed = find(login);
      const checked = await passwords.verify(password, live(observed) ? observed.password_hash : null);
      if (!checked.valid || !live(observed)) throw invalidCredentials();
      return control.transaction(() => {
        const current = sessions.require(token);
        if (current.id !== actor.id || !unchanged(observed, find(login))) throw invalidCredentials();
        control.run('UPDATE auth_sessions SET elevated_at_ms=?,revision=revision+1 WHERE id=?', now(), actor.id);
        control.audit(actor.userId, 'auth.reauthenticated', actor.id);
        return sessions.require(token);
      });
    },
    async changePassword(token: string, password: string) {
      const actor = sessions.require(token, true), login = accountLogin(actor.userId), observed = find(login);
      if (!live(observed)) throw invalidCredentials();
      validateNewPassword(password);
      const encoded = await passwords.hash(password);
      control.transaction(() => {
        sessions.require(token, true);
        if (!unchanged(observed, find(login))) throw controlError('conflict', 'Credentials changed; sign in again');
        control.run('UPDATE password_credentials SET password_hash=?,changed_at_ms=? WHERE user_id=?', encoded, now(), actor.userId);
        invalidate(actor.userId);
        control.audit(actor.userId, 'auth.password-changed', actor.userId);
      });
      // Every old session, including the caller, is invalid. Require a fresh
      // login rather than returning a cached token in a replay receipt.
    },
    async operatorResetPassword(input: { userId: string; password: string; installationId: string; reason: string }) {
      const installation = control.installation();
      if (input.installationId !== installation.id) throw controlError('forbidden', 'Installation confirmation does not match');
      breakGlassReason(input.reason);
      validateNewPassword(input.password);
      const observed = control.get<{ status: string; managed: number; auth_epoch: number; password_hash: string }>(
        `SELECT p.status,u.managed,p.auth_epoch,c.password_hash FROM principals p JOIN users u ON u.id=p.id
         JOIN password_credentials c ON c.user_id=p.id WHERE p.id=? AND p.kind='user'`, input.userId,
      );
      if (!observed || observed.status !== 'active' || observed.managed) throw controlError('not-found', 'Eligible local account not found');
      const encoded = await passwords.hash(input.password);
      control.transaction(() => {
        const current = control.get<{ status: string; managed: number; auth_epoch: number; password_hash: string }>(
          `SELECT p.status,u.managed,p.auth_epoch,c.password_hash FROM principals p JOIN users u ON u.id=p.id
           JOIN password_credentials c ON c.user_id=p.id WHERE p.id=? AND p.kind='user'`, input.userId,
        );
        if (!current || current.status !== 'active' || current.managed || current.auth_epoch !== observed.auth_epoch
          || current.password_hash !== observed.password_hash) throw controlError('conflict', 'Account credentials changed; retry break-glass recovery');
        control.run('UPDATE password_credentials SET password_hash=?,changed_at_ms=? WHERE user_id=?', encoded, now(), input.userId);
        invalidate(input.userId);
        control.audit('operator:break-glass', 'auth.break-glass-password-reset', input.userId);
      });
    },
    async recover(input: { login: string; code: string; password: string; address?: string }) {
      let login: string;
      try { login = loginName(input.login); } catch { throw invalidCredentials(); }
      limiter.admit(input.address, login);
      const observed = find(login), code = recoveryCode(input.code);
      const codeRow = code && observed ? control.get<{ id: string }>(
        'SELECT id FROM recovery_codes WHERE user_id=? AND code_hash=? AND used_at_ms IS NULL', observed.user_id, tokenHash('recovery', code),
      ) : undefined;
      if (!live(observed) || !codeRow) throw invalidCredentials();
      validateNewPassword(input.password);
      const encoded = await passwords.hash(input.password);
      control.transaction(() => {
        if (!unchanged(observed, find(login))) throw invalidCredentials();
        const consumed = control.run('UPDATE recovery_codes SET used_at_ms=? WHERE id=? AND user_id=? AND used_at_ms IS NULL', now(), codeRow.id, observed.user_id);
        if (Number(consumed.changes) !== 1) throw invalidCredentials();
        control.run('UPDATE password_credentials SET password_hash=?,changed_at_ms=? WHERE user_id=?', encoded, now(), observed.user_id);
        invalidate(observed.user_id);
        control.audit(observed.user_id, 'auth.recovery-used', observed.user_id);
      });
      // Recovery does not unsuspend users, restore memberships or grant roles.
    },
  };
}
