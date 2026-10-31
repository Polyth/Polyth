import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed, testPasswords, deferred } from './fixtures.ts';

test('login resolves an opaque user; wrong/unknown/managed accounts never create a user', async t => {
  const f = fixture(t), { owner, input } = await installed(f);
  const signed = await f.identity.credentials.login({ login: ' Max ', password: input.password });
  assert.equal(signed.session.userId, owner.userId);
  for (const [login, password] of [['missing', input.password], ['Max', 'wrong']]) {
    await assert.rejects(f.identity.credentials.login({ login: login!, password: password! }), { code: 'invalid-credentials' });
  }
  assert.equal(f.control.all('SELECT * FROM users').length, 1);
  f.control.transaction(() => f.control.run('UPDATE users SET managed=1 WHERE id=?', owner.userId));
  await assert.rejects(f.identity.credentials.login({ login: 'Max', password: input.password }), { code: 'invalid-credentials' });
});
test('creating another account gives no implicit organization, Space or owner grants', async t => {
  const f = fixture(t), { owner } = await installed(f);
  const user = await f.identity.accounts.createLocal(owner.token, { login: 'guest', name: 'Guest', password: 'guest test passphrase' });
  assert.notEqual(user.id, 'usr_guest');
  for (const table of ['organization_memberships', 'instance_roles']) assert.equal(f.control.get(`SELECT 1 FROM ${table} WHERE user_id=?`, user.id), undefined);
  assert.equal(f.control.get('SELECT 1 FROM space_memberships WHERE principal_id=?', user.id), undefined);
  const guest = await f.identity.credentials.login({ login: 'guest', password: 'guest test passphrase' });
  await assert.rejects(f.identity.accounts.createLocal(guest.token, { login: 'evil', name: 'Evil', password: 'attacker passphrase' }), { code: 'forbidden' });
});
test('rename uses CAS without changing stable identity or logging out sessions', async t => {
  const f = fixture(t), { owner } = await installed(f);
  const changed = f.identity.accounts.renameSelf(owner.token, 'New display name', 1);
  assert.equal(changed.id, owner.userId); assert.equal(changed.revision, 2);
  assert.equal(f.identity.sessions.resolve(owner.token)?.displayName, 'New display name');
  assert.throws(() => f.identity.accounts.renameSelf(owner.token, 'Stale', 1), { code: 'conflict' });
});
test('session inventory and revocation never disclose or revoke another account session', async t => {
  const f = fixture(t), { owner } = await installed(f);
  await f.identity.accounts.createLocal(owner.token, { login: 'other', name: 'Other', password: 'other test password' });
  const other = await f.identity.credentials.login({ login: 'other', password: 'other test password' });
  assert.equal(f.identity.sessions.list(other.token).length, 1);
  assert.ok(!JSON.stringify(f.identity.sessions.list(other.token)).includes(owner.session.id));
  assert.throws(() => f.identity.sessions.revoke(other.token, owner.session.id, 1), { code: 'not-found' });
  assert.throws(() => f.identity.sessions.revoke(other.token, 'ses_missing', 1), { code: 'not-found' });
  assert.throws(() => f.identity.sessions.revoke(other.token, other.session.id, 99), { code: 'conflict' });
  f.identity.sessions.revoke(other.token, other.session.id, 1);
  assert.equal(f.identity.sessions.resolve(other.token), null);
  assert.ok(f.identity.sessions.resolve(owner.token));
});
test('suspension revokes sessions and login; it preserves the final active owner', async t => {
  const f = fixture(t), { owner } = await installed(f);
  assert.throws(() => f.identity.accounts.setStatus(owner.token, owner.userId, 'suspended', 1), { code: 'last-owner' });
  const user = await f.identity.accounts.createLocal(owner.token, { login: 'other', name: 'Other', password: 'other test password' });
  const other = await f.identity.credentials.login({ login: 'other', password: 'other test password' });
  f.identity.accounts.setStatus(owner.token, user.id, 'suspended', 1);
  assert.equal(f.identity.sessions.resolve(other.token), null);
  await assert.rejects(f.identity.credentials.login({ login: 'other', password: 'other test password' }), { code: 'invalid-credentials' });
  f.identity.accounts.setStatus(owner.token, user.id, 'active', 2);
  assert.equal(f.identity.sessions.resolve(other.token), null); // no old-session revival
  assert.ok(await f.identity.credentials.login({ login: 'other', password: 'other test password' }));
});
test('credential revision/status are rechecked after asynchronous password verification', async t => {
  const verifier = testPasswords(), latch = deferred<{ valid: boolean; needsRehash: boolean }>();
  const f = fixture(t, { passwords: verifier }), { owner } = await installed(f);
  const user = await f.identity.accounts.createLocal(owner.token, { login: 'other', name: 'Other', password: 'other test password' });
  verifier.verify = () => latch.promise;
  const attempt = f.identity.credentials.login({ login: 'other', password: 'other test password' });
  f.identity.accounts.setStatus(owner.token, user.id, 'suspended', 1);
  latch.resolve({ valid: true, needsRehash: false });
  await assert.rejects(attempt, { code: 'invalid-credentials' });
  assert.equal(f.control.get('SELECT 1 FROM auth_sessions WHERE user_id=?', user.id), undefined);
});
test('legacy credential verification upgrades once without a synchronous request KDF', async t => {
  const f = fixture(t), { owner, input } = await installed(f);
  f.control.transaction(() => f.control.run('UPDATE password_credentials SET password_hash=? WHERE user_id=?', `legacy-only:${input.password}`, owner.userId));
  await f.identity.credentials.login({ login: input.login, password: input.password });
  assert.equal(f.control.get<{ password_hash: string }>('SELECT password_hash FROM password_credentials WHERE user_id=?', owner.userId)?.password_hash, `test-only:${input.password}`);
  assert.equal(f.control.all("SELECT 1 FROM audit_events WHERE action='auth.password-upgraded'").length, 1);
});
test('reauth expires independently; password changes invalidate all old sessions', async t => {
  const f = fixture(t), { owner, input } = await installed(f);
  f.advance(5 * 60_000);
  await assert.rejects(f.identity.credentials.changePassword(owner.token, 'replacement password'), { code: 'reauth-required' });
  await f.identity.credentials.reauthenticate(owner.token, input.password);
  const another = await f.identity.credentials.login({ login: input.login, password: input.password });
  await f.identity.credentials.changePassword(owner.token, 'replacement password');
  assert.equal(f.identity.sessions.resolve(owner.token), null);
  assert.equal(f.identity.sessions.resolve(another.token), null);
  await assert.rejects(f.identity.credentials.login({ login: input.login, password: input.password }), { code: 'invalid-credentials' });
  assert.ok(await f.identity.credentials.login({ login: input.login, password: 'replacement password' }));
});
test('one recovery code racing twice is consumed once, with global account session revocation', async t => {
  const f = fixture(t), { owner, input, recovery } = await installed(f);
  const request = { login: input.login, code: recovery.codes[0]!, password: 'replacement password' };
  const attempts = await Promise.allSettled([f.identity.credentials.recover(request), f.identity.credentials.recover(request)]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal(f.control.all('SELECT * FROM recovery_codes WHERE used_at_ms IS NOT NULL').length, 1);
  assert.equal(f.identity.sessions.resolve(owner.token), null);
  await assert.rejects(f.identity.credentials.recover(request), { code: 'invalid-credentials' });
  assert.ok(await f.identity.credentials.login({ login: input.login, password: request.password }));
});
test('recovery never reactivates a disabled principal or grants memberships', async t => {
  const f = fixture(t), { input, recovery, owner } = await installed(f);
  // Local DB fixture adds a second owner so the database invariant permits suspending the first.
  const second = await f.identity.accounts.createLocal(owner.token, { login: 'second', name: 'Second', password: 'second account passphrase' });
  f.control.transaction(() => f.control.run("INSERT INTO instance_roles(user_id,role) VALUES(?,'owner')", second.id));
  const secondSession = await f.identity.credentials.login({ login: 'second', password: 'second account passphrase' });
  f.identity.accounts.setStatus(secondSession.token, owner.userId, 'suspended', 1);
  await assert.rejects(f.identity.credentials.recover({ login: input.login, code: recovery.codes[0]!, password: 'replacement password' }), { code: 'invalid-credentials' });
  assert.equal(f.control.all('SELECT 1 FROM recovery_codes WHERE used_at_ms IS NOT NULL').length, 0);
});
test('idle expiry, absolute expiry and logout-all are enforced without cached authority', async t => {
  const f = fixture(t, { idleMs: 1000, absoluteMs: 2000 }), { owner, input } = await installed(f);
  f.advance(1000); assert.equal(f.identity.sessions.resolve(owner.token), null);
  const next = await f.identity.credentials.login({ login: input.login, password: input.password });
  for (let i = 0; i < 3; i++) { f.advance(500); assert.ok(f.identity.sessions.resolve(next.token)); }
  f.advance(500); assert.equal(f.identity.sessions.resolve(next.token), null);
  const a = await f.identity.credentials.login({ login: input.login, password: input.password });
  const b = await f.identity.credentials.login({ login: input.login, password: input.password });
  f.identity.sessions.logoutAll(a.token);
  assert.equal(f.identity.sessions.resolve(a.token), null); assert.equal(f.identity.sessions.resolve(b.token), null);
});

test('offboarding cannot be undone indirectly through suspended state', async t => {
  const f = fixture(t), { owner } = await installed(f);
  const user = await f.identity.accounts.createLocal(owner.token, { login: 'leaving', name: 'Leaving', password: 'leaving test password' });
  f.identity.accounts.setStatus(owner.token, user.id, 'offboarding', 1);
  assert.throws(() => f.identity.accounts.setStatus(owner.token, user.id, 'suspended', 2), { code: 'invalid-transition' });
  f.identity.accounts.setStatus(owner.token, user.id, 'disabled', 2);
  assert.throws(() => f.identity.accounts.setStatus(owner.token, user.id, 'suspended', 3), { code: 'invalid-transition' });
});
