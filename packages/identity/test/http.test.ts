import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createIdentityHttpAdapter } from '../src/http.ts';
import { fixture, installed } from './fixtures.ts';
import { authenticator } from './webauthnTestkit.ts';

async function httpFixture(t: TestContext, useSecureOrigin = false, loopbackTrusted = false) {
  let f!: ReturnType<typeof fixture>;
  let adapter: ReturnType<typeof createIdentityHttpAdapter>;
  const server = createServer((req, res) => {
    void (async () => {
      if (await adapter.handle(req, res)) return;
      if (req.url === '/shell') { res.end(JSON.stringify(adapter.shellStatus(req, res))); return; }
      try { const actor = adapter.requireHuman(req); res.end(JSON.stringify({ userId: actor.userId })); }
      catch { res.statusCode = 401; res.end('{}'); }
    })().catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const identityOrigin = useSecureOrigin ? origin.replace('http:', 'https:') : origin;
  // Identity stores limits opaquely; the host normalizer owns the shape.
  f = fixture(t, { webauthn: { origin: identityOrigin }, normalizeLimits: raw => {
    const value = raw as { messagesPerDay?: unknown };
    if (typeof value?.messagesPerDay !== 'number' && value?.messagesPerDay !== null) throw Object.assign(new Error('bad'), { code: 'invalid-input' });
    return value.messagesPerDay === null ? null : { messagesPerDay: value.messagesPerDay };
  }, normalizePermissions: raw => {
    if (!Array.isArray(raw) || raw.some(entry => entry !== 'harnesses.manage')) throw Object.assign(new Error('bad'), { code: 'invalid-input' });
    return [...new Set(raw as string[])];
  } });
  adapter = createIdentityHttpAdapter(f.identity, {
    origin: identityOrigin, localOnly: !useSecureOrigin,
    ...(loopbackTrusted ? { loopbackTrusted: true } : {}),
  });
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
  // Boot reads the session's own account from the status, without /accounts.
  assert.equal((await b.request('/api/auth/status')).value.accountId, me.value.id);
  assert.equal((await b.request('/api/auth/status')).headers.get('cache-control'), 'no-store');
  assert.equal((await b.request('/api/auth/logout', {})).status, 200);
  assert.equal((await b.request('/private')).status, 401);
  const anonymous = await b.request('/api/auth/status');
  assert.equal(anonymous.value.authorized, false);
  assert.equal(anonymous.value.accountId, undefined);
});
test('the HTML shell status matches /api/auth/status without its CSRF token', async t => {
  const f = await httpFixture(t, false, true);
  await installed(f);
  const shell = await f.browser().request('/shell');
  assert.equal(shell.value.authorized, true);
  assert.equal(shell.value.scope, 'ui-session');
  assert.match(shell.value.accountId, /^usr_/);
  assert.equal(shell.value.csrfToken, undefined, 'the nonce never lands in HTML');
  assert.equal(shell.cookies.length, 2, 'the cookies the status relies on are minted with the page');
});
test('loopback-trusted local-only profile unlocks the browser UI with one reusable owner session', async t => {
  const f = await httpFixture(t, false, true);
  await installed(f); // setup browser session only, as the beta launcher performs it out of band
  const b = f.browser();
  const status = await b.request('/api/auth/status');
  assert.equal(status.status, 200);
  assert.equal(status.value.authorized, true);
  assert.equal(status.value.scope, 'ui-session');
  assert.equal(status.cookies.length, 2); // CSRF nonce plus the owner session
  const accounts = await b.request('/api/auth/accounts');
  assert.equal(accounts.status, 200);
  assert.match(accounts.value.currentAccountId, /^usr_/);
  assert.equal(accounts.value.canManage, true);
  assert.equal((await b.request('/api/auth/me')).status, 200);
  assert.equal((await b.request('/api/auth/sessions')).value.sessions.length, 2);
  // A second browser context reuses the loopback session instead of accumulating rows.
  const second = f.browser();
  assert.equal((await second.request('/api/auth/status')).value.authorized, true);
  assert.deepEqual(f.control.all<{ label: string }>('SELECT label FROM auth_sessions ORDER BY label').map(row => row.label),
    ['Loopback local owner', 'Setup browser']);
});
test('loopback trust without a local-only origin still requires a real session for identity data', async t => {
  const f = await httpFixture(t, true, true);
  await installed(f);
  const b = f.browser();
  const status = await b.request('/api/auth/status');
  assert.equal(status.status, 200);
  assert.equal(status.value.authorized, true);
  assert.equal(status.value.scope, 'local-user');
  assert.equal(status.cookies.length, 1); // CSRF nonce only
  assert.equal((await b.request('/api/auth/accounts')).status, 401);
  assert.equal(f.control.all('SELECT id FROM auth_sessions').length, 1);
});
test('loopback-trusted profile never mints a session before setup is ready', async t => {
  const f = await httpFixture(t, false, true), b = f.browser();
  assert.equal((await b.request('/api/auth/status')).status, 200);
  assert.equal((await b.request('/api/auth/accounts')).status, 401);
  assert.equal(f.control.all('SELECT id FROM auth_sessions').length, 0);
});
test('HTTP origin and CSRF defenses reject absent/wrong origin and forged browser claims', async t => {
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

test('HTTP owner account management: limits, rename and password reset need an elevated owner', async t => {
  const f = await httpFixture(t), owner = f.browser();
  await f.setup(owner);
  const created = await owner.request('/api/auth/accounts', { login: 'olena', name: 'Olena', password: 'member test passphrase' });
  assert.equal(created.status, 200);
  const id = created.value.id as string;

  const listed = (await owner.request('/api/auth/accounts')).value.accounts.find((a: { id: string }) => a.id === id);
  assert.equal(listed.limits, null);
  assert.equal(listed.usage.messages, 0);

  const saved = await owner.request(`/api/auth/accounts/${id}/limits`, { limits: { messagesPerDay: 5 }, expectedRevision: 0 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.limits, { messagesPerDay: 5 });
  assert.equal((await owner.request(`/api/auth/accounts/${id}/limits`, { limits: { messagesPerDay: 6 }, expectedRevision: 0 })).status, 409);
  assert.equal((await owner.request(`/api/auth/accounts/${id}/limits`, { expectedRevision: 1 })).status, 400);
  assert.equal((await owner.request(`/api/auth/accounts/${id}/limits`)).value.revision, 1);

  const renamed = await owner.request(`/api/auth/accounts/${id}/profile`, { name: 'Olena K.', expectedRevision: created.value.revision });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.value.name, 'Olena K.');

  const member = f.browser();
  await member.request('/api/auth/status');
  assert.equal((await member.request('/api/auth/login', { login: 'olena', password: 'member test passphrase' })).status, 200);
  assert.deepEqual((await member.request('/api/auth/me')).value.limits, { messagesPerDay: 5 });
  // A member can neither change its limits nor reset anyone's password.
  assert.equal((await member.request(`/api/auth/accounts/${id}/limits`, { limits: null, expectedRevision: 1 })).status, 403);
  assert.equal((await member.request(`/api/auth/accounts/${id}/password`, { password: 'another long passphrase' })).status, 403);

  // Elevation lapses after five minutes; the owner must confirm again.
  f.advance(6 * 60_000);
  const stale = await owner.request(`/api/auth/accounts/${id}/password`, { password: 'a new long passphrase' });
  assert.equal(stale.status, 403);
  assert.equal(stale.value.error, 'reauth-required');
  assert.equal((await owner.request('/api/auth/reauthenticate', { password: 'owner test passphrase' })).status, 200);
  assert.equal((await owner.request(`/api/auth/accounts/${id}/password`, { password: 'a new long passphrase' })).status, 200);
  assert.equal((await member.request('/api/auth/me')).status, 401);
});

test('HTTP account permissions: only an elevated instance owner grants them, and the account reads its own', async t => {
  const f = await httpFixture(t), owner = f.browser();
  await f.setup(owner);
  const created = await owner.request('/api/auth/accounts', { login: 'ida', name: 'Ida', password: 'member test passphrase' });
  const id = created.value.id as string;
  const ownerId = (await owner.request('/api/auth/me')).value.id as string;

  assert.deepEqual((await owner.request(`/api/auth/accounts/${id}/permissions`)).value, { userId: id, permissions: [], revision: 0 });
  const saved = await owner.request(`/api/auth/accounts/${id}/permissions`, { permissions: ['harnesses.manage'], expectedRevision: 0 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value, { userId: id, permissions: ['harnesses.manage'], revision: 1 });
  assert.equal(f.identity.permissions.has(id, 'harnesses.manage'), true);
  // The owner already holds every permission and cannot be given any.
  assert.equal(f.identity.permissions.has(ownerId, 'harnesses.manage'), true);
  assert.equal((await owner.request(`/api/auth/accounts/${ownerId}/permissions`, { permissions: [], expectedRevision: 0 })).status, 400);
  assert.equal((await owner.request(`/api/auth/accounts/${id}/permissions`, { permissions: ['root'], expectedRevision: 1 })).status, 400);
  assert.equal((await owner.request(`/api/auth/accounts/${id}/permissions`, { permissions: [], expectedRevision: 0 })).status, 409);
  assert.equal((await owner.request(`/api/auth/accounts/${id}/permissions`, { expectedRevision: 1 })).status, 400);
  const listed = (await owner.request('/api/auth/accounts')).value.accounts.find((a: { id: string }) => a.id === id);
  assert.deepEqual(listed.permissions, ['harnesses.manage']);

  const member = f.browser();
  await member.request('/api/auth/status');
  assert.equal((await member.request('/api/auth/login', { login: 'ida', password: 'member test passphrase' })).status, 200);
  assert.deepEqual((await member.request('/api/auth/me')).value.permissions, ['harnesses.manage']);
  assert.equal((await member.request(`/api/auth/accounts/${id}/permissions`)).status, 200);
  // A permitted account still cannot change permissions, its own or anyone's.
  assert.equal((await member.request(`/api/auth/accounts/${id}/permissions`, { permissions: [], expectedRevision: 1 })).status, 403);
  assert.equal((await member.request(`/api/auth/accounts/${ownerId}/permissions`)).status, 404);

  // Revoking is an ordinary write.
  const revoked = await owner.request(`/api/auth/accounts/${id}/permissions`, { permissions: [], expectedRevision: 1 });
  assert.deepEqual(revoked.value, { userId: id, permissions: [], revision: 2 });
  assert.equal(f.identity.permissions.has(id, 'harnesses.manage'), false);
});

// "Just me" Polyth Desktop: no credential exists. The Desktop main process puts
// the in-process owner session into its own window; any other browser or
// local process on this machine reaches only a locked status, and a page
// re-pointed at loopback (DNS rebinding) is refused on Host before any cookie.
test('a password-less owner: only the Desktop session opens the API; other browsers and rebound pages stay out', async t => {
  const f = await httpFixture(t);
  const owner = f.identity.setup.completeLocal({ name: 'Ida' });
  const stranger = f.browser();
  const status = await stranger.request('/api/auth/status');
  assert.equal(status.value.accessMode, 'local');
  assert.equal(status.value.authorized, false);
  assert.equal(status.value.scope, 'anonymous');
  assert.ok(status.cookies.every(cookie => !cookie.startsWith(`${f.adapter.cookieName}=`)), 'no owner session for a plain loopback browser');
  assert.equal((await stranger.request('/protected')).status, 401);
  assert.equal((await stranger.request('/api/auth/setup/claim', { claimToken: 'ab'.repeat(32) })).value.error, 'setup-completed');
  assert.equal((await stranger.request('/api/auth/owner-credential/recovery', {})).status, 401);

  const desktop = f.identity.issueLocalOwnerSession('Polyth Desktop')!;
  const window = f.browser();
  await window.request('/api/auth/status');
  const withSession = { cookie: `${window.cookie()}; ${f.adapter.cookieName}=${desktop.token}` };
  const me = await window.request('/protected', undefined, withSession);
  assert.deepEqual([me.status, me.value.userId], [200, owner.userId]);
  const signedIn = await window.request('/api/auth/status', undefined, withSession);
  assert.deepEqual([signedIn.value.authorized, signedIn.value.scope, signedIn.value.accountId], [true, 'ui-session', owner.userId]);

  // DNS rebinding: the attacker's name resolves to 127.0.0.1, so the browser
  // sends that name as Host. Identity binds to its configured origin.
  const port = new URL(f.origin).port;
  const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/auth/status', headers: { host: `attacker.example:${port}`, cookie: withSession.cookie } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(rebound.status, 403);
  assert.equal(JSON.parse(rebound.body).error, 'wrong-origin');
});

test('a password-less owner protects the account over HTTP before adding people or sign-in providers', async t => {
  const f = await httpFixture(t);
  const owner = f.identity.setup.completeLocal({ name: 'Ida' });
  const desktop = f.identity.issueLocalOwnerSession('Polyth Desktop')!;
  const window = f.browser();
  await window.request('/api/auth/status');
  const session = () => ({ cookie: `${window.cookie()}; ${f.adapter.cookieName}=${desktop.token}` });

  const guest = { login: 'guest', name: 'Guest', password: 'guest test passphrase' };
  const blocked = await window.request('/api/auth/accounts', guest, session());
  assert.deepEqual([blocked.status, blocked.value.error], [409, 'owner-credential-required']);
  const provider = await window.request('/api/auth/providers/configure', { id: 'github', kind: 'github', issuer: 'https://github.com' }, session());
  assert.deepEqual([provider.status, provider.value.error], [409, 'owner-credential-required']);

  const unconfirmed = await window.request('/api/auth/owner-credential/recovery', {}, session());
  assert.deepEqual([unconfirmed.status, unconfirmed.value.error], [403, 'owner-confirmation-required']);
  // Only the Desktop main process, in-process, confirms its window session.
  assert.equal(f.identity.confirmLocalOwnerSession('Polyth Desktop', desktop.token), true);
  const recovery = await window.request('/api/auth/owner-credential/recovery', {}, session());
  assert.equal(recovery.status, 200);
  assert.equal(recovery.value.codes.length, 8);
  const unacknowledged = await window.request('/api/auth/owner-credential', { password: 'owner test passphrase', recoverySetId: recovery.value.setId }, session());
  assert.deepEqual([unacknowledged.status, unacknowledged.value.error], [400, 'recovery-ack-required']);
  const secured = await window.request('/api/auth/owner-credential', { password: 'owner test passphrase', recoverySetId: recovery.value.setId, recoveryAcknowledged: true }, session());
  assert.deepEqual([secured.status, secured.value.login], [200, 'owner']);
  assert.equal((await window.request('/api/auth/status', undefined, session())).value.accessMode, 'accounts');
  assert.equal((await window.request('/api/auth/accounts', guest, session())).status, 200);

  const browser = f.browser();
  await browser.request('/api/auth/status');
  const login = await browser.request('/api/auth/login', { login: 'owner', password: 'owner test passphrase' });
  assert.equal(login.status, 200);
  assert.equal((await browser.request('/protected')).value.userId, owner.userId);
});
