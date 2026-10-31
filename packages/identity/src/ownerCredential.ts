// Protect a credential-less (`local`) owner later, when Polyth starts to admit
// other people or other ways in. The same owner gains the fixed `owner` login,
// a password and recovery codes; no data moves and the installation leaves
// `local` for good. Two steps, like setup: codes are prepared first and only
// become live with the password after the owner says they saved them.
import { controlError, type ControlPlane } from '@polyth/control-plane';
import { accessMode } from './access.ts';
import { validateNewPassword, type PasswordService } from './passwords.ts';
import { newRecoveryCodes, opaqueId, tokenHash } from './validation.ts';
import type { SessionService } from './sessions.ts';
import type { IdentitySession } from './types.ts';

/** The owner's login once protected; the same fixed login setup gives owners. */
export const OWNER_LOGIN = 'owner';

export function createOwnerCredential(control: ControlPlane, passwords: PasswordService, sessions: SessionService, now: () => number) {
  /** The signed-in local owner who has no credential yet, in a session the
   *  Desktop main process confirmed within the last five minutes. */
  const unprotectedOwner = (token: string): IdentitySession => {
    const actor = sessions.require(token);
    if (!control.get("SELECT 1 FROM instance_roles WHERE user_id=? AND role='owner'", actor.userId)) {
      throw controlError('forbidden', 'Instance owner access required');
    }
    if (accessMode(control) !== 'local' || control.get('SELECT 1 FROM password_credentials WHERE user_id=?', actor.userId)) {
      throw controlError('invalid-transition', 'This account is already protected');
    }
    // A live cookie alone (copied, or days old) must never pick the owner's
    // password: only the Desktop app's in-process confirmation counts.
    const time = now();
    if (actor.elevatedAt === null || time - actor.elevatedAt >= 5 * 60_000 || actor.elevatedAt > time) {
      throw controlError('owner-confirmation-required', 'Confirm on this computer in the Polyth app');
    }
    return actor;
  };
  return {
    prepareRecovery(token: string): { setId: string; codes: string[] } {
      return control.transaction(() => {
        const actor = unprotectedOwner(token);
        const setId = opaqueId('rcv'), codes = newRecoveryCodes(), time = now();
        control.run('DELETE FROM owner_credential_recovery WHERE user_id=?', actor.userId);
        for (const code of codes) {
          control.run('INSERT INTO owner_credential_recovery(user_id,set_id,code_hash,created_at_ms) VALUES(?,?,?,?)', actor.userId, setId, tokenHash('recovery', code), time);
        }
        control.audit(actor.userId, 'auth.owner-recovery-prepared', actor.userId);
        return { setId, codes };
      });
    },
    async establish(token: string, request: { password: string; recoverySetId: string; recoveryAcknowledged: boolean }): Promise<{ login: string }> {
      // Capture primitives before awaiting the KDF, as setup does.
      const input = { ...request };
      validateNewPassword(input.password);
      if (input.recoveryAcknowledged !== true) throw controlError('recovery-ack-required', 'Save your recovery codes before continuing');
      if (typeof input.recoverySetId !== 'string' || !/^rcv_[a-f0-9-]{36}$/.test(input.recoverySetId)) {
        throw controlError('recovery-ack-required', 'Save the current recovery codes before continuing');
      }
      const observed = unprotectedOwner(token);
      const encoded = await passwords.hash(input.password); // outside BEGIN IMMEDIATE
      return control.transaction(() => {
        const actor = unprotectedOwner(token);
        if (actor.id !== observed.id) throw controlError('conflict', 'Your session changed; try again');
        const codes = control.all<{ code_hash: string }>(
          'SELECT code_hash FROM owner_credential_recovery WHERE user_id=? AND set_id=?', actor.userId, input.recoverySetId,
        );
        if (codes.length !== 8) throw controlError('recovery-ack-required', 'Save the current recovery codes before continuing');
        if (control.get('SELECT 1 FROM password_credentials WHERE login_name=?', OWNER_LOGIN)) {
          throw controlError('conflict', 'Login name is already in use');
        }
        const time = now();
        control.run('INSERT INTO password_credentials VALUES(?,?,?,?)', actor.userId, OWNER_LOGIN, encoded, time);
        for (const code of codes) {
          control.run('INSERT INTO recovery_codes(id,user_id,set_id,code_hash,created_at_ms) VALUES(?,?,?,?,?)', opaqueId('rc'), actor.userId, input.recoverySetId, code.code_hash, time);
        }
        control.run('DELETE FROM owner_credential_recovery WHERE user_id=?', actor.userId);
        control.run("UPDATE installation SET access_mode='accounts',revision=revision+1 WHERE singleton=1");
        // The owner just chose this password: the next protected step (adding
        // a person) needs no second confirmation, exactly as after setup.
        control.run('UPDATE auth_sessions SET elevated_at_ms=?,revision=revision+1 WHERE id=?', time, actor.id);
        control.bumpEpoch();
        control.audit(actor.userId, 'auth.owner-credential-established', actor.userId);
        return { login: OWNER_LOGIN };
      });
    },
  };
}
export type OwnerCredentialService = ReturnType<typeof createOwnerCredential>;
