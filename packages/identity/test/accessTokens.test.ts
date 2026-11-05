import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed } from './fixtures.ts';
import type { AccessTokenPolicy } from '../src/index.ts';

const GRANTABLE = ['core.health.read', 'core.sessions.read', 'core.sessions.create', 'core.sessions.message'];
const policy: AccessTokenPolicy = {
  normalizeGrants(raw) {
    if (!Array.isArray(raw) || raw.some((g) => typeof g !== 'string' || !GRANTABLE.includes(g))) {
      throw Object.assign(new Error('bad grants'), { code: 'invalid-input' });
    }
    return [...new Set(raw as string[])].sort();
  },
  profiles: { read: ['core.health.read', 'core.sessions.read'], control: GRANTABLE },
};

async function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t, { accessTokens: policy });
  const { owner } = await installed(f);
  const spaceId = f.control.get<{ space_id: string }>('SELECT space_id FROM space_memberships WHERE principal_id=?', owner.session.userId)!.space_id;
  return { f, owner, spaceId, tokens: f.identity.accessTokens };
}

test('device flow: code is approved in the UI, redeemed once, and the token resolves', async (t) => {
  const { f, owner, tokens } = await setup(t);
  const start = tokens.device.start({ label: 'polyth CLI on laptop', profile: 'read', address: '10.0.0.5' });
  assert.match(start.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.match(start.deviceCode, /^[a-f0-9]{64}$/);
  assert.deepEqual(tokens.device.redeem(start.deviceCode), { status: 'pending', interval: 3 });

  const details = tokens.device.lookup(owner.token, start.userCode.toLowerCase().replace('-', ' '));
  assert.equal(details.label, 'polyth CLI on laptop');
  assert.deepEqual(details.grants, ['core.health.read', 'core.sessions.read']);
  assert.equal(details.clientAddress, '10.0.0.5');

  tokens.device.decide(owner.token, start.userCode, true);
  const issued = tokens.device.redeem(start.deviceCode);
  assert.equal(issued.status, 'issued');
  assert.ok(issued.status === 'issued' && /^pth_[a-f0-9]{64}$/.test(issued.token));
  // Redeemable exactly once.
  assert.throws(() => tokens.device.redeem(start.deviceCode), { code: 'expired' });

  const resolved = tokens.resolve(issued.status === 'issued' ? issued.token : '');
  assert.deepEqual(resolved && { kind: resolved.kind, userId: resolved.userId, grants: resolved.grants }, {
    kind: 'device', userId: owner.session.userId, grants: ['core.health.read', 'core.sessions.read'],
  });
  // No plaintext token is ever stored.
  const rows = JSON.stringify(f.control.all('SELECT * FROM access_tokens'));
  assert.ok(issued.status === 'issued' && !rows.includes(issued.token.slice(4)));
});

test('device flow: denied and expired codes never yield a token', async (t) => {
  const { f, owner, tokens } = await setup(t);
  const denied = tokens.device.start({ profile: 'control' });
  tokens.device.decide(owner.token, denied.userCode, false);
  assert.throws(() => tokens.device.redeem(denied.deviceCode), { code: 'forbidden' });

  const late = tokens.device.start({ profile: 'control' });
  f.advance(10 * 60_000 + 1);
  assert.throws(() => tokens.device.lookup(owner.token, late.userCode), { code: 'not-found' });
  assert.throws(() => tokens.device.redeem(late.deviceCode), { code: 'expired' });
  assert.throws(() => tokens.device.redeem('0'.repeat(64)), { code: 'expired' });
  assert.throws(() => tokens.device.start({ profile: 'admin' }), { code: 'invalid-input' });
});

test('device flow: approval needs a recent sign-in; pending starts are bounded per address', async (t) => {
  const { f, owner, tokens } = await setup(t);
  const start = tokens.device.start({ profile: 'read' });
  f.advance(5 * 60_000 + 1);
  assert.throws(() => tokens.device.decide(owner.token, start.userCode, true), { code: 'reauth-required' });
  for (let i = 0; i < 5; i++) tokens.device.start({ profile: 'read', address: '192.168.1.9' });
  assert.throws(() => tokens.device.start({ profile: 'read', address: '192.168.1.9' }), { code: 'rate-limited' });
});

test('automation tokens: created with a recent sign-in, listed, pinned, expiring and revocable', async (t) => {
  const { f, owner, spaceId, tokens } = await setup(t);
  const issued = tokens.create(owner.token, { label: 'CI bot', profile: 'control', spaceId, expiresInDays: 30 });
  assert.equal(issued.summary.kind, 'automation');
  assert.equal(issued.summary.spaceId, spaceId);
  assert.equal(tokens.resolve(issued.token)?.spaceId, spaceId);
  assert.deepEqual(tokens.list(owner.token).map((x) => x.label), ['CI bot']);

  assert.throws(() => tokens.create(owner.token, { label: 'x', grants: ['secure-safe.secrets.read'] }), { code: 'invalid-input' });
  assert.throws(() => tokens.create(owner.token, { label: 'x', profile: 'read', spaceId: 'spc_not_mine' }), { code: 'not-found' });
  const never = tokens.create(owner.token, { label: 'forever', profile: 'read', expiresInDays: null });
  assert.equal(never.summary.expiresAt, null);

  f.advance(31 * 24 * 60 * 60_000);
  assert.equal(tokens.resolve(issued.token), null, 'expired token resolves to nothing');
  assert.ok(tokens.resolve(never.token));

  // The original sign-in idled out over 31 days; sign in again.
  const fresh = f.control.transaction(() => f.identity.sessions.issue(owner.session.userId)).token;
  const target = tokens.list(fresh).find((x) => x.label === 'forever')!;
  tokens.revoke(fresh, target.id, target.revision);
  assert.equal(tokens.resolve(never.token), null, 'revoked token resolves to nothing');
  assert.throws(() => tokens.revoke(fresh, target.id, target.revision), { code: 'not-found' });
});

test('automation tokens: creating one requires a recent sign-in', async (t) => {
  const { f, owner, tokens } = await setup(t);
  f.advance(5 * 60_000 + 1);
  assert.throws(() => tokens.create(owner.token, { label: 'late', profile: 'read' }), { code: 'reauth-required' });
});

test('tokens die with the account auth epoch (logout everywhere) and can revoke themselves', async (t) => {
  const { f, owner, tokens } = await setup(t);
  const a = tokens.create(owner.token, { label: 'a', profile: 'read' });
  const b = tokens.create(owner.token, { label: 'b', profile: 'read' });
  assert.equal(tokens.revokeSelf(b.token), true);
  assert.equal(tokens.resolve(b.token), null);
  assert.equal(tokens.revokeSelf(b.token), false);
  assert.ok(tokens.resolve(a.token));
  f.identity.sessions.logoutAll(owner.token);
  assert.equal(tokens.resolve(a.token), null);
  assert.equal(tokens.live(a.summary.id, owner.session.userId), null);
});

test('no-token CLI mode: off by default, owner-only, needs a recent sign-in, follows the owner', async (t) => {
  const { f, owner, tokens } = await setup(t);
  assert.deepEqual(tokens.trust.get(), { mode: 'off', userId: null, revision: 0, updatedAt: null });
  assert.equal(tokens.trust.effective(), null);
  assert.throws(() => tokens.trust.set(owner.token, 'everywhere', 0), { code: 'invalid-input' });
  assert.throws(() => tokens.trust.set(owner.token, 'loopback', 7), { code: 'conflict' });

  const member = await f.identity.accounts.createLocal(owner.token, { login: 'kid', name: 'Kid', password: 'kid test passphrase' });
  const memberSession = await f.identity.credentials.login({ login: 'kid', password: 'kid test passphrase' });
  assert.throws(() => tokens.trust.set(memberSession.token, 'loopback', 0), { code: 'forbidden' });
  void member;

  const on = tokens.trust.set(owner.token, 'private-network', 0);
  assert.equal(on.mode, 'private-network');
  assert.deepEqual(tokens.trust.effective(), { mode: 'private-network', userId: owner.session.userId });
  tokens.trust.set(owner.token, 'off', on.revision);
  assert.equal(tokens.trust.effective(), null);

  f.advance(5 * 60_000 + 1);
  assert.throws(() => tokens.trust.set(owner.token, 'loopback', on.revision + 1), { code: 'reauth-required' });
});

test('without a host policy command-line access is unavailable and tokens never resolve', async (t) => {
  const f = fixture(t);
  const { owner } = await installed(f);
  assert.throws(() => f.identity.accessTokens.create(owner.token, { label: 'x', profile: 'read' }), { code: 'unavailable' });
  assert.equal(f.identity.accessTokens.resolve(`pth_${'a'.repeat(64)}`), null);
});

const APP_GRANTABLE = [...GRANTABLE, 'core.requests.respond'];
const APPROVAL = 'core.requests.respond';
const appPolicy: AccessTokenPolicy = {
  ...policy,
  apps: {
    normalizeGrants(raw) {
      if (!Array.isArray(raw) || raw.some((g) => typeof g !== 'string' || !APP_GRANTABLE.includes(g))) {
        throw Object.assign(new Error('bad grants'), { code: 'invalid-input' });
      }
      return [...new Set(raw as string[])].sort();
    },
    profiles: {
      read: ['core.health.read', 'core.sessions.read'],
      control: GRANTABLE,
      approve: APP_GRANTABLE,
    },
    ownerOnlyGrants: [APPROVAL],
    withoutOwnerGrants: { approve: 'control' },
  },
};

async function appSetup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t, { accessTokens: appPolicy });
  const { owner } = await installed(f);
  const member = await f.identity.accounts.createLocal(owner.token, { login: 'member', name: 'Member', password: 'member test passphrase' });
  const memberSession = await f.identity.credentials.login({ login: 'member', password: 'member test passphrase' });
  return { f, owner, member, memberSession, tokens: f.identity.accessTokens };
}

