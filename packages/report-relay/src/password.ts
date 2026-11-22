import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isTesterPassword } from "@polyth/contracts/bug-report";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Tester-password hashing. The relay never holds the password, only this
 *  one-line scrypt record; the client sends the password in the
 *  `Authorization` header and it is compared in constant time. */
export interface ScryptRecord {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const PREFIX = "scrypt";
const DEFAULTS = { N: 16_384, r: 8, p: 1 } as const;
const HASH_BYTES = 32;
const SALT_BYTES = 16;
const MAX_PASSWORD = 200;
const MAX_LINE = 512;
const MAX_MEMORY = 64 * 1024 * 1024;

const base64 = (value: Buffer): string => value.toString("base64");

/** `scrypt$N$r$p$<salt base64>$<hash base64>` for a password read from stdin.
 *  N=16384, r=8, p=1, 32-byte hash, 16-byte random salt. */
export function hashPassword(password: string): string {
  if (!isTesterPassword(password)) {
    throw new Error(`password must be 1-${MAX_PASSWORD} printable ASCII characters without spaces`);
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, HASH_BYTES, { ...DEFAULTS, maxmem: MAX_MEMORY });
  return `${PREFIX}$${DEFAULTS.N}$${DEFAULTS.r}$${DEFAULTS.p}$${base64(salt)}$${base64(hash)}`;
}

const B64 = /^[A-Za-z0-9+/]{2,}={0,2}$/;

const numberPart = (value: string | undefined): number =>
  value !== undefined && /^\d{1,7}$/.test(value) ? Number(value) : Number.NaN;

/** A parsed record, or null when the line is not one this relay wrote. */
export function parsePasswordLine(line: string): ScryptRecord | null {
  const text = line.trim();
  if (!text || text.length > MAX_LINE) return null;
  const parts = text.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const N = numberPart(parts[1]);
  const r = numberPart(parts[2]);
  const p = numberPart(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 1_024 || N > 1_048_576 || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > 32 || p < 1 || p > 16) return null;
  const saltText = parts[4]!;
  const hashText = parts[5]!;
  if (!B64.test(saltText) || !B64.test(hashText)) return null;
  const salt = Buffer.from(saltText, "base64");
  const hash = Buffer.from(hashText, "base64");
  if (salt.length < 8 || salt.length > 64 || hash.length !== HASH_BYTES) return null;
  return { N, r, p, salt, hash };
}

/** Constant-time comparison of a presented password against the record. */
export function verifyPassword(record: ScryptRecord, password: string): boolean {
  if (!password || password.length > MAX_PASSWORD) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(password, record.salt, record.hash.length, { N: record.N, r: record.r, p: record.p, maxmem: MAX_MEMORY });
  } catch {
    return false;
  }
  return derived.length === record.hash.length && timingSafeEqual(derived, record.hash);
}

/** Reads `<dir>/password.scrypt`, re-read when its mtime changes so rotating
 *  the password needs no restart. Absent or unusable files mean "no password
 *  configured", which the relay answers as unavailable rather than accepting. */
export function passwordFromDir(dir: string): () => ScryptRecord | null {
  const file = join(dir, "password.scrypt");
  let stamp = "";
  let record: ScryptRecord | null = null;
  return () => {
    let next: string;
    try { next = `${statSync(file).mtimeMs}`; } catch { next = ""; }
    if (next === stamp) return record;
    stamp = next;
    record = null;
    if (!next) return null;
    try { record = parsePasswordLine(readFileSync(file, "utf8")); } catch { record = null; }
    return record;
  };
}
