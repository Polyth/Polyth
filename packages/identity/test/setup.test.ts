import test from 'node:test';
import assert from 'node:assert/strict';
import { openControlPlane } from '@polyth/control-plane';
import { createIdentityService } from '../src/index.ts';
import { fixture, prepared, installed, testPasswords, deferred } from './fixtures.ts';

test('fresh setup status is minimal; operator claim is hash-only and expires', t => {
  const f = fixture(t), claim = f.identity.setup.issueClaim();
  assert.match(claim.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.identity.setup.status(), { state: 'uninitialized', methods: ['password'] });
  assert.ok(!JSON.stringify(f.control.all('SELECT * FROM setup_claims')).includes(claim.token));
  assert.ok(!JSON.stringify(f.control.all('SELECT * FROM audit_events')).includes(claim.token));
  f.advance(15 * 60_000);
  assert.throws(() => f.identity.setup.bindClaim(claim.token, 'aa'.repeat(32)), { code: 'invalid-claim' });
  assert.equal(f.control.get('SELECT 1 FROM users'), undefined);
});
test('claim binds to one browser; operator rotation invalidates old claim', t => {
  const f = fixture(t), p = prepared(f);
  f.identity.setup.bindClaim(p.claim.token, p.binding); // idempotent re-open
  assert.throws(() => f.identity.setup.bindClaim(p.claim.token, 'bc'.repeat(32)), { code: 'invalid-claim' });
  assert.throws(() => f.identity.setup.prepareRecovery(p.claim.token, 'bc'.repeat(32)), { code: 'invalid-claim' });
  f.identity.setup.issueClaim();
  assert.throws(() => f.identity.setup.prepareRecovery(p.claim.token, p.binding), { code: 'invalid-claim' });
});
test('owner, organization, Space, recovery, audit and session commit as one domain mutation', async t => {
  const f = fixture(t), { owner, recovery, input } = await installed(f);
  assert.match(owner.userId, /^usr_[a-f0-9-]{36}$/);
  assert.notEqual(owner.userId, 'usr_Max');
  assert.equal(f.identity.setup.status().state, 'ready');
  assert.equal(f.identity.sessions.resolve(owner.token)?.userId, owner.userId);
  assert.equal(f.control.all('SELECT * FROM users').length, 1);
  assert.equal(f.control.all('SELECT * FROM organizations').length, 1);
  const space = f.control.get<{ id: string; storage_identity: string }>('SELECT * FROM spaces')!;
  assert.equal(space.id, owner.spaceId); assert.equal(space.storage_identity, space.id);
  assert.equal(f.control.all('SELECT * FROM recovery_codes').length, 8);
  assert.equal(f.control.all('SELECT * FROM outbox').length, f.control.all('SELECT * FROM audit_events').length);
  const persisted = JSON.stringify([
    f.control.all('SELECT * FROM auth_sessions'), f.control.all('SELECT * FROM setup_claims'),
    f.control.all('SELECT * FROM recovery_codes'), f.control.all('SELECT * FROM audit_events'),
  ]);
  for (const secret of [owner.token, input.claimToken, input.browserBinding, ...recovery.codes]) assert.ok(!persisted.includes(secret));
  assert.throws(() => f.identity.setup.issueClaim(), { code: 'setup-completed' });
  await assert.rejects(f.identity.setup.complete(input), { code: 'setup-completed' });
});
test('missing acknowledgement or a stale recovery set never provisions an owner', async t => {
  const f = fixture(t), p = prepared(f);
  await assert.rejects(f.identity.setup.complete({ ...p.input, recoveryAcknowledged: false }), { code: 'recovery-ack-required' });
  f.identity.setup.prepareRecovery(p.claim.token, p.binding);
  await assert.rejects(f.identity.setup.complete(p.input), { code: 'recovery-ack-required' });
  assert.equal(f.control.get('SELECT 1 FROM users'), undefined);
});
test('two simultaneous completions create exactly one owner', async t => {
  const f = fixture(t), p = prepared(f);
  const outcomes = await Promise.allSettled([f.identity.setup.complete(p.input), f.identity.setup.complete(p.input)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.control.all('SELECT * FROM instance_roles').length, 1);
  assert.equal(f.control.all("SELECT * FROM audit_events WHERE action='setup.completed'").length, 1);
});
test('recovery rotation while password hashing rejects stale setup', async t => {
  const latch = deferred<string>();
  const f = fixture(t, { passwords: { ...testPasswords(), hash: () => latch.promise } }), p = prepared(f);
  const completion = f.identity.setup.complete(p.input);
  f.identity.setup.prepareRecovery(p.claim.token, p.binding);
  latch.resolve('test-only:owner test passphrase');
  await assert.rejects(completion, { code: 'conflict' });
  assert.equal(f.control.get('SELECT 1 FROM users'), undefined);
});
test('late audit failure rolls back identity, readiness, recovery consumption and session', async t => {
  const f = fixture(t), p = prepared(f), audit = f.control.audit;
  f.control.audit = (actor, action, resource) => { if (action === 'auth.session-created') throw new Error('injected audit fault'); return audit(actor, action, resource); };
  await assert.rejects(f.identity.setup.complete(p.input), /injected audit fault/);
  for (const table of ['users', 'principals', 'password_credentials', 'organizations', 'spaces', 'auth_sessions', 'recovery_codes']) assert.equal(f.control.all(`SELECT * FROM ${table}`).length, 0);
  assert.equal(f.identity.setup.status().state, 'configuring');
  assert.equal(f.control.all('SELECT * FROM setup_recovery').length, 8);
  f.control.audit = audit;
  await f.identity.setup.complete(p.input);
});
test('identity and revocable sessions survive closing/reopening the authority', async t => {
  const f = fixture(t), { owner } = await installed(f);
  f.identity.close(); f.control.close();
  const db = openControlPlane({ directory: f.directory });
  const second = createIdentityService(db, { passwords: testPasswords(), now: f.now });
  try {
    assert.equal(second.sessions.resolve(owner.token)?.userId, owner.userId);
    second.sessions.logout(owner.token);
    assert.equal(second.sessions.resolve(owner.token), null);
    assert.equal(second.setup.status().state, 'ready');
  } finally { second.close(); db.close(); }
});

test('independent processes racing first-owner completion share one transactional winner', async t => {
  const { spawn } = await import('node:child_process');
  const f = fixture(t), p = prepared(f);
  const program = `
    import { readFileSync } from 'node:fs';
    import { openControlPlane } from ${JSON.stringify(new URL('../../control-plane/src/index.ts', import.meta.url).href)};
    import { createIdentityService } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    const request = JSON.parse(readFileSync(0, 'utf8'));
    const db = openControlPlane({ directory: request.directory });
    const identity = createIdentityService(db, { now: () => request.now, passwords: {
      async hash(password) { await new Promise(r => setTimeout(r, 40)); return 'test-only:' + password; },
      async verify() { return { valid: false, needsRehash: false }; }, close() {}
    }});
    try { await identity.setup.complete(request.input); console.log('accepted'); }
    catch (error) { console.log(error.code ?? 'failed'); }
    finally { identity.close(); db.close(); }
  `;
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child timed out')); }, 10_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { out += data; });
    child.stderr.resume(); // experimental runtime warnings, not test evidence
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(`Child failed (${code})`)); });
    child.stdin.end(JSON.stringify({ directory: f.directory, input: p.input, now: f.now() }));
  });
  const outcomes = await Promise.all([run(), run()]);
  assert.deepEqual(outcomes.sort(), ['accepted', 'setup-completed']);
  assert.equal(f.control.all('SELECT 1 FROM users').length, 1);
  assert.equal(f.control.all("SELECT 1 FROM audit_events WHERE action='setup.completed'").length, 1);
});

test('real KDF setup and login persist no raw password, session token, claim or recovery code', async t => {
  const { createPasswordService } = await import('../src/passwords.ts');
  const f = fixture(t, { passwords: createPasswordService({ concurrency: 1 }) });
  const { owner, input, recovery } = await installed(f);
  const signed = await f.identity.credentials.login({ login: input.login, password: input.password });
  assert.equal(signed.session.userId, owner.userId);
  const persisted = JSON.stringify(['password_credentials', 'auth_sessions', 'setup_claims', 'recovery_codes', 'audit_events', 'outbox'].map(table => f.control.all(`SELECT * FROM ${table}`)));
  for (const secret of [input.password, input.claimToken, input.browserBinding, owner.token, signed.token, ...recovery.codes]) assert.ok(!persisted.includes(secret));
});
