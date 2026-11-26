import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Group tokens. One token per tester group (`<keysDir>/tokens.json`), so the
 *  relay can attribute a report to a group without trusting anything the
 *  client sends: the group comes from the token that authenticated the call.
 *
 *  A token is presented as `Bearer <keyId>.<secret>`. Only `sha256(secret)`
 *  is stored — never the secret — and `keyId` is public, so authentication is
 *  a map lookup plus a constant-time digest compare. The legacy single tester
 *  password (`password.scrypt`) keeps working as the `default` group. */
export interface TokenRecord {
  /** Public half of the token; never secret. */
  keyId: string;
  /** Group slug that becomes the `group:<id>` label and the stats bucket. */
  group: string;
  /** Human label, shown in the issue table and the stats header. */
  label: string;
  /** Lowercase hex sha256 of the secret half. */
  hash: string;
  /** Reports per UTC day this token may file. */
  dayCap: number;
  disabled: boolean;
}

/** What a successful authentication proves: a group, not a person. */
export interface ReportIdentity {
  keyId: string;
  group: string;
  label: string;
  dayCap: number;
}

const GROUP = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_TOKENS = 200;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DAY_CAP = 10_000;
/** 32 random bytes, base64url: 43 characters, all printable ASCII. */
const SECRET_BYTES = 32;

/** Length the wire already allows for a tester password. */
const MAX_PRESENTED = 200;

export const DEFAULT_DAY_CAP = 200;
export const DEFAULT_GROUP = "default";

/** A fresh secret half. */
export const newSecret = (): string => randomBytes(SECRET_BYTES).toString("base64url");

/** The stored form of a secret half. */
export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** `{ keyId, secret, hash }`: the one time a token is ever whole. `secret` is
 *  the full `<keyId>.<random>` string the tester pastes into the app; `hash`
 *  is what `tokens.json` keeps. */
export function mint(keyId: string): { keyId: string; secret: string; hash: string } {
  if (!KEY_ID.test(keyId)) throw new Error("key id must match [a-z0-9][a-z0-9_-]{0,47}");
  const secret = newSecret();
  return { keyId, secret: `${keyId}.${secret}`, hash: hashSecret(secret) };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Entries the file can name, in file order, dropping anything unreadable.
 *  A dropped entry means one token stops working — never a wrong tenant. */
export function parseTokens(text: string): TokenRecord[] {
  if (text.length > MAX_FILE_BYTES) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return []; }
  const list = asRecord(parsed)?.tokens;
  if (!Array.isArray(list)) return [];
  const out: TokenRecord[] = [];
  const seen = new Set<string>();
  for (const entry of list.slice(0, MAX_TOKENS)) {
    const record = asRecord(entry);
    if (!record) continue;
    const { keyId, group, label, hash } = record;
    if (typeof keyId !== "string" || !KEY_ID.test(keyId) || seen.has(keyId)) continue;
    if (typeof group !== "string" || !GROUP.test(group)) continue;
    if (label !== undefined && typeof label !== "string") continue;
    if (typeof hash !== "string" || !HASH.test(hash)) continue;
    const dayCap = record.dayCap === undefined ? DEFAULT_DAY_CAP : record.dayCap;
    if (!Number.isInteger(dayCap) || (dayCap as number) < 1 || (dayCap as number) > MAX_DAY_CAP) continue;
    seen.add(keyId);
    const text = typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : group;
    out.push({
      keyId,
      group,
      label: text,
      hash,
      dayCap: dayCap as number,
      disabled: record.disabled === true,
    });
  }
  return out;
}

export const tokenMap = (records: readonly TokenRecord[]): Map<string, TokenRecord> =>
  new Map(records.map((record) => [record.keyId, record]));

const sameHash = (presented: string, stored: string): boolean => {
  const left = Buffer.from(presented, "hex");
  const right = Buffer.from(stored, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

/** The identity a `Bearer <keyId>.<secret>` proves, or null. A disabled entry
 *  is refused exactly like an unknown one: no account enumeration. */
export function authenticate(
  tokens: ReadonlyMap<string, TokenRecord>,
  presented: string,
): ReportIdentity | null {
  if (presented.length > MAX_PRESENTED) return null;
  const dot = presented.indexOf(".");
  if (dot <= 0 || dot === presented.length - 1) return null;
  const record = tokens.get(presented.slice(0, dot));
  if (!record || record.disabled) return null;
  if (!sameHash(hashSecret(presented.slice(dot + 1)), record.hash)) return null;
  return { keyId: record.keyId, group: record.group, label: record.label, dayCap: record.dayCap };
}

/** Reads `<dir>/tokens.json`, re-read when its mtime or size changes so adding,
 *  rotating or revoking a token needs no restart. An absent or unreadable file
 *  means "no group tokens": only the legacy password still authenticates. */
export function tokenSetFromDir(dir: string): () => Map<string, TokenRecord> {
  const file = join(dir, "tokens.json");
  let stamp = "";
  let tokens = new Map<string, TokenRecord>();
  return () => {
    let next: string;
    try {
      const info = statSync(file);
      next = `${info.mtimeMs}:${info.size}`;
    } catch { next = ""; }
    if (next === stamp) return tokens;
    stamp = next;
    tokens = new Map();
    if (!next) return tokens;
    try { tokens = tokenMap(parseTokens(readFileSync(file, "utf8"))); } catch { tokens = new Map(); }
    return tokens;
  };
}
