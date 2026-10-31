import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAuthState } from '../src/authState.ts';

const hash = `scrypt$${'a'.repeat(32)}$${'b'.repeat(64)}`;
const empty = { version: 2, passwordHash: hash, credentials: [], sessions: [] };
for (const invalid of ['{', 'null', '[]', '{}', JSON.stringify({ ...empty, credentials: null }), JSON.stringify({ ...empty, passwordHash: 'broken' }), JSON.stringify({ ...empty, version: 99 }), JSON.stringify({ ...empty, sessions: [{ id: 's' }] })]) {
  test('malformed auth state requires recovery, never anonymous mode', t => {
    const dir = mkdtempSync(join(tmpdir(), 'polyth-auth-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'auth.json'); writeFileSync(file, invalid);
    assert.throws(() => loadAuthState(file, 'usr_owner'), { code: 'recovery-required' });
    assert.equal(readFileSync(file, 'utf8'), invalid);
  });
}

test('only an absent file is a first boot; symlinks are not followed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'polyth-auth-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.json');
  assert.equal(loadAuthState(file, 'usr_owner').stored.passwordHash, null);
  writeFileSync(join(dir, 'target'), JSON.stringify(empty)); symlinkSync(join(dir, 'target'), file);
  assert.throws(() => loadAuthState(file, 'usr_owner'), { code: 'recovery-required' });
});

test('ownerless sessions are adoptable only from v1, never a corrupt v2 principal', t => {
  const dir = mkdtempSync(join(tmpdir(), 'polyth-auth-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.json');
  const sessions = [{ id: 'legacy', tokenHash: 'c'.repeat(64), createdAt: 1, lastSeenAt: 2 }];
  writeFileSync(file, JSON.stringify({ ...empty, version: 1, sessions }));
  assert.equal(loadAuthState(file, 'usr_migrated').stored.sessions[0]?.userId, 'usr_migrated');
  assert.equal(loadAuthState(file, 'usr_migrated').adoptedLegacySessions, true);
  writeFileSync(file, JSON.stringify({ ...empty, sessions }));
  assert.throws(() => loadAuthState(file, 'usr_migrated'), { code: 'recovery-required' });
});

test('duplicate credential IDs and session token hashes are rejected instead of filtered', t => {
  const dir = mkdtempSync(join(tmpdir(), 'polyth-auth-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.json');
  const cred = { userId: 'usr_a', passwordHash: hash };
  const session = { id: 'a', tokenHash: 'c'.repeat(64), userId: 'usr_a', createdAt: 1, lastSeenAt: 2 };
  for (const state of [{ ...empty, credentials: [cred, cred] }, { ...empty, sessions: [session, { ...session, id: 'b' }] }]) {
    writeFileSync(file, JSON.stringify(state));
    assert.throws(() => loadAuthState(file, 'usr_owner'), { code: 'recovery-required' });
  }
});
