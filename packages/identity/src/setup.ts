import { controlError, type ControlPlane } from '@polyth/control-plane';
import { validateNewPassword, type PasswordService } from './passwords.ts';
import { displayName, loginName, newToken, newRecoveryCodes, opaqueId, tokenHash, validToken } from './validation.ts';
import type { SessionService } from './sessions.ts';
import type { SetupStatus } from './types.ts';

interface Claim { id: string; owner_user_id: string; browser_binding_hash: string | null; expires_at_ms: number; consumed_at_ms: number | null; revision: number }
export interface CompleteSetup {
  claimToken: string; browserBinding: string; name: string; organizationName: string;
  login: string; password: string; recoverySetId: string; recoveryAcknowledged: boolean;
}
export function createSetup(control: ControlPlane, passwords: PasswordService, sessions: SessionService, now: () => number, passkeysAvailable: () => boolean = () => false) {
  const assertSetup = (): void => {
    const state = control.installation().state;
    if (state === 'ready') throw controlError('setup-completed', 'Setup is complete; sign in to continue');
    if (state === 'recovery') throw controlError('recovery-required', 'Operator recovery is required');
    if (control.get('SELECT 1 FROM users LIMIT 1')) throw controlError('recovery-required', 'Existing identities require operator recovery');
  };
  const claimFor = (token: string, binding?: string): Claim => {
    assertSetup();
    if (!validToken(token) || (binding !== undefined && !validToken(binding))) throw controlError('invalid-claim', 'Setup claim is invalid or expired');
    const row = control.get<Claim>('SELECT id,owner_user_id,browser_binding_hash,expires_at_ms,consumed_at_ms,revision FROM setup_claims WHERE token_hash=? AND installation_id=?', tokenHash('setup', token), control.installation().id);
    if (!row || row.consumed_at_ms !== null || row.expires_at_ms <= now()
      || (binding !== undefined && row.browser_binding_hash !== tokenHash('browser', binding))) {
      throw controlError('invalid-claim', 'Setup claim is invalid or expired');
    }
    return row;
  };
  return {
    status(): SetupStatus { return { state: control.installation().state, methods: passkeysAvailable() ? ['password', 'passkey'] : ['password'] }; },
    /** Operator-only: expose through an app-owned console/installer, NEVER a
     * public HTTP endpoint. Rotating a claim invalidates the prior browser. */
    issueClaim() {
      return control.transaction(() => {
        assertSetup();
        const token = newToken(), id = opaqueId('claim'), expiresAt = now() + 15 * 60_000;
        control.run('DELETE FROM setup_recovery');
        control.run('DELETE FROM setup_claims WHERE consumed_at_ms IS NULL');
        control.run('INSERT INTO setup_claims(id,installation_id,owner_user_id,token_hash,expires_at_ms) VALUES(?,?,?,?,?)', id, control.installation().id, opaqueId('usr'), tokenHash('setup', token), expiresAt);
        control.run("UPDATE installation SET state='uninitialized',revision=revision+1 WHERE singleton=1");
        control.audit('system:setup', 'setup.claim-issued', id);
        return { token, expiresAt };
      });
    },
    bindClaim(token: string, browserBinding: string) {
      return control.transaction(() => {
        const row = claimFor(token);
        if (!validToken(browserBinding)) throw controlError('invalid-claim', 'Setup claim is invalid or expired');
        const binding = tokenHash('browser', browserBinding);
        if (row.browser_binding_hash && row.browser_binding_hash !== binding) throw controlError('invalid-claim', 'Setup claim is invalid or expired');
        if (!row.browser_binding_hash) {
          control.run('UPDATE setup_claims SET browser_binding_hash=?,revision=revision+1 WHERE id=?', binding, row.id);
          control.run("UPDATE installation SET state='claimed',revision=revision+1 WHERE singleton=1");
          control.audit('system:setup', 'setup.claim-bound', row.id);
        }
        return { expiresAt: row.expires_at_ms };
      });
    },
    prepareRecovery(token: string, browserBinding: string) {
      return control.transaction(() => {
        const row = claimFor(token, browserBinding);
        const setId = opaqueId('rcv'), codes = newRecoveryCodes();
        control.run('DELETE FROM setup_recovery WHERE claim_id=?', row.id);
        for (const code of codes) control.run('INSERT INTO setup_recovery VALUES(?,?,?)', row.id, setId, tokenHash('recovery', code));
        control.run('UPDATE setup_claims SET revision=revision+1 WHERE id=?', row.id);
        control.run("UPDATE installation SET state='configuring',revision=revision+1 WHERE singleton=1");
        control.audit('system:setup', 'setup.recovery-prepared', row.id);
        return { setId, codes };
      });
    },
    async complete(request: CompleteSetup) {
      // Capture primitives before awaiting the KDF; a reused request object
      // must not switch claim/binding or recovery acknowledgement mid-flight.
      const input = { ...request };
      const name = displayName(input.name), orgName = displayName(input.organizationName), login = loginName(input.login);
      validateNewPassword(input.password);
      if (input.recoveryAcknowledged !== true) throw controlError('recovery-ack-required', 'Save your recovery codes before continuing');
      const observed = claimFor(input.claimToken, input.browserBinding);
      const encoded = await passwords.hash(input.password); // outside BEGIN IMMEDIATE
      return control.transaction(() => {
        const row = claimFor(input.claimToken, input.browserBinding);
        if (row.revision !== observed.revision) throw controlError('conflict', 'Setup changed; review the current recovery codes');
        const codes = control.all<{ code_hash: string }>('SELECT code_hash FROM setup_recovery WHERE claim_id=? AND set_id=?', row.id, input.recoverySetId);
        if (codes.length !== 8) throw controlError('recovery-ack-required', 'Save the current recovery codes before continuing');
        const userId = row.owner_user_id, orgId = opaqueId('org'), spaceId = opaqueId('spc'), time = now();
        control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", userId);
        control.run('INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)', userId, name, time, time);
        control.run('INSERT INTO password_credentials VALUES(?,?,?,?)', userId, login, encoded, time);
        control.run('INSERT INTO organizations(id,name,slug) VALUES(?,?,?)', orgId, orgName, orgId);
        control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES(?,?,'owner')", orgId, userId);
        control.run("INSERT INTO instance_roles(user_id,role) VALUES(?,'owner')", userId);
        control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,created_at_ms,updated_at_ms) VALUES(?,?,'Personal',?,'personal',1,?,?)", spaceId, orgId, spaceId, time, time);
        control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES(?,?,'owner',?)", spaceId, userId, time);
        for (const code of codes) control.run('INSERT INTO recovery_codes(id,user_id,set_id,code_hash,created_at_ms) VALUES(?,?,?,?,?)', opaqueId('rc'), userId, input.recoverySetId, code.code_hash, time);
        control.run('DELETE FROM setup_recovery WHERE claim_id=?', row.id);
        control.run('UPDATE setup_claims SET consumed_at_ms=?,revision=revision+1 WHERE id=?', time, row.id);
        control.run("UPDATE installation SET state='ready',revision=revision+1,authority_epoch=authority_epoch+1 WHERE singleton=1");
        control.audit(userId, 'setup.completed', userId);
        return { userId, organizationId: orgId, spaceId, ...sessions.issue(userId, 'Setup browser') };
      });
    },
  };
}
