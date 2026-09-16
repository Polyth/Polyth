import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed } from './fixtures.ts';
import { authenticator } from './webauthnTestkit.ts';

async function passkeyFixture(t: TestContext) {
  const f = fixture(t, { webauthn: { origin: 'https://example.test', rpId: 'example.test', rpName: 'Polyth Test' } });
  const { owner } = await installed(f);
  const key = authenticator(t);
  const begin = f.identity.passkeys.beginRegistration(owner.token, 'Laptop passkey');
  const passkey = f.identity.passkeys.completeRegistration(owner.token, { name: 'Laptop passkey', ...key.registration(begin.challenge) });
  return { ...f, owner, key, passkey };
}

test('registers a verified resident passkey and authenticates it with a single-use challenge', async t => {
  const f = await passkeyFixture(t);
  assert.deepEqual(f.identity.setup.status().methods, ['password', 'passkey']);
  assert.equal(f.identity.passkeys.list(f.owner.token)[0]?.name, 'Laptop passkey');
  const options = f.identity.passkeys.beginAuthentication();
  const issued = f.identity.passkeys.completeAuthentication({ ...f.key.assertion(options.challenge, 1), label: 'Security key' });
  assert.equal(issued.session.userId, f.owner.userId);
  assert.ok(f.identity.sessions.resolve(issued.token));
  assert.throws(() => f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 2)), { code: 'invalid-credentials' });
});

test('rejects wrong origin, wrong RP ID hash and non-advancing authenticator counters', async t => {
  const f = await passkeyFixture(t);
  let options = f.identity.passkeys.beginAuthentication();
  assert.throws(() => f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 1, 'https://attacker.test')), { code: 'invalid-credentials' });
  options = f.identity.passkeys.beginAuthentication();
  assert.throws(() => f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 1, 'https://example.test', Buffer.alloc(32, 7))), { code: 'invalid-credentials' });
  options = f.identity.passkeys.beginAuthentication();
  f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 5));
  options = f.identity.passkeys.beginAuthentication();
  assert.throws(() => f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 5)), { code: 'invalid-credentials' });
});

test('registration is bound to the elevated user session and challenge', async t => {
  const f = fixture(t, { webauthn: { origin: 'https://example.test' } }), { owner } = await installed(f), key = authenticator(t);
  const other = await f.identity.accounts.createLocal(owner.token, { login: 'other', name: 'Other', password: 'another testing passphrase' });
  const otherLogin = await f.identity.credentials.login({ login: 'other', password: 'another testing passphrase' });
  const begin = f.identity.passkeys.beginRegistration(owner.token, 'Owner key');
  assert.throws(() => f.identity.passkeys.completeRegistration(otherLogin.token, { name: 'Stolen', ...key.registration(begin.challenge) }), { code: 'invalid-credentials' });
  assert.equal(f.control.get('SELECT 1 FROM passkey_credentials WHERE user_id=?', other.id), undefined);
});

test('passkey removal is revisioned and cannot remove the last usable sign-in method', async t => {
  const f = await passkeyFixture(t);
  f.control.transaction(() => f.control.run('DELETE FROM password_credentials WHERE user_id=?', f.owner.userId));
  assert.throws(() => f.identity.passkeys.remove(f.owner.token, f.passkey.id, f.passkey.revision), { code: 'last-auth-method' });
  assert.equal(f.identity.passkeys.list(f.owner.token).length, 1);
});

test('operator break-glass password reset is installation-bound, audited, and revokes sessions without changing grants', async t => {
  const f = fixture(t), { owner } = await installed(f);
  const beforeMemberships = f.control.all('SELECT org_id,user_id,role,state FROM organization_memberships ORDER BY org_id,user_id');
  await assert.rejects(f.identity.credentials.operatorResetPassword({ userId: owner.userId, password: 'replacement testing passphrase', installationId: 'wrong', reason: 'Operator console recovery after lost credentials' }), { code: 'forbidden' });
  await f.identity.credentials.operatorResetPassword({ userId: owner.userId, password: 'replacement testing passphrase', installationId: f.control.installation().id, reason: 'Operator console recovery after lost credentials' });
  assert.equal(f.identity.sessions.resolve(owner.token), null);
  assert.deepEqual(f.control.all('SELECT org_id,user_id,role,state FROM organization_memberships ORDER BY org_id,user_id'), beforeMemberships);
  assert.ok(f.control.get("SELECT 1 FROM audit_events WHERE actor_id='operator:break-glass' AND action='auth.break-glass-password-reset' AND resource_id=?", owner.userId));
  const logged = await f.identity.credentials.login({ login: 'Max', password: 'replacement testing passphrase' });
  assert.equal(logged.session.userId, owner.userId);
});
