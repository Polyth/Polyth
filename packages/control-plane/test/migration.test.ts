import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openControlPlane, digest } from '../src/index.ts';
import { migrations } from '../src/migrations.ts';

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'polyth-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('v1 migration preserves sentinel, user IDs and original migration checksum on repeated reopen', t => {
  const dir = directory(t), id = randomUUID(), root = join(dir, 'control-plane');
  mkdirSync(root);
  writeFileSync(join(root, 'installation.json'), JSON.stringify({ version: 1, id }));
  const raw = new DatabaseSync(join(root, 'control.sqlite'));
  raw.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL) STRICT');
  raw.exec(migrations[0]!);
  raw.prepare('INSERT INTO schema_migrations VALUES(1,?,0)').run(digest(migrations[0]!));
  raw.prepare("INSERT INTO installation(singleton,id,state) VALUES(1,?,'uninitialized')").run(id);
  raw.exec("INSERT INTO principals(id,kind,status) VALUES('usr_legacy','user','active'); INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_legacy','Existing',0,0)");
  raw.close();
  for (let i = 0; i < 2; i++) {
    const c = openControlPlane({ directory: dir });
    try {
      assert.equal(c.installation().id, id);
      assert.equal(c.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version=1')?.checksum, digest(migrations[0]!));
      assert.equal(c.get<{ auth_epoch: number }>("SELECT auth_epoch FROM principals WHERE id='usr_legacy'")?.auth_epoch, 1);
      assert.equal(c.all('SELECT * FROM schema_migrations').length, migrations.length);
      assert.deepEqual(c.all('PRAGMA foreign_key_check'), []);
    } finally { c.close(); }
  }
});

for (const legacy of ['auth.json', 'tenancy.json', 'sessions', 'unknown-existing-data']) test(`existing ${legacy} is never overlaid by fresh authority`, t => {
  const dir = directory(t), file = join(dir, legacy);
  writeFileSync(file, 'existing data');
  assert.throws(() => openControlPlane({ directory: dir }), { code: 'recovery-required' });
  assert.equal(existsSync(join(dir, 'control-plane', 'installation.json')), false);
  assert.equal(readFileSync(file, 'utf8'), 'existing data');
});

test('symlinked control directory is rejected without writing its target', t => {
  const dir = directory(t), target = directory(t);
  symlinkSync(target, join(dir, 'control-plane'));
  assert.throws(() => openControlPlane({ directory: dir }), { code: 'recovery-required' });
  assert.equal(existsSync(join(target, 'installation.json')), false);
});

test('ready authority cannot lose its last ACTIVE owner or reassign an owner row', t => {
  const c = openControlPlane({ directory: directory(t) }); t.after(() => c.close());
  c.transaction(() => {
    for (const [id, status] of [['usr_owner', 'active'], ['usr_disabled', 'disabled']]) {
      c.run('INSERT INTO principals(id,kind,status) VALUES(?,?,?)', id!, 'user', status!);
      c.run('INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,0,0)', id!, id!);
      c.run("INSERT INTO instance_roles(user_id,role) VALUES(?,'owner')", id!);
    }
    c.run("UPDATE installation SET state='ready'");
  });
  for (const sql of [
    "DELETE FROM instance_roles WHERE user_id='usr_owner'",
    "UPDATE instance_roles SET role='admin' WHERE user_id='usr_owner'",
    "UPDATE principals SET status='suspended' WHERE id='usr_owner'",
  ]) assert.throws(() => c.transaction(() => c.run(sql)), /last-owner/);
  assert.throws(() => c.transaction(() => c.run("UPDATE instance_roles SET user_id='other' WHERE user_id='usr_owner'")), /immutable-identity/);
  assert.throws(() => c.transaction(() => c.run("UPDATE installation SET state='uninitialized'")), /recovery-required/);
  assert.equal(c.get<{ status: string }>("SELECT status FROM principals WHERE id='usr_owner'")?.status, 'active');
});

test('ready needs a real owner; missing live sentinel row fails closed', t => {
  const c = openControlPlane({ directory: directory(t) }); t.after(() => c.close());
  assert.throws(() => c.transaction(() => c.run("UPDATE installation SET state='ready'")), /missing-owner/);
  c.transaction(() => c.run('DELETE FROM installation'));
  assert.throws(() => c.installation(), { code: 'recovery-required' });
});

test('a service principal cannot be promoted to a user and immutable IDs cannot be renamed', t => {
  const c = openControlPlane({ directory: directory(t) }); t.after(() => c.close());
  c.transaction(() => c.run("INSERT INTO principals(id,kind,status) VALUES('svc_a','service','active')"));
  assert.throws(() => c.transaction(() => c.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('svc_a','Not a user',0,0)")), /invalid-user-principal/);
  assert.throws(() => c.transaction(() => c.run("UPDATE principals SET kind='user' WHERE id='svc_a'")), /immutable-identity/);
  assert.throws(() => c.transaction(() => c.run("UPDATE principals SET id='usr_a' WHERE id='svc_a'")), /immutable-identity/);
});
