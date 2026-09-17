import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

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

export function authenticator(t: TestContext, rpId = 'example.test') {
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
