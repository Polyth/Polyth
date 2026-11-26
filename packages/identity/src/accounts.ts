import { controlError, type ControlPlane } from '@polyth/control-plane';
import { validateNewPassword, type PasswordService } from './passwords.ts';
import { displayName, loginName, opaqueId } from './validation.ts';
import { requireOwnerCredential } from './access.ts';
import { OWNER_LOGIN } from './ownerCredential.ts';
import type { SessionService } from './sessions.ts';
import type { IdentityUser } from './types.ts';

/** Someone else chose this password: an owner creating or resetting the
 *  account, or the operator's break-glass recovery. */
const ADMIN_SET_PASSWORD = ['identity.local-account-created', 'auth.password-reset', 'auth.break-glass-password-reset'] as const;
/** The holder chose it themselves. */
const SELF_SET_PASSWORD = ['auth.password-changed', 'auth.recovery-used', 'auth.owner-credential-established', 'setup.completed', 'auth.desktop-owner-password-reset'] as const;
const PASSWORD_SETTERS = [...ADMIN_SET_PASSWORD, ...SELF_SET_PASSWORD];

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
    const row = control.get<Omit<IdentityUser, 'managed' | 'login'> & { managed: number; login: string | null }>(
      `SELECT u.id,u.display_name AS displayName,c.login_name AS login,u.managed,p.status,p.revision
         FROM users u JOIN principals p ON p.id=u.id
         LEFT JOIN password_credentials c ON c.user_id=u.id
        WHERE u.id=?`, id,
    );
    if (!row) throw controlError('not-found', 'Account not found');
    const { login, ...rest } = row;
    return { ...rest, ...(login ? { login } : {}), managed: !!row.managed };
  };
  /** The single active instance owner. Local-only loopback-trusted profiles
   *  (agent beta / local debug agent access) project this account without a
   *  browser credential; no other caller may assume an owner. */
  const activeOwnerUserId = (): string | undefined => control.get<{ user_id: string }>(
    `SELECT r.user_id FROM instance_roles r JOIN principals p ON p.id=r.user_id
      WHERE r.role='owner' AND p.status='active' AND p.kind='user' ORDER BY r.user_id LIMIT 1`,
  )?.user_id;
  /** `owner` is the login setup and owner protection hand the instance owner
   *  (and the recovery file names); nobody else may take it, even once freed. */
  const reservedLogin = (login: string, userId?: string): boolean => login === OWNER_LOGIN && !(userId && hasOwnerRole(userId));
  /** Moves an account's password sign-in to another login. The password,
   *  passkeys (keyed by account ID), recovery codes and sessions stay; only
   *  the name typed at sign-in changes. Never shown to agents or Git. */
  const setLogin = (actor: string, userId: string, login: string, revision: number): IdentityUser => {
    const user = get(userId);
    if (user.managed) throw controlError('managed-identity', 'This account signs in through its identity provider');
    if (user.revision !== revision) throw controlError('conflict', 'Account changed; refresh before saving');
    if (!user.login) throw controlError('invalid-input', 'This account has no password sign-in');
    if (user.login === login) return user;
    if (reservedLogin(login, userId) || control.get('SELECT 1 FROM password_credentials WHERE login_name=? AND user_id<>?', login, userId)) {
      throw controlError('login-taken', 'Login name is already in use');
    }
    control.run('UPDATE password_credentials SET login_name=? WHERE user_id=?', login, userId);
    control.run('UPDATE principals SET revision=revision+1 WHERE id=?', userId);
    control.audit(actor, 'identity.login-changed', userId);
    return get(userId);
  };
  /** Owners see every account; anyone else only their own. */
  const listFor = (userId: string): IdentityUser[] => {
    if (!hasOwnerRole(userId)) return [get(userId)];
    return control.all<{ id: string }>(
      'SELECT u.id FROM users u JOIN principals p ON p.id=u.id ORDER BY u.created_at_ms,u.id',
    ).map(row => get(row.id));
  };
  // Every password write stores a freshly salted hash, so the audit answer is
  // read once per write instead of on every request.
  const changeRequired = new Map<string, { hash: string; required: boolean }>();
  const passwordChangeRequired = (userId: string): boolean => {
    const credential = control.get<{ password_hash: string }>('SELECT password_hash FROM password_credentials WHERE user_id=?', userId);
    if (!credential) { changeRequired.delete(userId); return false; }
    const cached = changeRequired.get(userId);
    if (cached && cached.hash === credential.password_hash) return cached.required;
    const latest = control.get<{ action: string }>(
      `SELECT action FROM audit_events WHERE resource_id=? AND action IN (${PASSWORD_SETTERS.map(() => '?').join(',')})
        ORDER BY seq DESC LIMIT 1`,
      userId, ...PASSWORD_SETTERS,
    );
    const required = !!latest && (ADMIN_SET_PASSWORD as readonly string[]).includes(latest.action);
    changeRequired.set(userId, { hash: credential.password_hash, required });
    return required;
  };
  return {
    activeOwnerUserId,
    /** The password was set by someone else (an owner creating or resetting
     *  the account, or break-glass recovery) and the holder has not chosen
     *  their own since. Until they do, the session may only change it. */
    passwordChangeRequired,
    /** When someone else last set this person's password, while they haven't
     *  set their own since. Read from the append-only audit log, which no UI
     *  can edit, so it stays until they themselves take the account back. */
    adminPasswordResetAt(userId: string): number | undefined {
      const reset = control.get<{ at: number; seq: number }>(
        `SELECT occurred_at_ms AS at,seq FROM audit_events
          WHERE resource_id=? AND action IN ('auth.password-reset','auth.break-glass-password-reset')
          ORDER BY seq DESC LIMIT 1`,
        userId,
      );
      if (!reset) return undefined;
      const retaken = control.get(
        "SELECT 1 FROM audit_events WHERE resource_id=? AND actor_id=? AND action IN ('auth.password-changed','auth.desktop-owner-password-reset') AND seq>? LIMIT 1",
        userId, userId, reset.seq,
      );
      return retaken ? undefined : reset.at;
    },
    current(token: string): IdentityUser { return get(sessions.require(token).userId); },
    canManage(token: string): boolean { return hasOwnerRole(sessions.require(token).userId); },
    list(token: string): IdentityUser[] { return listFor(sessions.require(token).userId); },
    /** Reads for an account the host authenticated without a browser session
     *  (a full-access paired device). They grant no administration. */
    byUser: {
      current: get,
      isOwner: hasOwnerRole,
      list: listFor,
    },
    async createLocal(token: string, input: { login: string; name: string; password: string }) {
      // A credential-less owner protects their own account before anyone else
      // gets one; checked before the elevation a password-less owner can't give.
      sessions.require(token);
      requireOwnerCredential(control);
      owner(token);
      const login = loginName(input.login), name = displayName(input.name);
      validateNewPassword(input.password);
      const encoded = await passwords.hash(input.password);
      return control.transaction(() => {
        requireOwnerCredential(control);
        const actor = owner(token);
        if (reservedLogin(login) || control.get('SELECT 1 FROM password_credentials WHERE login_name=?', login)) throw controlError('login-taken', 'Login name is already in use');
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
    /** Instance owner renames another account. The login, ID and sessions stay. */
    renameAccount(token: string, userId: string, name: string, revision: number) {
      expected(revision); const normalized = displayName(name);
      return control.transaction(() => {
        const actor = owner(token), user = get(userId);
        if (user.managed) throw controlError('managed-identity', 'This profile is managed by its identity provider');
        if (user.revision !== revision) throw controlError('conflict', 'Account changed; refresh before saving');
        control.run('UPDATE users SET display_name=?,updated_at_ms=? WHERE id=?', normalized, now(), userId);
        control.run('UPDATE principals SET revision=revision+1 WHERE id=?', userId);
        control.audit(actor, 'identity.profile-renamed', userId);
        return get(userId);
      });
    },
    /** A person changes their own login. Like a password change it needs a
     *  recent password confirmation; unlike one, no session ends. */
    changeLogin(token: string, login: string, revision: number) {
      expected(revision); const normalized = loginName(login);
      return control.transaction(() => {
        const actor = sessions.require(token, true);
        return setLogin(actor.userId, actor.userId, normalized, revision);
      });
    },
    /** Instance owner moves another account to a new login (e.g. a typo or a
     *  new naming scheme). Its holder signs in with the new login from then on. */
    changeAccountLogin(token: string, userId: string, login: string, revision: number) {
      expected(revision); const normalized = loginName(login);
      return control.transaction(() => setLogin(owner(token), userId, normalized, revision));
    },
    /**
     * Instance owner sets a new password for another local account, e.g. one
     * whose holder forgot it. Every session of that account ends. Owners change
     * their own password through the elevated self-service flow instead.
     */
    async resetPassword(token: string, userId: string, password: string) {
      owner(token);
      validateNewPassword(password);
      const encoded = await passwords.hash(password);
      return control.transaction(() => {
        const actor = owner(token), user = get(userId);
        if (actor === userId || hasOwnerRole(userId)) throw controlError('forbidden', 'Owners change their own password in Account settings');
        if (user.managed) throw controlError('managed-identity', 'This account signs in through its identity provider');
        if (user.status === 'disabled' || user.status === 'offboarding') throw controlError('invalid-transition', 'This account is disabled');
        if (!control.get('SELECT 1 FROM password_credentials WHERE user_id=?', userId)) {
          throw controlError('invalid-input', 'This account has no password sign-in');
        }
        control.run('UPDATE password_credentials SET password_hash=?,changed_at_ms=? WHERE user_id=?', encoded, now(), userId);
        control.run('UPDATE principals SET auth_epoch=auth_epoch+1 WHERE id=?', userId);
        control.run('DELETE FROM auth_sessions WHERE user_id=?', userId);
        control.bumpEpoch(); control.audit(actor, 'auth.password-reset', userId);
        return get(userId);
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
