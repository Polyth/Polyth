import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed } from './fixtures.ts';
import { recoveryCode } from '../src/validation.ts';

// A Polyth Desktop owner with a password: the window opens as the owner on
// the computer that runs Polyth (in-process only), and a forgotten password is
// reset there. Neither is an HTTP route and neither elevates a session.

const DESKTOP = 'Polyth Desktop';

test('recovery codes accept the separators people and macOS put between the shown groups', () => {
  const code = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const groups = code.match(/.{4}/g)!;
  for (const typed of [
    code, code.toUpperCase(), groups.join('-'), groups.join(' '), groups.join('–'), groups.join('—'),
    groups.join(' '), groups.join('−'), `${groups.slice(0, 5).join('')}​${groups.slice(5).join('')}`,
    `  ${groups.join(' - ')}\n`, code.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d))),
  ]) assert.equal(recoveryCode(typed), code, JSON.stringify(typed));
  for (const wrong of [code.slice(1), `${code}0`, code.replace('a', 'g'), `${code.slice(0, 20)}.${code.slice(20)}`, 42, null]) {
    assert.equal(recoveryCode(wrong), null, JSON.stringify(wrong));
  }
});

test('recovery succeeds with a code typed in its shown groups', async t => {
  const f = fixture(t);
  const { recovery, input } = await installed(f);
  const spaced = recovery.codes[0]!.match(/.{4}/g)!.join(' ');
  await f.identity.credentials.recover({ login: input.login, code: spaced, password: 'a replacement passphrase' });
  await f.identity.credentials.login({ login: input.login, password: 'a replacement passphrase' });
});

test('the recovery code alone identifies the account and tells the person their login', async t => {
  const f = fixture(t);
  const { recovery, input } = await installed(f);
  // No login at all, as the current lock screen sends it.
  assert.deepEqual(await f.identity.credentials.recover({ code: recovery.codes[0]!, password: 'first replacement passphrase' }), { login: input.login.toLowerCase() });
  // A mistyped login (an old shell still sends one) does not turn a valid code into "incorrect".
  assert.deepEqual(await f.identity.credentials.recover({ login: 'not-my-login', code: recovery.codes[1]!, password: 'second replacement passphrase' }), { login: input.login.toLowerCase() });
  await f.identity.credentials.login({ login: input.login, password: 'second replacement passphrase' });
  // A used code and a wrong code still fail the same way.
  await assert.rejects(f.identity.credentials.recover({ code: recovery.codes[0]!, password: 'third replacement passphrase' }), { code: 'invalid-credentials' });
  await assert.rejects(f.identity.credentials.recover({ code: '0'.repeat(40), password: 'third replacement passphrase' }), { code: 'invalid-credentials' });
});

test('with a password, the Desktop window opens as the owner, never elevated, and keeps a live session it holds', async t => {
  const f = fixture(t);
  const { owner, input } = await installed(f);
  const first = f.identity.issueDesktopOwnerSession(DESKTOP, null);
  assert.ok(first && first !== 'kept');
  assert.equal(first.session.userId, owner.userId);
  assert.equal(first.session.elevatedAt, null);
  assert.throws(() => f.identity.sessions.require(first.token, true), { code: 'reauth-required' });
  // The window still holds it: nothing new is minted.
  assert.equal(f.identity.issueDesktopOwnerSession(DESKTOP, first.token), 'kept');
  // Someone signed in as another account here stays that account.
  const other = await f.identity.credentials.login({ login: input.login, password: input.password, label: 'browser' });
  assert.equal(f.identity.issueDesktopOwnerSession(DESKTOP, other.token), 'kept');
  // A dead cookie gets a fresh owner session that replaces the previous one.
  const second = f.identity.issueDesktopOwnerSession(DESKTOP, 'f'.repeat(64));
  assert.ok(second && second !== 'kept');
  assert.equal(f.identity.sessions.resolve(first.token), null);
  assert.equal(f.control.all('SELECT * FROM auth_sessions WHERE label=?', DESKTOP).length, 1);
  assert.equal(f.control.all("SELECT * FROM audit_events WHERE action='auth.desktop-owner-session'").length, 2);
});

test('no Desktop owner session before setup', t => {
  const f = fixture(t);
  assert.equal(f.identity.issueDesktopOwnerSession(DESKTOP, null), null);
  assert.equal(f.control.all('SELECT * FROM auth_sessions').length, 0);
});

test('a password-less installation keeps the local owner session contract', t => {
  const f = fixture(t);
  const owner = f.identity.setup.completeLocal({ name: 'Ida' });
  const issued = f.identity.issueDesktopOwnerSession(DESKTOP, null);
  assert.ok(issued && issued !== 'kept');
  assert.equal(issued.session.userId, owner.userId);
  // Local launches always replace: the same as issueLocalOwnerSession.
  const again = f.identity.issueDesktopOwnerSession(DESKTOP, issued.token);
  assert.ok(again && again !== 'kept');
  assert.equal(f.identity.sessions.resolve(issued.token), null);
});

test('the owner resets a forgotten password from the Desktop window session; every session ends', async t => {
  const f = fixture(t);
  const { input } = await installed(f);
  const window = f.identity.issueDesktopOwnerSession(DESKTOP, null);
  assert.ok(window && window !== 'kept');
  const elsewhere = await f.identity.credentials.login({ login: input.login, password: input.password, label: 'phone' });
  await assert.rejects(f.identity.credentials.desktopOwnerResetPassword({ token: window.token, password: 'short' }), { code: 'invalid-input' });
  const result = await f.identity.credentials.desktopOwnerResetPassword({ token: window.token, password: 'a new desktop passphrase' });
  assert.equal(result.login, 'max');
  assert.equal(f.identity.sessions.resolve(window.token), null);
  assert.equal(f.identity.sessions.resolve(elsewhere.token), null);
  await assert.rejects(f.identity.credentials.login({ login: input.login, password: input.password }), { code: 'invalid-credentials' });
  const signedIn = await f.identity.credentials.login({ login: input.login, password: 'a new desktop passphrase' });
  assert.equal(f.control.all("SELECT * FROM audit_events WHERE action='auth.desktop-owner-password-reset'").length, 1);
  // The owner chose it: no "change the password someone else set" prompt.
  assert.equal(f.identity.accounts.passwordChangeRequired(signedIn.session.userId), false);
});

test('only the instance owner, with a live session and a password, can reset on Desktop', async t => {
  const f = fixture(t);
  const { owner } = await installed(f);
  await assert.rejects(f.identity.credentials.desktopOwnerResetPassword({ token: 'f'.repeat(64), password: 'a new desktop passphrase' }), { code: 'unauthorized' });
  // Another account signed in on this computer cannot take the owner's password.
  await f.identity.accounts.createLocal(owner.token, { login: 'guest', name: 'Guest', password: 'guest test passphrase' });
  const guest = await f.identity.credentials.login({ login: 'guest', password: 'guest test passphrase' });
  await assert.rejects(f.identity.credentials.desktopOwnerResetPassword({ token: guest.token, password: 'a new desktop passphrase' }), { code: 'forbidden' });
  await f.identity.credentials.login({ login: 'guest', password: 'guest test passphrase' });
});

test('a password-less owner has no password to reset on Desktop', async t => {
  const f = fixture(t);
  f.identity.setup.completeLocal({ name: 'Ida' });
  const window = f.identity.issueDesktopOwnerSession(DESKTOP, null);
  assert.ok(window && window !== 'kept');
  await assert.rejects(f.identity.credentials.desktopOwnerResetPassword({ token: window.token, password: 'a new desktop passphrase' }), { code: 'invalid-transition' });
});
