// Legacy JSON authority remains readable until the reviewed control DB migration.
// Malformed or unreadable data is NEVER interpreted as an empty installation.
import { lstatSync, readFileSync } from 'node:fs';

export interface StoredCredential { userId: string; passwordHash: string }
export interface StoredSession {
  id: string; userId: string; tokenHash: string;
  createdAt: number; lastSeenAt: number; label: string;
}
export interface AuthFile {
  version: number; passwordHash: string | null;
  credentials: StoredCredential[]; sessions: StoredSession[];
}
const recovery = (): Error => Object.assign(new Error('Authentication state requires operator recovery'), { code: 'recovery-required' });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const userId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const passwordHash = (v: unknown): v is string => typeof v === 'string' && /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function loadAuthState(file: string, ownerUserId: string): { stored: AuthFile; adoptedLegacySessions: boolean } {
  let text: string;
  try {
    if (!lstatSync(file).isFile()) throw recovery();
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { stored: { version: 2, passwordHash: null, credentials: [], sessions: [] }, adoptedLegacySessions: false };
    }
    throw recovery();
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw recovery(); }
  if (!record(raw) || (raw.version !== undefined && raw.version !== 1 && raw.version !== 2)
    || (raw.passwordHash !== null && !passwordHash(raw.passwordHash)) || !Array.isArray(raw.sessions)
    || (raw.version === 2 && !Array.isArray(raw.credentials))
    || (raw.credentials !== undefined && !Array.isArray(raw.credentials))) throw recovery();
  const credentials: StoredCredential[] = [];
  const accounts = new Set<string>();
  for (const item of raw.credentials ?? []) {
    if (!record(item) || !userId(item.userId) || !passwordHash(item.passwordHash) || accounts.has(item.userId)) throw recovery();
    accounts.add(item.userId);
    credentials.push({ userId: item.userId, passwordHash: item.passwordHash });
  }
  const sessions: StoredSession[] = [];
  const ids = new Set<string>(), hashes = new Set<string>();
  let adoptedLegacySessions = false;
  for (const item of raw.sessions) {
    if (!record(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || typeof item.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.tokenHash) || hashes.has(item.tokenHash)
      || !timestamp(item.createdAt) || !timestamp(item.lastSeenAt) || item.lastSeenAt < item.createdAt
      || (item.label !== undefined && typeof item.label !== 'string')) throw recovery();
    const legacy = raw.version !== 2 && item.userId === undefined;
    if (!legacy && !userId(item.userId)) throw recovery();
    adoptedLegacySessions ||= legacy;
    ids.add(item.id); hashes.add(item.tokenHash);
    sessions.push({
      id: item.id, tokenHash: item.tokenHash, userId: legacy ? ownerUserId : item.userId as string,
      createdAt: item.createdAt, lastSeenAt: item.lastSeenAt, label: (item.label as string | undefined) ?? '',
    });
  }
  return { stored: { version: 2, passwordHash: raw.passwordHash, credentials, sessions }, adoptedLegacySessions };
}
