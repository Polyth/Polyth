import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "@polyth/control-plane";
import { createControlTenancyStore } from "../src/controlStore.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-control-tenancy-idem-"));
  const control = openControlPlane({ directory: dir });
  t.after(() => { control.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = 1_700_000_000_000;
  control.transaction(() => {
    control.run("INSERT INTO principals(id,kind,status) VALUES('usr_owner','user','active'),('usr_alice','user','active')");
    control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_owner','Owner',?,?),('usr_alice','Alice',?,?)", now, now, now, now);
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_main','Main','org_main')");
    control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_main','usr_owner','owner'),('org_main','usr_alice','member')");
    control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_owner','owner')");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,created_at_ms,updated_at_ms) VALUES('spc_personal','org_main','Personal','spc_personal','personal',1,?,?)", now, now);
    control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_personal','usr_owner','owner',?)", now);
    control.run("UPDATE installation SET state='ready' WHERE singleton=1");
  });
  return { control, store: createControlTenancyStore(control, { now: () => now + 1000 }) as any };
}

test("duplicate create replays one authoritative mutation and rejects changed payload", (t) => {
  const { control, store } = fixture(t);
  const operationId = "11111111-1111-4111-8111-111111111111";
  const first = store.createSpace({ name: "Work", ownerId: "usr_alice" }, { operationId });
  const second = store.createSpace({ name: "Work", ownerId: "usr_alice" }, { operationId });
  assert.deepEqual(second, first);
  assert.match(first.id, /^spc_[a-f0-9]{32}$/);
  assert.equal(control.get<{n:number}>("SELECT count(*) AS n FROM spaces WHERE id=?", first.id)?.n, 1);
  assert.equal(control.get<{n:number}>("SELECT count(*) AS n FROM audit_events WHERE action='space.created' AND resource_id=?", first.id)?.n, 1);
  assert.equal(control.get<{n:number}>("SELECT count(*) AS n FROM operation_receipts WHERE actor_id='usr_alice' AND operation_id=?", operationId)?.n, 1);
  assert.throws(() => store.createSpace({ name: "Changed", ownerId: "usr_alice" }, { operationId }), { code: "conflict" });
});

test("membership retry is idempotent and same key with a different role conflicts", (t) => {
  const { control, store } = fixture(t);
  const space = store.createSpace({ name: "Shared", ownerId: "usr_owner" });
  const operationId = "22222222-2222-4222-8222-222222222222";
  const first = store.addMember("usr_owner", space.id, "usr_alice", "member", { operationId });
  const second = store.addMember("usr_owner", space.id, "usr_alice", "member", { operationId });
  assert.deepEqual(second, first);
  assert.equal(control.get<{revision:number}>("SELECT revision FROM space_memberships WHERE space_id=? AND principal_id='usr_alice'", space.id)?.revision, 1);
  assert.equal(control.get<{n:number}>("SELECT count(*) AS n FROM audit_events WHERE action='space.member-set' AND resource_id=?", `${space.id}:usr_alice`)?.n, 1);
  assert.throws(() => store.addMember("usr_owner", space.id, "usr_alice", "admin", { operationId }), { code: "conflict" });
});

test("delete replay succeeds after the resource is gone without a second audit", (t) => {
  const { control, store } = fixture(t);
  const space = store.createSpace({ name: "Disposable", ownerId: "usr_owner" });
  const operationId = "33333333-3333-4333-8333-333333333333";
  store.deleteSpace("usr_owner", space.id, { operationId });
  store.deleteSpace("usr_owner", space.id, { operationId });
  assert.equal(control.get("SELECT 1 FROM spaces WHERE id=?", space.id), undefined);
  assert.equal(control.get<{n:number}>("SELECT count(*) AS n FROM audit_events WHERE action='space.deleted' AND resource_id=?", space.id)?.n, 1);
});
