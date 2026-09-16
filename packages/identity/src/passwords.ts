// Node's asynchronous scrypt API; no synchronous request-path KDF.
// OWASP scrypt baseline: N=2^17, r=8, p=1. Two jobs use ~256 MiB;
// the bounded queue cannot grow with an unbounded burst of login requests.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { controlError } from '@polyth/control-plane';

const N = 131_072, R = 8, P = 1, MAXMEM = 192 * 1024 * 1024;
const PREFIX = `scrypt$v1$${N}$${R}$${P}`;
const DUMMY = `${PREFIX}$${'0'.repeat(32)}$${'0'.repeat(64)}`;
export interface PasswordService {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string | null): Promise<{ valid: boolean; needsRehash: boolean }>;
  close(): void;
}
export function validateNewPassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || [...value].length < 12 || Buffer.byteLength(value, 'utf8') > 1024) {
    throw controlError('invalid-input', 'Use a passphrase of at least 12 characters and at most 1024 UTF-8 bytes');
  }
}

export function createPasswordService(opts: { concurrency?: number; maxQueued?: number } = {}): PasswordService {
  const concurrency = opts.concurrency ?? 2, maxQueued = opts.maxQueued ?? 32;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 128) {
    throw controlError('invalid-input', 'Invalid password worker limits');
  }
  let active = 0, closed = false;
  const queue: { start: () => void; reject: (reason: Error) => void }[] = [];
  const derive = (password: string, salt: Buffer, cost: number): Promise<Buffer> => new Promise((resolve, reject) => {
    if (closed) { reject(controlError('unavailable', 'Password service is closed')); return; }
    if (active >= concurrency && queue.length >= maxQueued) { reject(controlError('rate-limited', 'Password verification is busy')); return; }
    const done = (error: Error | null, key?: Buffer): void => {
      active--;
      if (closed) reject(controlError('unavailable', 'Password service is closed'));
      else if (error || !key) reject(controlError('unavailable', 'Password verification is unavailable'));
      else resolve(key);
      queue.shift()?.start();
    };
    const start = (): void => {
      active++;
      try { scrypt(password, salt, 32, { N: cost, r: R, p: P, maxmem: MAXMEM }, done); }
      catch { done(new Error('KDF unavailable')); }
    };
    if (active < concurrency) start(); else queue.push({ start, reject });
  });
  return {
    async hash(password) {
      // Credential policy is enforced by create/change/setup; legacy rehash
      // must still upgrade a previously accepted shorter passphrase.
      if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 1024) throw controlError('invalid-input', 'Invalid password size');
      const salt = randomBytes(16);
      const key = await derive(password, salt, N);
      return `${PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`;
    },
    async verify(password, encoded) {
      if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 1024) return { valid: false, needsRehash: false };
      const current = /^scrypt\$v1\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded ?? DUMMY);
      const legacy = current ? null : /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded ?? '');
      const format = current ?? legacy;
      // Corrupt or attacker-controlled cost parameters do not allocate memory.
      // Do the ordinary dummy work to avoid account-dependent short circuits.
      const salt = Buffer.from(format?.[1] ?? '0'.repeat(32), 'hex');
      const expected = Buffer.from(format?.[2] ?? '0'.repeat(64), 'hex');
      const key = await derive(password, salt, legacy ? 16_384 : N);
      const valid = timingSafeEqual(key, expected) && encoded !== null && !!format;
      return { valid, needsRehash: valid && !!legacy };
    },
    close() {
      closed = true;
      for (const item of queue.splice(0)) item.reject(controlError('unavailable', 'Password service is closed'));
    },
  };
}
