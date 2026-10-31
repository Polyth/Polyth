import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed, prepared } from './fixtures.ts';

// "Just me" first run of Polyth Desktop: an owner without any credential, an
// owner session only through the in-process Desktop channel, and protection
// added later without moving data. Nothing here may open a second way in.

const DESKTOP = 'Polyth Desktop';

test('a password-less first run provisions the same owner, organization and Space, and no credential', t => {
  const f = fixture(t);
  const owner = f.identity.setup.completeLocal({ name: 'Ida Lindqvist' });
  assert.match(owner.userId, /^usr_[a-f0-9-]{36}$/);
  assert.equal(f.identity.setup.status().state, 'ready');
  assert.equal(f.identity.accessMode(), 'local');
  assert.equal(f.control.get<{ display_name: string }>('SELECT display_name FROM users')?.display_name, 'Ida Lindqvist');
  assert.equal(f.control.get<{ role: string }>('SELECT role FROM instance_roles WHERE user_id=?', owner.userId)?.role, 'owner');
  const space = f.control.get<{ id: string; kind: string; is_default: number }>('SELECT id,kind,is_default FROM spaces')!;
  assert.deepEqual([space.id, space.kind, space.is_default], [owner.spaceId, 'personal', 1]);
  assert.equal(f.control.get<{ role: string }>('SELECT role FROM space_memberships WHERE principal_id=?', owner.userId)?.role, 'owner');
  for (const table of ['password_credentials', 'recovery_codes', 'auth_sessions', 'passkey_credentials', 'login_identities']) {
    assert.equal(f.control.all(`SELECT * FROM ${table}`).length, 0, `${table} stays empty`);
  }
  assert.equal(f.control.all("SELECT * FROM audit_events WHERE action='setup.completed-local'").length, 1);
  assert.throws(() => f.identity.setup.completeLocal({ name: 'Second' }), { code: 'setup-completed' });
  assert.throws(() => f.identity.setup.issueClaim(), { code: 'setup-completed' });
});

test('a password-less first run ends every half-finished browser setup', async t => {
  const f = fixture(t), p = prepared(f);
  f.identity.setup.completeLocal({ name: 'Ida' });
  assert.equal(f.control.all('SELECT * FROM setup_recovery').length, 0);
  assert.equal(f.control.all('SELECT * FROM setup_claims WHERE consumed_at_ms IS NULL').length, 0);
  await assert.rejects(f.identity.setup.complete(p.input), { code: 'setup-completed' });
  assert.equal(f.control.all('SELECT * FROM users').length, 1);
});

test('a password-less first run validates the name and never runs over an existing owner', async t => {
  const f = fixture(t);
  assert.throws(() => f.identity.setup.completeLocal({ name: '  ' }), { code: 'invalid-input' });
  assert.throws(() => f.identity.setup.completeLocal({ name: 'x'.repeat(81) }), { code: 'invalid-input' });
  assert.equal(f.identity.setup.status().state, 'uninitialized');
  await installed(f);
  assert.throws(() => f.identity.setup.completeLocal({ name: 'Intruder' }), { code: 'setup-completed' });
  assert.equal(f.identity.accessMode(), 'accounts');
});

test('only the in-process Desktop channel opens a session, and each launch replaces the previous one', t => {
  const f = fixture(t);
  assert.equal(f.identity.issueLocalOwnerSession(DESKTOP), null, 'nothing before setup');
  const owner = f.identity.setup.completeLocal({ name: 'Ida' });
  const first = f.identity.issueLocalOwnerSession(DESKTOP)!;
  assert.equal(f.identity.sessions.resolve(first.token)?.userId, owner.userId);
  assert.equal(first.session.elevatedAt, null, 'a launch is not a fresh confirmation');
  assert.equal(f.identity.sessions.resolve(first.token)?.elevatedAt, null);
  const second = f.identity.issueLocalOwnerSession(DESKTOP)!;
  assert.equal(f.identity.sessions.resolve(first.token), null, 'the previous launch session ends');
  assert.equal(f.identity.sessions.resolve(second.token)?.userId, owner.userId);
  assert.equal(f.control.all('SELECT * FROM auth_sessions').length, 1);
  assert.ok(!JSON.stringify(f.control.all('SELECT * FROM auth_sessions')).includes(second.token));
});

test('an installation with accounts never hands out a credential-less owner session', async t => {
  const f = fixture(t);
  await installed(f);
  assert.equal(f.identity.accessMode(), 'accounts');
  assert.equal(f.identity.issueLocalOwnerSession(DESKTOP), null);
  // Once ready, `local` can never be switched on, not even by a direct write.
  assert.throws(() => f.control.transaction(() => f.control.run("UPDATE installation SET access_mode='local' WHERE singleton=1")), /invalid-transition/);
  assert.equal(f.identity.accessMode(), 'accounts');
});

