import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { createPasswordService, validateNewPassword } from '../src/passwords.ts';
import { createIdentityLimiter } from '../src/rateLimit.ts';

test('real async scrypt: unique salts, round-trip, old credential verification and bounded formats', async t => {
  const service = createPasswordService({ concurrency: 1 }); t.after(() => service.close());
  const pass = 'correct horse battery staple';
  let eventLoopProgress = false;
  const hashJob = service.hash(pass);
  setImmediate(() => { eventLoopProgress = true; });
  const hash = await hashJob;
  assert.ok(eventLoopProgress, 'KDF must not block the JS event loop');
  assert.match(hash, /^scrypt\$v1\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.notEqual(hash, await service.hash(pass));
  assert.deepEqual(await service.verify(pass, hash), { valid: true, needsRehash: false });
  assert.equal((await service.verify('wrong', hash)).valid, false);
  const salt = Buffer.alloc(16, 9);
  const legacy = `scrypt$${salt.toString('hex')}$${scryptSync('old-short', salt, 32).toString('hex')}`;
  assert.deepEqual(await service.verify('old-short', legacy), { valid: true, needsRehash: true });
  assert.equal((await service.verify(pass, null)).valid, false);
  assert.equal((await service.verify(pass, hash.replace('131072', '99999999999'))).valid, false);
});
test('KDF queue admission is bounded and closing rejects queued/active completions', async () => {
  const service = createPasswordService({ concurrency: 1, maxQueued: 1 });
  const first = service.hash('first passphrase'), second = service.hash('second passphrase');
  await assert.rejects(service.hash('third passphrase'), { code: 'rate-limited' });
  const all = Promise.allSettled([first, second]); service.close();
  const results = await all;
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'unavailable').length, 2);
  await assert.rejects(service.hash('closed passphrase'), { code: 'unavailable' });
});
test('password policy bounds Unicode codepoints and UTF-8 byte cost', () => {
  validateNewPassword('twelve chars okay');
  validateNewPassword('я'.repeat(12));
  assert.throws(() => validateNewPassword('😀'.repeat(6)), { code: 'invalid-input' });
  assert.throws(() => validateNewPassword('я'.repeat(513)), { code: 'invalid-input' });
  assert.throws(() => createPasswordService({ concurrency: 99 }), { code: 'invalid-input' });
});
test('identity rate limits are charged before concurrent attempts and expire by clock', () => {
  let time = 1000;
  const limiter = createIdentityLimiter({ now: () => time, accountLimit: 2, addressLimit: 3, globalLimit: 5 });
  limiter.admit('A', 'owner'); limiter.admit('B', 'owner');
  assert.throws(() => limiter.admit('C', 'owner'), { code: 'rate-limited' });
  time += 60_000; limiter.admit('C', 'owner');
  assert.equal(limiter.size(), 3);
});
test('rate limiter bounds memory even with distinct adversarial accounts/addresses', () => {
  const limiter = createIdentityLimiter({ maxKeys: 3 });
  limiter.admit('first', 'first');
  assert.throws(() => limiter.admit('second', 'second'), { code: 'rate-limited' });
  assert.equal(limiter.size(), 3);
});
