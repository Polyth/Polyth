import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, openControlPlane, type ControlPlane } from '../src/index.ts';
import { migrations } from '../src/migrations.ts';
import { createResourceRegistry } from '../src/resources.ts';

const seed = `
  INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active');
  INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',0,0);
  INSERT INTO organizations(id,name,slug) VALUES('org_a','A','a');
  INSERT INTO organizations(id,name,slug) VALUES('org_b','B','b');
  INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_a','org_a','A','spc_a','shared',0,0);
  INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_b','org_b','B','spc_b','shared',0,0);
`;
const resourceRow = (id: string, kind: string, spaceId: string, parent: string | null, lifecycle = 'active'): string =>
  `INSERT INTO resources(id,kind,org_id,space_id,parent_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
   VALUES('${id}','${kind}','${spaceId === 'spc_a' ? 'org_a' : 'org_b'}','${spaceId}',${parent ? `'${parent}'` : 'NULL'},'usr_owner','usr_owner','inherit','${lifecycle}',0,0);`;
const rows = [
  resourceRow('prj_one', 'project', 'spc_a', null),
  resourceRow('prj_two', 'project', 'spc_a', null),
  resourceRow('prj_gone', 'project', 'spc_a', null, 'deleted'),
  resourceRow('prj_foreign', 'project', 'spc_b', null),
  resourceRow('ses_one', 'session', 'spc_a', 'prj_one'),
  resourceRow('ses_kept', 'other.kind', 'spc_a', 'prj_one'),
].join('\n');

function open(t: test.TestContext): ControlPlane {
  const directory = mkdtempSync(join(tmpdir(), 'polyth-session-move-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const control = openControlPlane({ directory });
  t.after(() => control.close());
  control.transaction(() => {
    for (const statement of (seed + rows).split(';').map((sql) => sql.trim()).filter(Boolean)) control.run(statement);
  });
  return control;
}

const move = (overrides: Partial<Parameters<ReturnType<typeof createResourceRegistry>['moveSession']>[0]> = {}) => ({
  resourceId: 'ses_one', orgId: 'org_a', spaceId: 'spc_a', fromProjectId: 'prj_one', toProjectId: 'prj_two', actor: 'usr_owner', ...overrides,
});

test('a session moves to another active project of its Space, once, and access follows', (t) => {
  const control = open(t);
  const registry = createResourceRegistry(control);
  const before = registry.resource('ses_one')!;
  const moved = registry.moveSession(move());
  assert.equal(moved.parentId, 'prj_two');
  assert.equal(moved.accessRevision, before.accessRevision + 1, 'cached grants of the old project stop counting');
  assert.equal(moved.revision, before.revision + 1);
  assert.deepEqual(registry.moveSession(move()), moved, 'a finished move repeats as a no-op');
  assert.equal(
    control.all("SELECT 1 FROM audit_events WHERE action='resource.moved' AND resource_id='ses_one'").length,
    1,
    'one audit row for one move',
  );
});

test('a move refuses anything but an active project of the same Space', (t) => {
  const control = open(t);
  const registry = createResourceRegistry(control);
  assert.throws(() => registry.moveSession(move({ toProjectId: 'prj_foreign' })), { code: 'not-found' });
  assert.throws(() => registry.moveSession(move({ toProjectId: 'prj_gone' })), { code: 'not-found' });
  assert.throws(() => registry.moveSession(move({ toProjectId: 'ses_kept' })), { code: 'not-found' });
  assert.throws(() => registry.moveSession(move({ fromProjectId: 'prj_two', toProjectId: 'prj_gone' })), { code: 'conflict' });
  assert.throws(() => registry.moveSession(move({ spaceId: 'spc_b', orgId: 'org_b' })), { code: 'not-found' });
  assert.throws(() => registry.moveSession(move({ resourceId: 'ses_kept' })), { code: 'invalid-input' });
  assert.equal(registry.resource('ses_one')!.parentId, 'prj_one');
});

test('the schema itself keeps every other identity immutable', (t) => {
  const control = open(t);
  const raw = (sql: string) => control.transaction(() => control.run(sql));
  // Direct SQL can't reach what the registry refuses.
  assert.throws(() => raw("UPDATE resources SET parent_id='prj_two' WHERE id='ses_kept'"), /immutable-resource-identity/);
  assert.throws(() => raw("UPDATE resources SET parent_id='prj_two' WHERE id='prj_one'"), /immutable-resource-identity/);
  assert.throws(() => raw("UPDATE resources SET parent_id=NULL WHERE id='ses_one'"), /immutable-resource-identity|invalid-resource-parent/);
  assert.throws(() => raw("UPDATE resources SET parent_id='prj_gone' WHERE id='ses_one'"), /invalid-resource-parent/);
  assert.throws(() => raw("UPDATE resources SET parent_id='prj_foreign' WHERE id='ses_one'"));
  assert.throws(() => raw("UPDATE resources SET kind='project' WHERE id='ses_one'"), /immutable-resource-identity/);
  assert.throws(() => raw("UPDATE resources SET created_by='system:x' WHERE id='ses_one'"), /immutable-resource-identity/);
  raw("UPDATE resources SET parent_id='prj_two' WHERE id='ses_one'");
  assert.equal(createResourceRegistry(control).resource('ses_one')!.parentId, 'prj_two');
});

test('an installation from before the move upgrades in place, keeps its rows and reopens', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'polyth-session-move-old-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const root = join(directory, 'control-plane');
  mkdirSync(root);
  writeFileSync(join(root, 'installation.json'), JSON.stringify({ version: 1, id }));
  const raw = new DatabaseSync(join(root, 'control.sqlite'));
  raw.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL) STRICT');
  migrations.slice(0, -1).forEach((sql, index) => {
    raw.exec(sql);
    raw.prepare('INSERT INTO schema_migrations VALUES(?,?,0)').run(index + 1, digest(sql));
  });
  raw.prepare("INSERT INTO installation(singleton,id,state) VALUES(1,?,'uninitialized')").run(id);
  raw.exec(seed + rows);
  // The old trigger really did forbid this: the migration is what opens it.
  assert.throws(() => raw.exec("UPDATE resources SET parent_id='prj_two' WHERE id='ses_one'"), /immutable-resource-identity/);
  raw.close();
  for (let reopen = 0; reopen < 2; reopen += 1) {
    const control = openControlPlane({ directory });
    try {
      assert.equal(control.all('SELECT * FROM schema_migrations').length, migrations.length);
      assert.deepEqual(control.all('PRAGMA foreign_key_check'), []);
      const registry = createResourceRegistry(control);
      assert.equal(registry.moveSession(move()).parentId, 'prj_two');
    } finally { control.close(); }
  }
});