const redeemed = (tokens: ReturnType<typeof fixture>['identity']['accessTokens'], deviceCode: string) => {
  const issued = tokens.device.redeem(deviceCode);
  assert.equal(issued.status, 'issued');
  return issued.status === 'issued' ? issued : assert.fail('not issued');
};

test('app sign-in: it must name itself, and approving alone never gives it the approval grant', async (t) => {
  const { owner, tokens } = await appSetup(t);
  assert.throws(() => tokens.device.start({ kind: 'app', profile: 'control' }), { code: 'invalid-input' });
  assert.throws(() => tokens.device.start({ kind: 'automation', label: 'x' }), { code: 'invalid-input' });
  assert.throws(() => tokens.device.start({ kind: 'app', label: '\u202e\u2066 ', profile: 'control' }), { code: 'invalid-input' });
  const spoof = tokens.device.start({ kind: 'app', label: 'Bot\u202egnp.exe\u2069', profile: 'control' });
  assert.equal(tokens.device.lookup(owner.token, spoof.userCode).label, 'Botgnp.exe');

  const start = tokens.device.start({ kind: 'app', label: 'Phone bot', profile: 'approve', address: '10.0.0.9' });
  const details = tokens.device.lookup(owner.token, start.userCode);
  assert.equal(details.kind, 'app');
  assert.equal(details.asksOwnerGrants, true);
  assert.equal(details.canAllowOwnerGrants, true);
  assert.ok(details.grants.includes(APPROVAL));

  tokens.device.decide(owner.token, start.userCode, true);
  const issued = redeemed(tokens, start.deviceCode);
  assert.equal(issued.summary.kind, 'app');
  assert.equal(issued.summary.label, 'Phone bot');
  assert.deepEqual(issued.summary.grants, [...GRANTABLE].sort());
  assert.ok(issued.summary.expiresAt !== null, 'an app token from a code expires');
  assert.equal(tokens.resolve(issued.token)!.grants.includes(APPROVAL), false);
});

