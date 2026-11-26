import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed } from './fixtures.ts';

async function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t), { owner } = await installed(f);
  const account = await f.identity.accounts.createLocal(owner.token, { login: 'olena', name: 'Olena', password: 'temporary passphrase' });
  return { f, owner, account, issue: (ttlMs?: number) => f.identity.invitations.issue(owner.token, account.id, ttlMs === undefined ? {} : { ttlMs }) };
}
const invalid = { code: 'invalid-invitation' };

test('owner issues, preview shows the person, accept signs in with their own password', async t => {
  const { f, account, issue } = await setup(t);
  assert.equal(f.identity.accounts.passwordChangeRequired(account.id), true);
  const { code, expiresAt } = issue();
  assert.match(code, /^pinv_[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresAt, f.now() + 7 * 24 * 3_600_000);
  assert.deepEqual(f.identity.invitations.preview(code, '10.0.0.1'), { name: 'Olena', login: 'olena', expiresAt });
  const old = await f.identity.credentials.login({ login: 'olena', password: 'temporary passphrase' });
  const accepted = await f.identity.invitations.accept({ code, password: 'my own long passphrase', address: '10.0.0.1', label: 'test' });
  assert.equal(f.identity.sessions.require(accepted.token).userId, account.id);
  assert.equal(f.identity.accounts.passwordChangeRequired(account.id), false);
  assert.throws(() => f.identity.sessions.require(old.token));
  await assert.rejects(() => f.identity.credentials.login({ login: 'olena', password: 'temporary passphrase' }));
  await f.identity.credentials.login({ login: 'olena', password: 'my own long passphrase' });
  // Single use; the code is gone from every answer.
  await assert.rejects(() => f.identity.invitations.accept({ code, password: 'another long passphrase' }), invalid);
  assert.throws(() => f.identity.invitations.preview(code), invalid);
  const audit = f.control.all<{ action: string; detail?: string }>("SELECT * FROM audit_events WHERE action LIKE 'identity.invitation-%'");
  assert.deepEqual(audit.map(a => a.action), ['identity.invitation-issued', 'identity.invitation-accepted']);
  assert.ok(!JSON.stringify(audit).includes(code));
});

test('expiry, reissue, revoke and pending', async t => {
  const { f, owner, account, issue } = await setup(t);
  const first = issue(3_600_000);
  f.advance(3_600_001);
  await f.identity.credentials.reauthenticate(owner.token, 'owner test passphrase');
  assert.throws(() => f.identity.invitations.preview(first.code), invalid);
  assert.equal(f.identity.invitations.pending(owner.token, account.id), null);
  const a = issue(), b = issue();
  assert.throws(() => f.identity.invitations.preview(a.code), invalid);
  assert.equal(f.identity.invitations.preview(b.code).login, 'olena');
  assert.deepEqual(f.identity.invitations.pending(owner.token, account.id), { expiresAt: b.expiresAt });
  assert.deepEqual(f.identity.invitations.revoke(owner.token, account.id), { revoked: 1 });
  assert.throws(() => f.identity.invitations.preview(b.code), invalid);
  assert.equal(f.identity.invitations.pending(owner.token, account.id), null);
  // The TTL is clamped.
  assert.equal(issue(1).expiresAt, f.now() + 3_600_000);
  assert.equal(issue(10 ** 12).expiresAt, f.now() + 30 * 24 * 3_600_000);
});

test('only an owner issues, never for an owner, and a disabled account loses its link', async t => {
  const { f, owner, account, issue } = await setup(t);
  const member = await f.identity.credentials.login({ login: 'olena', password: 'temporary passphrase' });
  assert.throws(() => f.identity.invitations.issue(member.token, account.id), { code: 'forbidden' });
  assert.throws(() => f.identity.invitations.issue(owner.token, owner.session.userId), { code: 'forbidden' });
  const { code } = issue();
  const user = f.identity.accounts.byUser.current(account.id);
  f.identity.accounts.setStatus(owner.token, account.id, 'disabled', user.revision);
  assert.throws(() => f.identity.invitations.preview(code), invalid);
  await assert.rejects(() => f.identity.invitations.accept({ code, password: 'my own long passphrase' }), invalid);
  assert.throws(() => issue(), { code: 'invalid-transition' });
});

test('a weak password is refused and the code stays usable; unknown codes are generic', async t => {
  const { f, issue } = await setup(t);
  const { code } = issue();
  await assert.rejects(() => f.identity.invitations.accept({ code, password: 'short' }), { code: 'invalid-input' });
  assert.equal(f.identity.invitations.preview(code).login, 'olena');
  assert.throws(() => f.identity.invitations.preview('pinv_nope'), invalid);
  assert.throws(() => f.identity.invitations.preview(''), invalid);
  await f.identity.invitations.accept({ code, password: 'my own long passphrase' });
});

test('concurrent accepts: exactly one wins', async t => {
  const { issue, f } = await setup(t);
  const { code } = issue();
  const results = await Promise.allSettled([
    f.identity.invitations.accept({ code, password: 'first long passphrase' }),
    f.identity.invitations.accept({ code, password: 'second long passphrase' }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'invalid-invitation');
});

test('preview and accept are rate limited per address', async t => {
  const { f } = await setup(t);
  let last: unknown;
  for (let i = 0; i < 45; i++) { try { f.identity.invitations.preview('pinv_x', '9.9.9.9'); } catch (e) { last = e; } }
  assert.equal((last as { code: string }).code, 'rate-limited');
});
