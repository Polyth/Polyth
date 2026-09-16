import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authBootstrapPhase } from '../src/authBootstrap.ts';
import { prefetchAuthStatus, consumeAuthPrefetch } from '../src/authPrefetch.ts';

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
  assert.equal(authBootstrapPhase({ required: true, authorized: true, scope: 'ui-session', state: 'ready', bootstrapMode: 'setup' }), 'setup');
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

test('bootstrap error and revocation paths cannot advance to ready', () => {
  const source = readFileSync(new URL('../src/bootstrap.tsx', import.meta.url), 'utf8');
  assert.match(source, /catch\(\(\) => \{ if \(!cancelled && !invalidated\) setPhase\("unavailable"\)/);
  assert.match(source, /const onAuthRequired = \(\) => \{ invalidated = true; setPhase\("locked"\); \}/);
  assert.match(source, /if \(cancelled \|\| invalidated\) return;/);
  assert.match(source, /if \(phase === "setup"\) return <SetupScreen/);
  assert.doesNotMatch(source, /if \(!s\.required \|\| s\.authorized\)/);
});