test('app sign-in: the owner can allow approvals for this one app, and it is audited', async (t) => {
  const { f, owner, tokens } = await appSetup(t);
  const start = tokens.device.start({ kind: 'app', label: 'Trusted', profile: 'approve' });
  tokens.device.decide(owner.token, start.userCode, true, { allowOwnerGrants: true });
  const issued = redeemed(tokens, start.deviceCode);
  const resolved = tokens.resolve(issued.token)!;
  assert.equal(resolved.kind, 'app');
  assert.equal(resolved.label, 'Trusted');
  assert.ok(resolved.grants.includes(APPROVAL));
  assert.ok(f.control.get("SELECT 1 FROM audit_events WHERE action='app.owner-grant-allowed'"));
});

test('app sign-in: a member cannot allow approvals; the app connects without them', async (t) => {
  const { memberSession, tokens } = await appSetup(t);
  const start = tokens.device.start({ kind: 'app', label: 'Member app', profile: 'approve' });
  assert.equal(tokens.device.lookup(memberSession.token, start.userCode).canAllowOwnerGrants, false);
  assert.throws(() => tokens.device.decide(memberSession.token, start.userCode, true, { allowOwnerGrants: true }), { code: 'forbidden' });
  // The refusal left the sign-in pending and unchanged.
  assert.deepEqual(tokens.device.redeem(start.deviceCode), { status: 'pending', interval: 3 });
  tokens.device.decide(memberSession.token, start.userCode, true);
  const issued = redeemed(tokens, start.deviceCode);
  assert.equal(issued.summary.grants.includes(APPROVAL), false);
});