test('without a credential, nobody else and no other way in can be added', async t => {
  const f = fixture(t);
  f.identity.setup.completeLocal({ name: 'Ida' });
  const { token } = f.identity.issueLocalOwnerSession(DESKTOP)!;
  f.advance(6 * 60_000); // past the fresh-session window: elevation is not what blocks
  await assert.rejects(f.identity.accounts.createLocal(token, { login: 'guest', name: 'Guest', password: 'guest test passphrase' }), { code: 'owner-credential-required' });
  assert.throws(() => f.identity.passkeys.beginRegistration(token, 'Laptop'), { code: 'owner-credential-required' });
  assert.throws(() => f.identity.requireOwnerCredential(), { code: 'owner-credential-required' });
  assert.equal(f.control.all('SELECT * FROM users').length, 1);
  // The gate never answers before authentication.
  await assert.rejects(f.identity.accounts.createLocal('ab'.repeat(32), { login: 'guest', name: 'Guest', password: 'guest test passphrase' }), { code: 'unauthorized' });
});

test('protecting the account later keeps the owner and their data and leaves local access for good', async t => {
  const f = fixture(t);
  const owner = f.identity.setup.completeLocal({ name: 'Ida' });
  const { token } = f.identity.issueLocalOwnerSession(DESKTOP)!;
  f.advance(6 * 60_000);
  assert.equal(f.identity.confirmLocalOwnerSession(DESKTOP, token), true);
  const recovery = f.identity.ownerCredential.prepareRecovery(token);
  assert.equal(recovery.codes.length, 8);
  assert.equal(f.control.all('SELECT * FROM recovery_codes').length, 0, 'codes are not live before the password');
  await assert.rejects(f.identity.ownerCredential.establish(token, { password: 'owner test passphrase', recoverySetId: recovery.setId, recoveryAcknowledged: false }), { code: 'recovery-ack-required' });
  await assert.rejects(f.identity.ownerCredential.establish(token, { password: 'short', recoverySetId: recovery.setId, recoveryAcknowledged: true }), { code: 'invalid-input' });
  // A replaced set can no longer finish the step.
  const current = f.identity.ownerCredential.prepareRecovery(token);
  await assert.rejects(f.identity.ownerCredential.establish(token, { password: 'owner test passphrase', recoverySetId: recovery.setId, recoveryAcknowledged: true }), { code: 'recovery-ack-required' });
  assert.equal(f.identity.accessMode(), 'local');

  assert.deepEqual(await f.identity.ownerCredential.establish(token, { password: 'owner test passphrase', recoverySetId: current.setId, recoveryAcknowledged: true }), { login: 'owner' });
  assert.equal(f.identity.accessMode(), 'accounts');
  assert.equal(f.control.all('SELECT * FROM users').length, 1);
  assert.equal(f.control.all('SELECT * FROM recovery_codes WHERE user_id=?', owner.userId).length, 8);
  assert.equal(f.control.all('SELECT * FROM owner_credential_recovery').length, 0);
  assert.equal(f.identity.sessions.resolve(token)?.userId, owner.userId, 'the Desktop window stays signed in');
  assert.equal(f.identity.issueLocalOwnerSession(DESKTOP), null, 'Desktop no longer opens sessions');
  assert.throws(() => f.control.transaction(() => f.control.run("UPDATE installation SET access_mode='local' WHERE singleton=1")), /invalid-transition/);

  const signedIn = await f.identity.credentials.login({ login: 'owner', password: 'owner test passphrase' });
  assert.equal(signedIn.session.userId, owner.userId);
  // The owner just chose the password: adding the first person needs no second prompt.
  const guest = await f.identity.accounts.createLocal(token, { login: 'guest', name: 'Guest', password: 'guest test passphrase' });
  assert.equal(guest.login, 'guest');
  assert.throws(() => f.identity.ownerCredential.prepareRecovery(signedIn.token), { code: 'invalid-transition' });
  // The saved codes work like the codes from setup (and end every session).
  await f.identity.credentials.recover({ login: 'owner', code: current.codes[0]!, password: 'a new owner passphrase' });
  assert.equal(f.identity.sessions.resolve(token), null);
  const persisted = JSON.stringify([f.control.all('SELECT * FROM recovery_codes'), f.control.all('SELECT * FROM audit_events'), f.control.all('SELECT * FROM password_credentials')]);
  for (const secret of [...current.codes, ...recovery.codes, 'owner test passphrase']) assert.ok(!persisted.includes(secret));
});

test('protecting the account needs the owner session of a local installation', async t => {
  const f = fixture(t);
  assert.throws(() => f.identity.ownerCredential.prepareRecovery('ab'.repeat(32)), { code: 'unauthorized' });
  const { owner } = await installed(f);
  assert.throws(() => f.identity.ownerCredential.prepareRecovery(owner.token), { code: 'invalid-transition' });
  await assert.rejects(f.identity.ownerCredential.establish(owner.token, { password: 'another passphrase', recoverySetId: 'rcv_00000000-0000-0000-0000-000000000000', recoveryAcknowledged: true }), { code: 'invalid-transition' });
});

