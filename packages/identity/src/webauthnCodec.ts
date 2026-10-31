import { createPublicKey, createHash, type JsonWebKey } from 'node:crypto';
import { controlError } from '@polyth/control-plane';

export const base64url = (value: Buffer): string => value.toString('base64url');
export function decodeBase64url(value: unknown, maximum = 16_384): Buffer {
  if (typeof value !== 'string' || !value || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw controlError('invalid-credentials', 'Passkey response is invalid');
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (!decoded.length || decoded.toString('base64url') !== value.replace(/=+$/g, '')) throw new Error('invalid');
    return decoded;
  } catch { throw controlError('invalid-credentials', 'Passkey response is invalid'); }
}

type CborValue = number | string | Buffer | boolean | null | CborValue[] | Map<CborValue, CborValue>;
interface CborResult { value: CborValue; offset: number }
function integer(bytes: Buffer, offset: number, count: number): number {
  if (offset + count > bytes.length) throw new Error('truncated');
  if (count === 1) return bytes[offset]!;
  if (count === 2) return bytes.readUInt16BE(offset);
  if (count === 4) return bytes.readUInt32BE(offset);
  if (count === 8) {
    const n = bytes.readBigUInt64BE(offset);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('large integer');
    return Number(n);
  }
  throw new Error('integer width');
}
function item(bytes: Buffer, start = 0, depth = 0): CborResult {
  if (depth > 12 || start >= bytes.length) throw new Error('invalid cbor');
  const first = bytes[start]!, major = first >> 5, ai = first & 31;
  let cursor = start + 1, length: number;
  if (ai < 24) length = ai;
  else if ([24, 25, 26, 27].includes(ai)) {
    const width = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : 8;
    length = integer(bytes, cursor, width); cursor += width;
  } else throw new Error('indefinite cbor is not accepted');
  if (major === 0) return { value: length, offset: cursor };
  if (major === 1) return { value: -1 - length, offset: cursor };
  if (major === 2 || major === 3) {
    if (cursor + length > bytes.length) throw new Error('truncated');
    const raw = bytes.subarray(cursor, cursor + length);
    return { value: major === 2 ? Buffer.from(raw) : new TextDecoder('utf-8', { fatal: true }).decode(raw), offset: cursor + length };
  }
  if (major === 4) {
    const values: CborValue[] = [];
    for (let i = 0; i < length; i++) { const next = item(bytes, cursor, depth + 1); values.push(next.value); cursor = next.offset; }
    return { value: values, offset: cursor };
  }
  if (major === 5) {
    const values = new Map<CborValue, CborValue>();
    for (let i = 0; i < length; i++) {
      const key = item(bytes, cursor, depth + 1); cursor = key.offset;
      const value = item(bytes, cursor, depth + 1); cursor = value.offset;
      values.set(key.value, value.value);
    }
    return { value: values, offset: cursor };
  }
  if (major === 7 && ai === 20) return { value: false, offset: cursor };
  if (major === 7 && ai === 21) return { value: true, offset: cursor };
  if (major === 7 && ai === 22) return { value: null, offset: cursor };
  throw new Error('unsupported cbor');
}
export function decodeCbor(bytes: Buffer): CborValue {
  try {
    const decoded = item(bytes);
    if (decoded.offset !== bytes.length) throw new Error('trailing cbor');
    return decoded.value;
  } catch { throw controlError('invalid-credentials', 'Passkey response is invalid'); }
}
export function decodeCborPrefix(bytes: Buffer): CborResult {
  try { return item(bytes); }
  catch { throw controlError('invalid-credentials', 'Passkey response is invalid'); }
}
const mapNumber = (map: Map<CborValue, CborValue>, key: number): number => {
  const value = map.get(key);
  if (typeof value !== 'number') throw controlError('invalid-credentials', 'Passkey key is invalid');
  return value;
};
const mapBytes = (map: Map<CborValue, CborValue>, key: number): Buffer => {
  const value = map.get(key);
  if (!Buffer.isBuffer(value)) throw controlError('invalid-credentials', 'Passkey key is invalid');
  return value;
};
export function coseToSpki(cose: Buffer): { algorithm: -257 | -8 | -7; pem: string } {
  const value = decodeCbor(cose);
  if (!(value instanceof Map)) throw controlError('invalid-credentials', 'Passkey key is invalid');
  const kty = mapNumber(value, 1), alg = mapNumber(value, 3);
  let jwk: JsonWebKey;
  if (kty === 2 && alg === -7 && mapNumber(value, -1) === 1) {
    const x = mapBytes(value, -2), y = mapBytes(value, -3);
    if (x.length !== 32 || y.length !== 32) throw controlError('invalid-credentials', 'Passkey key is invalid');
    jwk = { kty: 'EC', crv: 'P-256', x: base64url(x), y: base64url(y), ext: true };
  } else if (kty === 1 && alg === -8 && mapNumber(value, -1) === 6) {
    const x = mapBytes(value, -2);
    if (x.length !== 32) throw controlError('invalid-credentials', 'Passkey key is invalid');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: base64url(x), ext: true };
  } else if (kty === 3 && alg === -257) {
    const n = mapBytes(value, -1), e = mapBytes(value, -2);
    if (n.length < 256 || e.length < 3) throw controlError('invalid-credentials', 'Passkey key is invalid');
    jwk = { kty: 'RSA', n: base64url(n), e: base64url(e), ext: true };
  } else throw controlError('invalid-credentials', 'Unsupported passkey algorithm');
  try {
    const pem = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();
    return { algorithm: alg as -257 | -8 | -7, pem };
  } catch { throw controlError('invalid-credentials', 'Passkey key is invalid'); }
}

