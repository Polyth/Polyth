import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { fixture, installed } from './fixtures.ts';

type Encodable = number | string | Buffer | Encodable[] | Map<Encodable, Encodable> | boolean | null;
function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length <= 0xff) return Buffer.from([(major << 5) | 24, length]);
  if (length <= 0xffff) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(length, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(length, 1); return b;
}
function cbor(value: Encodable): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) {
    const parts: Buffer[] = [head(5, value.size)];
    for (const [key, item] of value) parts.push(cbor(key), cbor(item));
    return Buffer.concat(parts);
  }
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  return Buffer.from([0xf6]);
}
const b64 = (value: Buffer): string => value.toString('base64url');
const from64 = (value: string): Buffer => Buffer.from(value, 'base64url');

function authenticator(t: TestContext, rpId = 'example.test') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  assert.ok(jwk.x && jwk.y);
  const cose = cbor(new Map<Encodable, Encodable>([[1, 2], [3, -7], [-1, 1], [-2, from64(jwk.x)], [-3, from64(jwk.y)]]));
  const credentialId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest().subarray(0, 32);
  const rpHash = createHash('sha256').update(rpId).digest();
  const client = (type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = 'https://example.test') => {
    const raw = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    return { raw, encoded: b64(raw) };
  };
  return {
    credentialId: b64(credentialId),
    registration(challenge: string, origin?: string) {
      const clientData = client('webauthn.create', challenge, origin);
      const authData = Buffer.concat([
        rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
        Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]), credentialId, cose,
      ]);
      const attestation = cbor(new Map<Encodable, Encodable>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { credentialId: b64(credentialId), clientDataJSON: clientData.encoded, attestationObject: b64(attestation) };
    },
    assertion(challenge: string, count: number, origin = 'https://example.test', overrideRpHash?: Buffer) {
      const clientData = client('webauthn.get', challenge, origin);
      const authData = Buffer.alloc(37);
      (overrideRpHash ?? rpHash).copy(authData, 0); authData[32] = 0x05; authData.writeUInt32BE(count, 33);
      const signed = Buffer.concat([authData, createHash('sha256').update(clientData.raw).digest()]);
      return {
        credentialId: b64(credentialId), clientDataJSON: clientData.encoded,
        authenticatorData: b64(authData), signature: b64(sign('sha256', signed, privateKey)),
      };
    },
  };
}

async function passkeyFixture(t: TestContext) {
  const f = fixture(t, { webauthn: { origin: 'https://example.test', rpId: 'example.test', rpName: 'Polyth Test' } });
  const { owner } = await installed(f);
  const key = authenticator(t);
  const begin = f.identity.passkeys.beginRegistration(owner.token, 'Laptop passkey');
  const passkey = f.identity.passkeys.completeRegistration(owner.token, { name: 'Laptop passkey', ...key.registration(begin.challenge) });
  return { ...f, owner, key, passkey };
}

test('registers a verified resident passkey and authenticates it with a single-use challenge', async t => {
  const f = await passkeyFixture(t);
  assert.deepEqual(f.identity.setup.status().methods, ['password', 'passkey']);
  assert.equal(f.identity.passkeys.list(f.owner.token)[0]?.name, 'Laptop passkey');
  const options = f.identity.passkeys.beginAuthentication();
  const issued = f.identity.passkeys.completeAuthentication({ ...f.key.assertion(options.challenge, 1), label: 'Security key' });
  assert.equal(issued.session.userId, f.owner.userId);
  assert.ok(f.identity.sessions.resolve(issued.token));
  assert.throws(() => f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 2)), { code: 'invalid-credentials' });
});

test('rejects wrong origin, wrong RP ID hash and non-advancing authenticator counters', async t => {
  const f = await passkeyFixture(t);
  let options = f.identity.passkeys.beginAuthentication();
  assert.throws(() => f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 1, 'https://attacker.test')), { code: 'invalid-credentials' });
  options = f.identity.passkeys.beginAuthentication();
  assert.throws(() => f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 1, 'https://example.test', Buffer.alloc(32, 7))), { code: 'invalid-credentials' });
  options = f.identity.passkeys.beginAuthentication();
  f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 5));
  options = f.identity.passkeys.beginAuthentication();
  assert.throws(() => f.identity.passkeys.completeAuthentication(f.key.assertion(options.challenge, 5)), { code: 'invalid-credentials' });
});

test('registration is bound to the elevated user session and challenge', async t => {
  const f = fixture(t, { webauthn: { origin: 'https://example.test' } }), { owner } = await installed(f), key = authenticator(t);
  const other = await f.identity.accounts.createLocal(owner.token, { login: 'other', name: 'Other', password: 'another testing passphrase' });
  const otherLogin = await f.identity.credentials.login({ login: 'other', password: 'another testing passphrase' });
  const begin = f.identity.passkeys.beginRegistration(owner.token, 'Owner key');
  assert.throws(() => f.identity.passkeys.completeRegistration(otherLogin.token, { name: 'Stolen', ...key.registration(begin.challenge) }), { code: 'invalid-credentials' });
  assert.equal(f.control.get('SELECT 1 FROM passkey_credentials WHERE user_id=?', other.id), undefined);
});

test('passkey removal is revisioned and cannot remove the last usable sign-in method', async t => {
  const f = await passkeyFixture(t);
  f.control.transaction(() => f.control.run('DELETE FROM password_credentials WHERE user_id=?', f.owner.userId));
  assert.throws(() => f.identity.passkeys.remove(f.owner.token, f.passkey.id, f.passkey.revision), { code: 'last-auth-method' });
  assert.equal(f.identity.passkeys.list(f.owner.token).length, 1);
});

test('operator break-glass password reset is installation-bound, audited, and revokes sessions without changing grants', async t => {
  const f = fixture(t), { owner } = await installed(f);
  const beforeMemberships = f.control.all('SELECT org_id,user_id,role,state FROM organization_memberships ORDER BY org_id,user_id');
  await assert.rejects(f.identity.credentials.operatorResetPassword({ userId: owner.userId, password: 'replacement testing passphrase', installationId: 'wrong', reason: 'Operator console recovery after lost credentials' }), { code: 'forbidden' });
  await f.identity.credentials.operatorResetPassword({ userId: owner.userId, password: 'replacement testing passphrase', installationId: f.control.installation().id, reason: 'Operator console recovery after lost credentials' });
  assert.equal(f.identity.sessions.resolve(owner.token), null);
  assert.deepEqual(f.control.all('SELECT org_id,user_id,role,state FROM organization_memberships ORDER BY org_id,user_id'), beforeMemberships);
  assert.ok(f.control.get("SELECT 1 FROM audit_events WHERE actor_id='operator:break-glass' AND action='auth.break-glass-password-reset' AND resource_id=?", owner.userId));
  const logged = await f.identity.credentials.login({ login: 'Max', password: 'replacement testing passphrase' });
  assert.equal(logged.session.userId, owner.userId);
});