const policy = {
  normalizeGrants(raw: unknown): string[] {
    if (!Array.isArray(raw) || !raw.every((grant) => typeof grant === 'string')) throw Object.assign(new Error('bad'), { code: 'invalid-input' });
    return [...raw] as string[];
  },
  profiles: { control: ['core.sessions.control'], read: ['core.sessions.read'] },
};

test('without a credential, actions that need a recent sign-in ask for a password first, even right after launch', t => {
  const f = fixture(t, { accessTokens: policy });
  f.identity.setup.completeLocal({ name: 'Ida' });
  const { token } = f.identity.issueLocalOwnerSession(DESKTOP)!;
  // Fresh session: a timestamp alone must not stand in for a credential.
  assert.throws(() => f.identity.sessions.require(token, true), { code: 'owner-credential-required' });
  assert.throws(() => f.identity.accessTokens.trust.set(token, 'loopback', 0), { code: 'owner-credential-required' });
  assert.equal(f.identity.accessTokens.trust.effective(), null);
  // No CLI token, and no CLI sign-in someone else started, without a credential.
  assert.throws(() => f.identity.accessTokens.create(token, { label: 'x', profile: 'control', expiresInDays: null }), { code: 'owner-credential-required' });
  const start = f.identity.accessTokens.device.start({ label: 'cli', address: '127.0.0.1' });
  assert.throws(() => f.identity.accessTokens.device.decide(token, start.userCode, true), { code: 'owner-credential-required' });
  assert.equal(f.identity.accessTokens.device.redeem(start.deviceCode).status, 'pending');
  f.identity.accessTokens.device.decide(token, start.userCode, false); // refusing needs nothing
  // Not even right after the Desktop app confirmed the session.
  assert.equal(f.identity.confirmLocalOwnerSession(DESKTOP, token), true);
  assert.throws(() => f.identity.accessTokens.trust.set(token, 'loopback', 0), { code: 'owner-credential-required' });
  assert.equal(f.identity.sessions.require(token).userId, f.control.get<{ id: string }>('SELECT id FROM users')!.id, 'ordinary use keeps working');
});

test('only a session the Desktop app confirmed in the last minutes may choose the first password', async t => {
  const f = fixture(t);
  f.identity.setup.completeLocal({ name: 'Ida' });
  const { token } = f.identity.issueLocalOwnerSession(DESKTOP)!;
  // A live cookie alone, however it was obtained, cannot pick the password.
  assert.throws(() => f.identity.ownerCredential.prepareRecovery(token), { code: 'owner-confirmation-required' });
  assert.equal(f.identity.confirmLocalOwnerSession('Some browser', token), false, 'only the Desktop session');
  assert.equal(f.identity.confirmLocalOwnerSession(DESKTOP, 'ab'.repeat(32)), false);
  assert.equal(f.identity.confirmLocalOwnerSession(DESKTOP, token), true);
  const recovery = f.identity.ownerCredential.prepareRecovery(token);
  f.advance(6 * 60_000); // the person read the codes for a while
  await assert.rejects(f.identity.ownerCredential.establish(token, { password: 'owner test passphrase', recoverySetId: recovery.setId, recoveryAcknowledged: true }), { code: 'owner-confirmation-required' });
  assert.equal(f.identity.confirmLocalOwnerSession(DESKTOP, token), true);
  assert.deepEqual(await f.identity.ownerCredential.establish(token, { password: 'owner test passphrase', recoverySetId: recovery.setId, recoveryAcknowledged: true }), { login: 'owner' });
  assert.equal(f.identity.confirmLocalOwnerSession(DESKTOP, token), false, 'nothing to confirm once protected');
});

test('local access can never come back: not by update, re-insert or delete of the installation row', async t => {
  const f = fixture(t);
  f.identity.setup.completeLocal({ name: 'Ida' });
  const { token } = f.identity.issueLocalOwnerSession(DESKTOP)!;
  f.identity.confirmLocalOwnerSession(DESKTOP, token);
  const recovery = f.identity.ownerCredential.prepareRecovery(token);
  await f.identity.ownerCredential.establish(token, { password: 'owner test passphrase', recoverySetId: recovery.setId, recoveryAcknowledged: true });
  const row = f.control.get<Record<string, string | number>>('SELECT * FROM installation WHERE singleton=1')!;
  const columns = Object.keys(row);
  assert.throws(() => f.control.transaction(() => f.control.run(
    `INSERT OR REPLACE INTO installation(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    ...columns.map((column) => (column === 'access_mode' ? 'local' : row[column]!)),
  )), /invalid-transition/);
  assert.equal(f.identity.accessMode(), 'accounts');
  assert.equal(f.identity.issueLocalOwnerSession(DESKTOP), null);
  // Deleting the row fails closed; putting it back as 'local' is refused.
  f.control.transaction(() => f.control.run('DELETE FROM installation'));
  assert.throws(() => f.control.transaction(() => f.control.run(
    `INSERT INTO installation(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    ...columns.map((column) => (column === 'access_mode' ? 'local' : row[column]!)),
  )), /invalid-transition/);
  assert.throws(() => f.identity.issueLocalOwnerSession(DESKTOP), { code: 'recovery-required' });
});