export interface ClientData { type: 'webauthn.create' | 'webauthn.get'; challenge: string; origin: string }
export function parseClientData(encoded: unknown, expected: ClientData['type'], origin: string): { raw: Buffer; data: ClientData } {
  const raw = decodeBase64url(encoded);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw controlError('invalid-credentials', 'Passkey response is invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw controlError('invalid-credentials', 'Passkey response is invalid');
  const data = parsed as Record<string, unknown>;
  if (data.type !== expected || typeof data.challenge !== 'string' || data.origin !== origin || data.crossOrigin === true) {
    throw controlError('invalid-credentials', 'Passkey response is invalid');
  }
  return { raw, data: { type: expected, challenge: data.challenge, origin } };
}

export interface AuthenticatorData { rpHash: Buffer; flags: number; signCount: number; credentialId?: Buffer; coseKey?: Buffer }
export function parseAuthenticatorData(bytes: Buffer, registration: boolean): AuthenticatorData {
  if (bytes.length < 37) throw controlError('invalid-credentials', 'Passkey response is invalid');
  const rpHash = bytes.subarray(0, 32), flags = bytes[32]!, signCount = bytes.readUInt32BE(33);
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw controlError('invalid-credentials', 'Passkey user verification is required');
  if (!registration) return { rpHash, flags, signCount };
  if ((flags & 0x40) === 0 || bytes.length < 55) throw controlError('invalid-credentials', 'Passkey attested data is missing');
  const credentialLength = bytes.readUInt16BE(53), credentialStart = 55, keyStart = credentialStart + credentialLength;
  if (!credentialLength || keyStart >= bytes.length) throw controlError('invalid-credentials', 'Passkey attested data is invalid');
  const credentialId = Buffer.from(bytes.subarray(credentialStart, keyStart));
  const decoded = decodeCborPrefix(bytes.subarray(keyStart));
  const coseKey = Buffer.from(bytes.subarray(keyStart, keyStart + decoded.offset));
  return { rpHash, flags, signCount, credentialId, coseKey };
}
export function rpIdHash(rpId: string): Buffer { return createHash('sha256').update(rpId).digest(); }
export function equalBytes(a: Buffer, b: Buffer): boolean { return a.length === b.length && a.equals(b); }
