import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authBootstrapPhase, claimLinkSessionBounce, claimOwnerSessionRenewal, validateAuthStatus } from '../src/authBootstrap.ts';
import { prefetchAuthStatus, consumeAuthPrefetch, isBrowserAccountScopeResolved } from '../src/authPrefetch.ts';

test('no-password mode is not authorization; only verified UI principals can boot', () => {
  for (const required of [true, false]) {
    assert.equal(authBootstrapPhase({ required, authorized: false, scope: 'anonymous' }), 'locked');
    for (const scope of ['ui-session', 'local-user', 'paired-device']) {
      assert.equal(authBootstrapPhase({ required, authorized: true, scope }), 'ready');
    }
  }
  for (const value of [null, {}, { required: false }, { required: true, authorized: 'true', scope: 'ui-session' }, { required: false, authorized: true, scope: 'anonymous' }, { required: false, authorized: true, scope: 'internal-service' }]) {
    assert.throws(() => authBootstrapPhase(value), /Invalid authentication status/);
  }
});

test('canonical installation setup never boots the workspace runtime early', () => {
  for (const state of ['uninitialized', 'claimed', 'configuring'] as const) {
    assert.equal(authBootstrapPhase({ required: true, authorized: false, scope: 'anonymous', state }), 'setup');
  }
  assert.equal(authBootstrapPhase({ required: true, authorized: false, scope: 'anonymous', state: 'recovery' }), 'unavailable');
  assert.equal(authBootstrapPhase({ required: true, authorized: true, scope: 'ui-session', state: 'ready', bootstrapMode: 'setup' }), 'restart');
  assert.equal(authBootstrapPhase({ required: true, authorized: true, scope: 'ui-session', state: 'ready' }), 'ready');
});

test('auth prefetch rejects unavailable or missing account authority', async () => {
  const previous = globalThis.fetch;
  try {
    for (const response of [new Response('{}', { status: 503 }), new Response('{}', { status: 200 })]) {
      consumeAuthPrefetch();
      globalThis.fetch = async input => String(input) === '/api/auth/status'
        ? new Response(JSON.stringify({ required: true, authorized: true, scope: 'ui-session' })) : response;
      await assert.rejects(prefetchAuthStatus(), /account scope/);
      consumeAuthPrefetch();
    }
  } finally { globalThis.fetch = previous; consumeAuthPrefetch(); }
});

test('local-user bootstrap rejects failed or malformed Space identity without falling back', async () => {
  const previous = globalThis.fetch;
  try {
    for (const spacesResponse of [
      new Response('{}', { status: 503 }),
      new Response(JSON.stringify({ user: { id: '   ' } }), { status: 200 }),
    ]) {
      consumeAuthPrefetch();
      globalThis.fetch = async input => {
        const path = String(input);
        if (path === '/api/auth/status') {
          return new Response(JSON.stringify({ required: true, authorized: true, scope: 'local-user' }));
        }
        assert.equal(path, '/api/spaces');
        return spacesResponse;
      };
      await assert.rejects(prefetchAuthStatus(), /Authenticated account scope/);
      assert.equal(isBrowserAccountScopeResolved(), false);
      consumeAuthPrefetch();
    }
  } finally { globalThis.fetch = previous; consumeAuthPrefetch(); }
});

test('paired-device bootstrap resolves its account through Spaces, never /api/auth/accounts', async () => {
  const previous = globalThis.fetch;
  const requested: string[] = [];
  try {
    consumeAuthPrefetch();
    globalThis.fetch = async input => {
      const path = String(input);
      requested.push(path);
      if (path === '/api/auth/status') {
        return new Response(JSON.stringify({ required: false, authorized: true, scope: 'paired-device' }));
      }
      // Paired devices are default-deny outside the remote route table.
      if (path !== '/api/spaces') return new Response('{}', { status: 403 });
      return new Response(JSON.stringify({ user: { id: 'usr_owner' } }));
    };
    assert.equal((await prefetchAuthStatus()).scope, 'paired-device');
    assert.deepEqual(requested, ['/api/auth/status', '/api/spaces']);
    assert.equal(isBrowserAccountScopeResolved(), true);
  } finally { globalThis.fetch = previous; consumeAuthPrefetch(); }
});

