import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createIdentityHttpAdapter } from '../src/http.ts';
import { fixture } from './fixtures.ts';
import { authenticator } from './webauthnTestkit.ts';

async function httpFixture(t: TestContext, useSecureOrigin = false) {
  let f!: ReturnType<typeof fixture>;
  let adapter: ReturnType<typeof createIdentityHttpAdapter>;
  const server = createServer((req, res) => {
    void (async () => {
      if (await adapter.handle(req, res)) return;
      try { const actor = adapter.requireHuman(req); res.end(JSON.stringify({ userId: actor.userId })); }
      catch { res.statusCode = 401; res.end('{}'); }
    })().catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const identityOrigin = useSecureOrigin ? origin.replace('http:', 'https:') : origin;
  f = fixture(t, { webauthn: { origin: identityOrigin } });
  adapter = createIdentityHttpAdapter(f.identity, { origin: identityOrigin, localOnly: !useSecureOrigin });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    try { adapter.authorizeUpgrade(req); }
    catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      ws.on('message', () => {
        try { adapter.authorizeUpgrade(req); ws.send('authorized'); }
        catch { ws.close(4401, 'Authentication required'); }
      });
    });
  });
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  const browser = () => {
    const jar = new Map<string, string>(); let csrf = '';
    return {
      cookie: () => [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
      async request(path: string, body?: unknown, extra: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') {
        const response = await fetch(origin + path, {
          method, headers: { origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
            'content-type': 'application/json', 'x-polyth-csrf': csrf, ...extra },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const cookies = response.headers.getSetCookie();
        for (const set of cookies) {
          const pair = set.split(';')[0]!, at = pair.indexOf('=');
          jar.set(pair.slice(0, at), pair.slice(at + 1));
        }
        const value = await response.json() as Record<string, any>;
        if (typeof value.csrfToken === 'string') csrf = value.csrfToken;
        return { status: response.status, value, cookies, headers: response.headers };
      },
    };
  };
  async function setup(b: ReturnType<typeof browser>) {
    await b.request('/api/auth/status');
    const claim = f.identity.setup.issueClaim();
    assert.equal((await b.request('/api/auth/setup/claim', { claimToken: claim.token })).status, 200);
    const recovery = await b.request('/api/auth/setup/recovery', { claimToken: claim.token });
    const result = await b.request('/api/auth/setup/complete', {
      claimToken: claim.token, name: 'Owner', organizationName: 'Local', login: 'owner',
      password: 'owner test passphrase', recoverySetId: recovery.value.setId, recoveryAcknowledged: true,
    });
    assert.equal(result.status, 200);
    return { result, claim, recovery };
  }
  return { ...f, origin, adapter, browser, setup };
}

test('HTTP account-first flow: minimal public status, bound claim, private cookies and real protected requests', async t => {
  const f = await httpFixture(t), b = f.browser();
  const status = await b.request('/api/auth/status');
  assert.equal(status.status, 200); assert.equal(status.value.authorized, false);
  assert.deepEqual(Object.keys(status.value).sort(), ['authorized', 'csrfToken', 'methods', 'required', 'scope', 'state']);
  assert.equal((await b.request('/api/auth/accounts')).status, 401);
  const { result } = await f.setup(b);
  assert.equal(result.value.ok, true); assert.equal(result.value.token, undefined);
  assert.equal(result.cookies.length, 2);
  for (const cookie of result.cookies) { assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Domain=/); }
  const me = await b.request('/api/auth/me');
  assert.match(me.value.id, /^usr_/);
  const privateData = await b.request('/private'); assert.equal(privateData.status, 200); assert.equal(privateData.value.userId, me.value.id);
  assert.equal((await b.request('/api/auth/accounts')).value.currentAccountId, me.value.id);
  assert.equal((await b.request('/api/auth/status')).headers.get('cache-control'), 'no-store');
  assert.equal((await b.request('/api/auth/logout', {})).status, 200);
  assert.equal((await b.request('/private')).status, 401);
  assert.equal((await b.request('/api/auth/status')).value.authorized, false);
});
test('HTTP Origin and CSRF defenses reject absent/wrong origin and forged browser claims', async t => {
  const f = await httpFixture(t), a = f.browser(), b = f.browser();
  await a.request('/api/auth/status'); await b.request('/api/auth/status');
  const claim = f.identity.setup.issueClaim();
  for (const origin of ['', 'https://attacker.invalid', f.origin + '.attacker.invalid']) {
    assert.equal((await a.request('/api/auth/setup/claim', { claimToken: claim.token }, { origin })).status, 403);
  }
  assert.equal((await a.request('/api/auth/setup/claim', { claimToken: claim.token }, { 'x-polyth-csrf': '' })).status, 403);
  assert.equal((await a.request('/api/auth/setup/claim', { claimToken: claim.token })).status, 200);
  const stolen = await b.request('/api/auth/setup/recovery', { claimToken: claim.token, browserBinding: a.cookie() });
  assert.equal(stolen.status, 401);
  assert.equal(f.control.get('SELECT 1 FROM users'), undefined);
});
test('operator claim issuance is not public; query tokens and forged ingress headers cannot unlock', async t => {
  const f = await httpFixture(t), b = f.browser();
  await b.request('/api/auth/status');
  assert.equal((await b.request('/api/auth/setup/issue-claim', {})).status, 401);
  assert.equal(f.control.get('SELECT 1 FROM setup_claims'), undefined);
  assert.equal((await b.request('/api/auth/status?token=do-not-accept')).status, 400);
  const denied = await b.request('/private', undefined, { 'x-polyth-user-id': 'usr_owner', 'x-polyth-internal-token': 'forged', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' });
  assert.equal(denied.status, 401);
});
test('HTTPS configuration never trusts a forged forwarded-proto over a plain socket', async t => {
  const f = await httpFixture(t, true), b = f.browser();
  assert.equal((await b.request('/api/auth/status', undefined, { 'x-forwarded-proto': 'https' })).status, 403);
  assert.throws(() => createIdentityHttpAdapter(f.identity, { origin: 'http://example.test' }), { code: 'invalid-input' });
  assert.throws(() => createIdentityHttpAdapter(f.identity, { origin: 'http://127.0.0.1' }), { code: 'invalid-input' });
});
test('independent installations cannot resolve one another\'s cookies or share cookie names', async t => {
  const first = await httpFixture(t), second = await httpFixture(t), b = first.browser();
  await first.setup(b);
  assert.notEqual(first.adapter.cookieName, second.adapter.cookieName);
  const response = await fetch(second.origin + '/private', { headers: { cookie: b.cookie() } });
  assert.equal(response.status, 401);
});
test('WS admission checks Origin; subsequent authority checks reject a revoked session', async t => {
  const f = await httpFixture(t), b = f.browser(); await f.setup(b);
  const bad = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws', { headers: { cookie: b.cookie(), origin: 'https://attacker.invalid' } });
  const [error] = await once(bad, 'error'); assert.match(String(error), /401/);
  const ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws', { headers: { cookie: b.cookie(), origin: f.origin } });
  await once(ws, 'open');
  const message = once(ws, 'message'); ws.send('probe');
  assert.equal(String((await message)[0]), 'authorized');
  await b.request('/api/auth/logout', {});
  const closed = once(ws, 'close'); ws.send('probe-after-revoke');
  assert.equal((await closed)[0], 4401);
});

test('HTTP parser rejects oversized and non-object JSON without leaking submitted secrets', async t => {
  const f = await httpFixture(t), b = f.browser();
  await b.request('/api/auth/status');
  const tooBig = await b.request('/api/auth/login', { password: 'sensitive-value'.repeat(2000), login: 'owner' });
  assert.equal(tooBig.status, 413); assert.deepEqual(tooBig.value, { error: 'body-too-large' });
  const invalid = await b.request('/api/auth/login', []);
  assert.equal(invalid.status, 400);
});

test('HTTP passkey flow is same-origin/CSRF bound, replay-safe, and preserves the last sign-in method', async t => {
  const f = await httpFixture(t), b = f.browser();
  await f.setup(b);
  const rpId = new URL(f.origin).hostname;
  const key = authenticator(t, rpId);

  assert.equal((await b.request('/api/auth/passkeys/register/options', { name: 'Browser key' }, { 'x-polyth-csrf': '' })).status, 403);
  const options = await b.request('/api/auth/passkeys/register/options', { name: 'Browser key' });
  assert.equal(options.status, 200);
  assert.equal(options.value.rp.id, rpId);
  const registered = await b.request('/api/auth/passkeys/register/complete', {
    name: 'Browser key', ...key.registration(options.value.challenge, f.origin),
  });
  assert.equal(registered.status, 200);
  assert.match(registered.value.id, /^pky_/);
  assert.equal((await b.request('/api/auth/passkeys')).value.passkeys.length, 1);

  await b.request('/api/auth/logout', {});
  assert.equal((await b.request('/api/auth/passkeys/register/options', { name: 'No session' })).status, 401);

  const authOptions = await b.request('/api/auth/passkeys/authenticate/options', {});
  assert.equal(authOptions.status, 200);
  const assertion = key.assertion(authOptions.value.challenge, 1, f.origin);
  const login = await b.request('/api/auth/passkeys/authenticate/complete', assertion);
  assert.equal(login.status, 200);
  assert.equal((await b.request('/api/auth/me')).status, 200);
  assert.equal((await b.request('/api/auth/passkeys/authenticate/complete', assertion)).status, 401);

  // Simulate an account whose passkey is now the only usable sign-in method.
  const me = await b.request('/api/auth/me');
  f.control.transaction(() => f.control.run('DELETE FROM password_credentials WHERE user_id=?', me.value.id));
  const list = await b.request('/api/auth/passkeys');
  const passkey = list.value.passkeys[0];
  const denied = await b.request(`/api/auth/passkeys/${passkey.id}`, { expectedRevision: passkey.revision }, {}, 'DELETE');
  assert.equal(denied.status, 409);
  assert.deepEqual(denied.value, { error: 'last-auth-method' });
  assert.equal((await b.request('/api/auth/passkeys')).value.passkeys.length, 1);
});
