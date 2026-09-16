import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed } from './fixtures.ts';

test('owner account creation creates identity only and never grants tenancy implicitly', async t => {
  const f = fixture(t);
  const { owner } = await installed(f);
  assert.equal(f.identity.accounts.canManage(owner.token), true);

  const account = await f.identity.accounts.createLocal(owner.token, {
    login: 'alice',
    name: 'Alice',
    password: 'alice test passphrase',
  });
  assert.match(account.id, /^usr_[a-f0-9-]{36}$/);
  assert.equal(account.displayName, 'Alice');
  assert.equal(account.status, 'active');

  assert.equal(f.control.get('SELECT 1 FROM instance_roles WHERE user_id=?', account.id), undefined);
  assert.equal(f.control.get('SELECT 1 FROM organization_memberships WHERE user_id=?', account.id), undefined);
  assert.equal(f.control.get('SELECT 1 FROM space_memberships WHERE principal_id=?', account.id), undefined);
  assert.equal(f.identity.accounts.list(owner.token).some(row => row.id === account.id), true);
});

test('disable is revision checked, revokes sessions, and preserves durable identity rows', async t => {
  const f = fixture(t);
  const { owner } = await installed(f);
  const account = await f.identity.accounts.createLocal(owner.token, {
    login: 'alice',
    name: 'Alice',
    password: 'alice test passphrase',
  });
  const login = await f.identity.credentials.login({ login: 'alice', password: 'alice test passphrase' });
  assert.equal(f.identity.sessions.resolve(login.token)?.userId, account.id);

  assert.throws(() => f.identity.accounts.setStatus(owner.token, account.id, 'disabled', account.revision + 1), { code: 'conflict' });
  const disabled = f.identity.accounts.setStatus(owner.token, account.id, 'disabled', account.revision);
  assert.equal(disabled.status, 'disabled');
  assert.equal(f.identity.sessions.resolve(login.token), null);
  assert.equal(f.control.get<{ id: string }>('SELECT id FROM users WHERE id=?', account.id)?.id, account.id);
  assert.ok(f.control.get('SELECT 1 FROM password_credentials WHERE user_id=?', account.id));
  assert.throws(() => f.identity.accounts.setStatus(owner.token, account.id, 'active', disabled.revision), { code: 'invalid-transition' });
});

test('last active instance owner cannot be disabled', async t => {
  const f = fixture(t);
  const { owner } = await installed(f);
  const current = f.identity.accounts.current(owner.token);
  assert.throws(() => f.identity.accounts.setStatus(owner.token, current.id, 'disabled', current.revision), { code: 'last-owner' });
});

test('non-owner can list only self and cannot create another identity', async t => {
  const f = fixture(t);
  const { owner } = await installed(f);
  const account = await f.identity.accounts.createLocal(owner.token, {
    login: 'alice',
    name: 'Alice',
    password: 'alice test passphrase',
  });
  const login = await f.identity.credentials.login({ login: 'alice', password: 'alice test passphrase' });
  assert.equal(f.identity.accounts.canManage(login.token), false);
  assert.deepEqual(f.identity.accounts.list(login.token).map(row => row.id), [account.id]);
  await assert.rejects(() => f.identity.accounts.createLocal(login.token, {
    login: 'mallory', name: 'Mallory', password: 'mallory test passphrase',
  }), { code: 'forbidden' });
});