test('a lost Link proxy session bounces to the connection hub at most once per window', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const unauthorized = Object.assign(new Error('auth status: HTTP 401'), { status: 401 });
  assert.equal(claimLinkSessionBounce(new Error('offline'), storage, 1_000_000), false);
  assert.equal(claimLinkSessionBounce(Object.assign(new Error('x'), { status: 503 }), storage, 1_000_000), false);
  assert.equal(claimLinkSessionBounce(unauthorized, storage, 1_000_000), true);
  assert.equal(claimLinkSessionBounce(unauthorized, storage, 1_059_999), false);
  assert.equal(claimLinkSessionBounce(unauthorized, storage, 1_060_000), true);
});

test('bootstrap error, setup-only restart and revocation paths cannot advance to ready', () => {
  const source = readFileSync(new URL('../src/bootstrap.tsx', import.meta.url), 'utf8');
  // The bounce asks the hub to resume this server at the same path.
  assert.match(source, /claimLinkSessionBounce\(error, sessionStorage\)\) \{\n\s+await returnToMobileConnectionHub\([^;]*\{ resume: true \},?\s*\);\n\s+return;\n\s+\}\n\s+setPhase\("unavailable"\);/);
  assert.match(source, /const onAuthRequired = \(\) => \{ invalidated = true; setLocalOwner\(undefined\); setPhase\("locked"\); \}/);
  assert.match(source, /if \(cancelled \|\| invalidated\) return;/);
  assert.match(source, /if \(phase === "setup"\) return <SetupScreen/);
  assert.match(source, /if \(phase === "restart"\) return <SetupScreen restartRequired \/>/);
  assert.match(source, /<img className="welcome-mark" src=\{POLYTH_MARK_SRC\} alt="" aria-hidden="true" \/>/);
  assert.doesNotMatch(source, /if \(!s\.required \|\| s\.authorized\)/);
});

test('lock screen keeps credential fields visibly labelled and alternatives grouped', () => {
  const source = readFileSync(new URL('../src/components/LockScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /aria-labelledby="lock-title"/);
  assert.match(source, /htmlFor="lock-login"/);
  assert.match(source, /htmlFor="lock-password"/);
  assert.match(source, /className="lock-alternatives"/);
});

test('a password-less owner is still locked until a session exists; access mode is validated', () => {
  const locked = { required: true, authorized: false, scope: 'anonymous', state: 'ready', accessMode: 'local' };
  assert.equal(authBootstrapPhase(locked), 'locked');
  assert.equal(authBootstrapPhase({ ...locked, authorized: true, scope: 'ui-session' }), 'ready');
  assert.equal(validateAuthStatus({ ...locked, accessMode: 'accounts' }).accessMode, 'accounts');
  assert.throws(() => validateAuthStatus({ ...locked, accessMode: 'open' }), /Invalid access mode/);
});

test('a locked Desktop window of a password-less owner asks its main process once per window', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(claimOwnerSessionRenewal({ authorized: false, accessMode: 'accounts' }, storage, 1_000_000), false);
  assert.equal(claimOwnerSessionRenewal({ authorized: true, accessMode: 'local' }, storage, 1_000_000), false);
  assert.equal(claimOwnerSessionRenewal({ authorized: false }, storage, 1_000_000), false);
  assert.equal(claimOwnerSessionRenewal({ authorized: false, accessMode: 'local' }, storage, 1_000_000), true);
  assert.equal(claimOwnerSessionRenewal({ authorized: false, accessMode: 'local' }, storage, 1_059_999), false, 'no reload loop');
  assert.equal(claimOwnerSessionRenewal({ authorized: false, accessMode: 'local' }, storage, 1_060_000), true);
  const source = readFileSync(new URL('../src/bootstrap.tsx', import.meta.url), 'utf8');
  assert.match(source, /renew && claimOwnerSessionRenewal\(status, sessionStorage\) && await renew\(\)\.catch\(\(\) => false\)/);
  const lock = readFileSync(new URL('../src/components/LockScreen.tsx', import.meta.url), 'utf8');
  // No password form for an installation that has no password.
  assert.match(lock, /if \(local\) return <LocalOwnerLock \/>;/);
});
