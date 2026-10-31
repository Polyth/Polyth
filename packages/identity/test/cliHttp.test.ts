import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createIdentityHttpAdapter } from '../src/http.ts';
import { fixture } from './fixtures.ts';

const policy = {
  normalizeGrants(raw: unknown) {
    if (!Array.isArray(raw)) throw Object.assign(new Error('bad'), { code: 'invalid-input' });
    return [...new Set(raw.map(String))].sort();
  },
  profiles: { read: ['core.sessions.read'], control: ['core.sessions.read', 'core.sessions.create'] },
};

async function cliFixture(t: TestContext) {
  let adapter!: ReturnType<typeof createIdentityHttpAdapter>;
  const server = createServer((req, res) => {
    void (async () => {
      if (await adapter.handle(req, res)) return;
      res.statusCode = 404; res.end('{}');
    })().catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const f = fixture(t, { webauthn: { origin }, accessTokens: policy });
  adapter = createIdentityHttpAdapter(f.identity, { origin, localOnly: true });
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });

  // A browser: cookie jar + CSRF, exactly like the web UI.
  const jar = new Map<string, string>(); let csrf = '';
  const browser = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + path, {
      method,
      headers: { origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json', 'x-polyth-csrf': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(';')[0]!, at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const value = await response.json() as Record<string, any>;
    if (typeof value.csrfToken === 'string') csrf = value.csrfToken;
    return { status: response.status, value };
  };
  // A command-line client: no cookie, no Origin, no CSRF.
  const cli = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() as Record<string, any> };
  };
  await browser('/api/auth/status');
  const claim = f.identity.setup.issueClaim();
  await browser('/api/auth/setup/claim', { claimToken: claim.token });
  const recovery = await browser('/api/auth/setup/recovery', { claimToken: claim.token });
  const done = await browser('/api/auth/setup/complete', {
    claimToken: claim.token, name: 'Owner', organizationName: 'Local', login: 'owner',
    password: 'owner test passphrase', recoverySetId: recovery.value.setId, recoveryAcknowledged: true,
  });
  assert.equal(done.status, 200);
  return { f, origin, browser, cli };
}

test('CLI device sign-in over HTTP: start, confirm in the signed-in UI, redeem, logout', async (t) => {
  const { browser, cli } = await cliFixture(t);
  const start = await cli('/api/auth/cli/device', { label: 'polyth CLI on test', profile: 'read' });
  assert.equal(start.status, 200);
  assert.equal(start.value.verificationPath, '/?settings=command-line');
  assert.equal((await cli('/api/auth/cli/device/token', { deviceCode: start.value.deviceCode })).value.status, 'pending');

  const lookup = await browser('/api/auth/cli/device/lookup', { userCode: start.value.userCode });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.value.label, 'polyth CLI on test');
  assert.equal((await browser('/api/auth/cli/device/decide', { userCode: start.value.userCode, approve: true })).status, 200);

  const redeemed = await cli('/api/auth/cli/device/token', { deviceCode: start.value.deviceCode });
  assert.equal(redeemed.value.status, 'issued');
  const token = redeemed.value.token as string;
  assert.match(token, /^pth_[a-f0-9]{64}$/);

  const listed = await browser('/api/auth/cli');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.value.tokens.map((x: { kind: string }) => x.kind), ['device']);
  assert.equal(listed.value.canManageTrust, true);
  assert.equal(listed.value.trust.mode, 'off');

  assert.deepEqual((await cli('/api/auth/cli/logout', {}, { authorization: `Bearer ${token}` })).value, { ok: true });
  assert.deepEqual((await browser('/api/auth/cli')).value.tokens, []);
});

test('CLI endpoints refuse browser-originated requests; UI endpoints refuse requests without the browser binding', async (t) => {
  const { origin, cli } = await cliFixture(t);
  assert.equal((await cli('/api/auth/cli/device', { profile: 'read' }, { origin })).status, 403);
  assert.equal((await cli('/api/auth/cli/device', { profile: 'read' }, { 'sec-fetch-site': 'same-origin' })).status, 403);
  // A token holder cannot mint tokens or change the no-token mode: those are cookie+CSRF UI routes.
  assert.equal((await cli('/api/auth/cli/tokens', { label: 'x', profile: 'read' }, { authorization: `Bearer pth_${'a'.repeat(64)}` })).status, 403);
  assert.equal((await cli('/api/auth/cli/trust', { mode: 'loopback', expectedRevision: 0 })).status, 403);
});

test('automation token creation and the no-token mode through the UI routes', async (t) => {
  const { browser } = await cliFixture(t);
  const created = await browser('/api/auth/cli/tokens', { label: 'nightly', profile: 'control', expiresInDays: null });
  assert.equal(created.status, 200);
  assert.match(created.value.token, /^pth_/);
  assert.equal(created.value.summary.expiresAt, null);
  const trust = await browser('/api/auth/cli/trust', { mode: 'loopback', expectedRevision: 0 });
  assert.equal(trust.status, 200);
  assert.equal(trust.value.mode, 'loopback');
  const summary = (await browser('/api/auth/cli')).value.tokens[0];
  assert.equal((await browser(`/api/auth/cli/tokens/${summary.id}`, { expectedRevision: summary.revision }, 'DELETE')).status, 200);
});
