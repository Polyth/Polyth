import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openControlPlane, type ControlPlane } from '../src/index.ts';
import { createResourceRegistry } from '../src/resources.ts';

function open(t: test.TestContext): ControlPlane {
  const directory = mkdtempSync(join(tmpdir(), 'polyth-domain-resource-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const control = openControlPlane({ directory });
  t.after(() => control.close());
  control.transaction(() => {
    for (const [id, name] of [['usr_owner', 'Owner'], ['usr_creator', 'Creator'], ['usr_other', 'Other']] as const) {
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      control.run('INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,0,0)', id, name);
    }
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_a','A','a')");
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_b','B','b')");
    control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_a','usr_owner','owner')");
    control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_a','usr_creator','member')");
    control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_b','usr_other','owner')");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_a','org_a','A','spc_a','shared',0,0)");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_b','org_b','B','spc_b','shared',0,0)");
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_a','usr_owner','owner',0)");
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_a','usr_creator','member',0)");
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_b','usr_other','owner',0)");
  });
  return control;
}

const begin = (operationId = 'op:one', resourceId = 'res_one') => ({
  operationId, resourceId, kind: 'project', orgId: 'org_a', spaceId: 'spc_a',
  ownerPrincipalId: 'usr_owner', createdBy: 'usr_creator', visibility: 'restricted' as const,
});

test('domain migration adds bounded membership expiry and metadata-only key records', t => {
  const control = open(t);
  assert.throws(() => control.transaction(() => control.run(
    "UPDATE space_memberships SET expires_at_ms=100 WHERE space_id='spc_a' AND principal_id='usr_owner'",
  )), /owner-membership-expiry/);
  control.transaction(() => control.run(
    "UPDATE space_memberships SET expires_at_ms=100 WHERE space_id='spc_a' AND principal_id='usr_creator'",
  ));
  assert.throws(() => control.transaction(() => control.run(
    "UPDATE space_memberships SET expires_at_ms=0 WHERE space_id='spc_a' AND principal_id='usr_creator'",
  )), /CHECK constraint failed/);
  control.transaction(() => {
    control.run("INSERT INTO key_providers(id,kind,state,created_at_ms,updated_at_ms) VALUES('keychain','os-keychain','active',0,0)");
    control.run("INSERT INTO key_versions(provider_id,version,state,created_at_ms) VALUES('keychain','v1','active',0)");
  });
  assert.throws(() => control.transaction(() => control.run(
    "INSERT INTO key_versions(provider_id,version,state,created_at_ms) VALUES('keychain','v2','active',1)",
  )), /UNIQUE constraint failed/);
  const columns = control.all<{ name: string }>('PRAGMA table_info(key_versions)');
  assert.equal(columns.some(row => /secret|ciphertext|wrapped|material/i.test(row.name)), false);
});

test('resource provisioning stays unreadable until exact durable completion and replays once', t => {
  const control = open(t);
  let clock = 10;
  const registry = createResourceRegistry(control, { now: () => ++clock });
  const first = registry.begin(begin());
  assert.equal(first.replayed, false);
  assert.equal(first.resource.lifecycle, 'provisioning');
  assert.equal(registry.active('res_one', { orgId: 'org_a', spaceId: 'spc_a' }), undefined);
  assert.deepEqual(registry.begin(begin()), { ...first, replayed: true });
  assert.throws(() => registry.begin({ ...begin(), visibility: 'private' }), { code: 'conflict' });
  assert.throws(() => registry.activate('op:one', 1), { code: 'conflict' });
  assert.equal(registry.recordDomainReady('op:one', 'durable-domain-row:res_one').state, 'domain-ready');
  const active = registry.activate('op:one', 1);
  assert.equal(active.lifecycle, 'active');
  assert.equal(active.revision, 2);
  assert.equal(active.accessRevision, 2);
  assert.equal(registry.active('res_one', { orgId: 'org_a', spaceId: 'spc_a' })?.id, 'res_one');
  assert.equal(registry.active('res_one', { orgId: 'org_b', spaceId: 'spc_b' }), undefined);
  assert.equal(registry.activate('op:one', 1).revision, 2);
  assert.equal(control.get<{ n: number }>(
    "SELECT count(*) AS n FROM audit_events WHERE action='resource.activated'",
  )?.n, 1);
});

test('CAS conflicts rollback, missing domain aborts, and unknown outcomes quarantine', t => {
  const control = open(t);
  const registry = createResourceRegistry(control, { now: () => 50 });
  registry.begin(begin());
  registry.recordDomainReady('op:one', 'receipt');
  assert.throws(() => registry.activate('op:one', 99), { code: 'conflict' });
  assert.equal(registry.resource('res_one')?.lifecycle, 'provisioning');
  assert.equal(registry.provisioning('op:one')?.state, 'domain-ready');

  registry.begin(begin('op:missing', 'res_missing'));
  assert.equal(registry.abortMissingDomain('op:missing', 1).lifecycle, 'deleted');
  assert.equal(registry.abortMissingDomain('op:missing', 1).lifecycle, 'deleted');
  assert.equal(registry.begin(begin('op:missing', 'res_missing')).provisioning.state, 'aborted');

  registry.begin(begin('op:unknown', 'res_unknown'));
  assert.equal(registry.quarantineUnknown('op:unknown', 1).lifecycle, 'quarantined');
  assert.equal(registry.active('res_unknown', { orgId: 'org_a', spaceId: 'spc_a' }), undefined);
  assert.equal(registry.recordDomainReady('op:unknown', 'later-observed-durable').state, 'domain-ready');
  assert.equal(registry.activate('op:unknown', 2).lifecycle, 'active');
});

test('foreign scope and inactive parent references fail closed at API and FK boundaries', t => {
  const control = open(t);
  const registry = createResourceRegistry(control, { now: () => 10 });
  assert.throws(() => registry.begin({ ...begin(), orgId: 'org_b' }), { code: 'not-found' });
  registry.begin(begin('op:parent', 'res_parent'));
  assert.throws(() => registry.begin({ ...begin('op:child', 'res_child'), parentId: 'res_parent' }), { code: 'not-found' });
  registry.recordDomainReady('op:parent', 'receipt');
  registry.activate('op:parent', 1);
  assert.equal(registry.begin({ ...begin('op:child', 'res_child'), parentId: 'res_parent' }).resource.parentId, 'res_parent');
  assert.throws(() => control.transaction(() => control.run(
    `INSERT INTO resources(id,kind,org_id,space_id,parent_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
     VALUES('res_bad','project','org_b','spc_b','res_parent','usr_other','usr_other','restricted','active',0,0)`,
  )), /FOREIGN KEY constraint failed/);
  assert.throws(() => control.transaction(() => control.run(
    "INSERT INTO policies(id,org_id,space_id,resource_id,scope_kind,scope_id,name,created_at_ms,updated_at_ms) VALUES('pol_bad','org_b','spc_a',NULL,'space','spc_a','bad',0,0)",
  )), /FOREIGN KEY constraint failed/);
});

test('resource list shape is served by the scoped lifecycle index', t => {
  const control = open(t);
  const plan = control.all<{ detail: string }>(
    "EXPLAIN QUERY PLAN SELECT id FROM resources WHERE space_id=? AND kind=? AND lifecycle='active' ORDER BY id",
    'spc_a', 'project',
  );
  assert.ok(plan.some(row => row.detail.includes('idx_resources_scope')), plan.map(row => row.detail).join('\n'));
});
