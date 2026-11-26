import { randomBytes, randomUUID } from 'node:crypto';
import { controlError, digest } from '@polyth/control-plane';

export const opaqueId = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const newToken = (): string => randomBytes(32).toString('hex');
export const tokenHash = (purpose: 'session' | 'setup' | 'browser' | 'recovery' | 'access' | 'device' | 'invitation', token: string): string => digest(`${purpose}:${token}`);
export const validToken = (token: unknown): token is string => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
export function displayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
    throw controlError('invalid-input', 'Name must contain 1–80 printable characters');
  }
  return value.trim();
}
export function loginName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128) throw controlError('invalid-input', 'Invalid login name');
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw controlError('invalid-input', 'Login name must contain 1–64 letters, numbers, dots, underscores or hyphens');
  return name;
}
/**
 * A recovery code as a person may enter it: setup shows the 40 hex digits in
 * groups of four, so people type spaces between groups, and macOS or a notes
 * app turns hyphens into en/em dashes and spaces into no-break spaces.
 * Separators carry no entropy, so any whitespace, dash punctuation or
 * invisible format character is dropped (after NFKC, which folds full-width
 * digits) before the strict hex check.
 */
export function recoveryCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160) return null;
  const code = value.normalize('NFKC').replace(/[\s\p{Pd}\p{Cf}−]/gu, '').toLowerCase();
  return /^[a-f0-9]{40}$/.test(code) ? code : null;
}
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(20).toString('hex'));
}
export const invalidCredentials = (): Error => controlError('invalid-credentials', 'Incorrect account or credentials');
