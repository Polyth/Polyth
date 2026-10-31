import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openControlPlane } from '@polyth/control-plane';
import { createIdentityService, canonicalHttpsIssuer } from '../src/index.ts';
import type {
  IdentityProviderAdapter,
  ProviderNetworkBroker,
  ProviderSecretBroker,
} from '../src/index.ts';
import { testPasswords } from './fixtures.ts';

class Secrets implements ProviderSecretBroker {
  values = new Map<string, string>();
  async put(_purpose: string, value: string) { const ref = `secret_${this.values.size + 1}`; this.values.set(ref, value); return ref; }
  async get(ref: string) { const value = this.values.get(ref); if (value === undefined) throw new Error('missing'); return value; }
  async delete(ref: string) { this.values.delete(ref); }
}
class Network implements ProviderNetworkBroker {
  async request() { return { status: 200, headers: {}, body: '{}' }; }
}

test('provider login consumes single-use exchange before resolving a linked Polyth account', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'polyth-provider-login-'));
  const control = openControlPlane({ directory });
  let exchanges = 0;
  const adapter: IdentityProviderAdapter<{ subject: string }> = {
    kind: 'fake',
    capabilities: { web: true },
    canonicalizeIssuer: canonicalHttpsIssuer,
    begin(input) { return { authorizationUrl: `https://login.example/authorize?state=${input.state}` }; },
    async exchange(input) { exchanges += 1; return { subject: input.code }; },
    async resolveIdentity(result) { return { issuer: 'https://issuer.example', subject: result.subject }; },
  };
  const identity = createIdentityService(control, {
    passwords: testPasswords(),
    providers: { adapters: [adapter], secrets: new Secrets(), network: new Network() },
  });
  t.after(() => {
    identity.close();
    control.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const claim = identity.setup.issueClaim();
  const binding = 'ab'.repeat(32);
  identity.setup.bindClaim(claim.token, binding);
  const recovery = identity.setup.prepareRecovery(claim.token, binding);
  const owner = await identity.setup.complete({
    claimToken: claim.token,
    browserBinding: binding,
    name: 'Owner',
    organizationName: 'Home',
    login: 'owner',
    password: 'owner test passphrase',
    recoverySetId: recovery.setId,
    recoveryAcknowledged: true,
  });

  assert.ok(identity.providers);
  assert.ok(identity.providerLogin);
  let provider = await identity.providers.configure({
    id: 'work',
    kind: 'fake',
    issuer: 'https://issuer.example',
  });
  provider = identity.providers.setEnabled(provider.id, provider.revision, true);
  assert.equal(provider.enabled, true);

  const unlinked = await identity.providerLogin.begin({
    providerId: 'work',
    browserBinding: 'cd'.repeat(32),
    callbackUrl: 'https://polyth.example/auth/provider/callback',
    returnTo: '/chat',
  });
  await assert.rejects(identity.providerLogin.complete({
    providerId: 'work',
    state: unlinked.state,
    browserBinding: 'cd'.repeat(32),
    code: 'unlinked-subject',
  }), { code: 'invalid-credentials' });
  assert.notEqual(
    control.get<{ consumed_at_ms: number | null }>('SELECT consumed_at_ms FROM provider_transactions WHERE id=?', unlinked.id)?.consumed_at_ms,
    null,
  );

  identity.providers.link(owner.userId, 'work', { issuer: 'https://issuer.example', subject: 'linked-subject' });
  const linked = await identity.providerLogin.begin({
    providerId: 'work',
    browserBinding: 'ef'.repeat(32),
    callbackUrl: 'https://polyth.example/auth/provider/callback',
    returnTo: '/settings/access',
  });
  const signed = await identity.providerLogin.complete({
    providerId: 'work',
    state: linked.state,
    browserBinding: 'ef'.repeat(32),
    code: 'linked-subject',
    label: 'Provider test',
  });
  assert.equal(signed.returnTo, '/settings/access');
  assert.equal(identity.sessions.resolve(signed.token)?.userId, owner.userId);
  assert.equal(exchanges, 2);
});
