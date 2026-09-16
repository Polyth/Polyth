import { controlError, type ControlPlane } from '@polyth/control-plane';
import { validateNewPassword, type PasswordService } from './passwords.ts';
import { displayName, loginName, opaqueId } from './validation.ts';
import type { SessionService } from './sessions.ts';
import type { IdentityUser } from './types.ts';

const expected = (revision: number): void => {
  if (!Number.isSafeInteger(revision) || revision < 1) throw controlError('invalid-input', 'Expected revision is required');
};
export function createAccounts(control: ControlPlane, passwords: PasswordService, sessions: SessionService, now: () => number) {
  const hasOwnerRole = (userId: string): boolean => !!control.get(
    "SELECT 1 FROM instance_roles WHERE user_id=? AND role='owner'",
    userId,
  );
  const owner = (token: string, elevated = true): string => {
    const actor = sessions.require(token, elevated);
    if (!hasOwnerRole(actor.userId)) throw controlError('forbidden', 'Instance owner access required');
    return actor.userId;
  };
  const get = (id: string): IdentityUser => {
    const row = control.get<Omit<IdentityUser, 'managed'> & { managed: number }>(
      'SELECT u.id,u.display_name AS displayName,u.managed,p.status,p.revision FROM users u JOIN principals p ON p.id=u.id WHERE u.id=?', id,
    );
    if (!row) throw controlError('not-found', 'Account not found');
    return { ...row, managed: !!row.managed };
  };
  return {
    current(token: string): IdentityUser { return get(sessions.require(token).userId); },
    canManage(token: string): boolean { return hasOwnerRole(sessions.require(token).userId); },
    list(token: string): IdentityUser[] {
      const actor = sessions.require(token);
      if (!hasOwnerRole(actor.userId)) return [get(actor.userId)];
      return control.all<{ id: string }>(
        'SELECT u.id FROM users u JOIN principals p ON p.id=u.id ORDER BY u.created_at_ms,u.id',
      ).map(row => get(row.id));
    },
    async createLocal(token: string, input: { login: string; name: string; password: string }) {
      owner(token);
      const login = loginName(input.login), name = displayName(input.name);
      validateNewPassword(input.password);
      const encoded = await passwords.hash(input.password);
      return control.transaction(() => {
        const actor = owner(token);
        if (control.get('SELECT 1 FROM password_credentials WHERE login_name=?', login)) throw controlError('conflict', 'Login name is already in use');
        const id = opaqueId('usr'), time = now();
        control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
        control.run('INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)', id, name, time, time);
        control.run('INSERT INTO password_credentials VALUES(?,?,?,?)', id, login, encoded, time);
        control.bumpEpoch(); control.audit(actor, 'identity.local-account-created', id);
        // An account is NOT a grant of organization, Space or project access.
        return get(id);
      });
    },
    renameSelf(token: string, name: string, revision: number) {
      expected(revision); const normalized = displayName(name);
      return control.transaction(() => {
        const actor = sessions.require(token), user = get(actor.userId);
        if (user.managed) throw controlError('managed-identity', 'This profile is managed by its identity provider');
        if (user.revision !== revision) throw controlError('conflict', 'Account changed; refresh before saving');
        control.run('UPDATE users SET display_name=?,updated_at_ms=? WHERE id=?', normalized, now(), actor.userId);
        control.run('UPDATE principals SET revision=revision+1 WHERE id=?', actor.userId);
        control.audit(actor.userId, 'identity.profile-renamed', actor.userId);
        return get(actor.userId); // ID, credential mapping and auth epoch remain stable.
      });
    },
    setStatus(token: string, userId: string, status: IdentityUser['status'], revision: number) {
      expected(revision);
      if (!['active', 'suspended', 'offboarding', 'disabled'].includes(status)) throw controlError('invalid-input', 'Invalid account state');
      return control.transaction(() => {
        const actor = owner(token), user = get(userId);
        if (user.managed) throw controlError('managed-identity', 'This account lifecycle is externally managed');
        if (user.revision !== revision) throw controlError('conflict', 'Account changed; refresh before saving');
        if (user.status === status) return user;
        // Disabled/offboarding is not a reversible suspension. Provisioning and
        // offboarding workflows must perform the required cleanup explicitly.
        if (user.status === 'disabled' || (user.status === 'offboarding' && status !== 'disabled')) throw controlError('invalid-transition', 'Use the account restoration workflow');
        if (status !== 'active' && hasOwnerRole(userId)
          && !control.get("SELECT 1 FROM instance_roles r JOIN principals p ON p.id=r.user_id WHERE r.role='owner' AND p.status='active' AND p.id<>?", userId)) {
          throw controlError('last-owner', 'The last active instance owner must be preserved');
        }
        control.run('UPDATE principals SET status=?,revision=revision+1,auth_epoch=auth_epoch+1 WHERE id=?', status, userId);
        control.run('UPDATE users SET updated_at_ms=? WHERE id=?', now(), userId);
        control.run('DELETE FROM auth_sessions WHERE user_id=?', userId);
        control.bumpEpoch(); control.audit(actor, `identity.${status}`, userId);
        return get(userId);
      });
    },
  };
}