test('app sign-in: the owner yes applies only to a request that asked, and only when approving', async (t) => {
  const { owner, tokens } = await appSetup(t);
  const plain = tokens.device.start({ kind: 'app', label: 'Plain', profile: 'control' });
  assert.equal(tokens.device.lookup(owner.token, plain.userCode).asksOwnerGrants, false);
  assert.throws(() => tokens.device.decide(owner.token, plain.userCode, true, { allowOwnerGrants: true }), { code: 'invalid-input' });

  const terminal = tokens.device.start({ label: 'CLI', profile: 'control' });
  assert.throws(() => tokens.device.decide(owner.token, terminal.userCode, true, { allowOwnerGrants: true }), { code: 'invalid-input' });

  const asks = tokens.device.start({ kind: 'app', label: 'Asks', profile: 'approve' });
  assert.throws(() => tokens.device.decide(owner.token, asks.userCode, false, { allowOwnerGrants: true }), { code: 'invalid-input' });
  assert.throws(() => tokens.device.decide(owner.token, asks.userCode, true, { allowOwnerGrants: 'yes' }), { code: 'invalid-input' });
  tokens.device.decide(owner.token, asks.userCode, false);
  assert.throws(() => tokens.device.redeem(asks.deviceCode), { code: 'forbidden' });
});

test('app tokens from the UI: only the owner can create one that approves; a CLI token never can', async (t) => {
  const { f, owner, memberSession, tokens } = await appSetup(t);
  const made = tokens.create(owner.token, { kind: 'app', label: 'Mine', profile: 'approve', expiresInDays: 30 });
  assert.equal(made.summary.kind, 'app');
  assert.ok(tokens.resolve(made.token)!.grants.includes(APPROVAL));
  assert.ok(f.control.get("SELECT 1 FROM audit_events WHERE action='app.owner-grant-allowed'"));

  assert.throws(() => tokens.create(memberSession.token, { kind: 'app', label: 'No', profile: 'approve' }), { code: 'forbidden' });
  assert.throws(() => tokens.create(memberSession.token, { kind: 'app', label: 'No', grants: [APPROVAL] }), { code: 'forbidden' });
  const memberControl = tokens.create(memberSession.token, { kind: 'app', label: 'Fine', profile: 'control' });
  assert.equal(memberControl.summary.grants.includes(APPROVAL), false);

  assert.throws(() => tokens.create(owner.token, { label: 'cli', grants: [APPROVAL] }), { code: 'invalid-input' });
  assert.throws(() => tokens.create(owner.token, { label: 'cli', profile: 'approve' }), { code: 'invalid-input' });
  assert.throws(() => tokens.create(owner.token, { kind: 'device', label: 'cli', profile: 'read' }), { code: 'invalid-input' });
});

test('app tokens: the approval grant ends with the owner role, and revocation ends the token', async (t) => {
  const { f, owner, member, tokens } = await appSetup(t);
  const made = tokens.create(owner.token, { kind: 'app', label: 'Mine', profile: 'approve' });
  const userId = owner.session.userId;
  assert.ok(tokens.live(made.summary.id, userId)!.grants.includes(APPROVAL));

  // An installation always keeps an owner, so hand the role over first.
  f.control.transaction(() => f.control.run("INSERT INTO instance_roles(user_id,role) VALUES(?,'owner')", member.id));
  f.control.transaction(() => f.control.run("DELETE FROM instance_roles WHERE user_id=? AND role='owner'", userId));
  assert.equal(tokens.resolve(made.token)!.grants.includes(APPROVAL), false);
  assert.equal(tokens.live(made.summary.id, userId)!.grants.includes(APPROVAL), false);
  assert.ok(tokens.resolve(made.token)!.grants.includes('core.sessions.read'));

  assert.equal(tokens.revokeSelf(made.token), true);
  assert.equal(tokens.resolve(made.token), null);
  assert.equal(tokens.live(made.summary.id, userId), null);
});

test('app tokens are unavailable without an app policy', async (t) => {
  const { owner, tokens } = await setup(t);
  assert.throws(() => tokens.device.start({ kind: 'app', label: 'x', profile: 'control' }), { code: 'unavailable' });
  assert.throws(() => tokens.create(owner.token, { kind: 'app', label: 'x', profile: 'control' }), { code: 'unavailable' });
});
