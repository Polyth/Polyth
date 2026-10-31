import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "@polyth/control-plane";
import type { AuthPrincipal } from "@polyth/contracts";
import { createControlTenancyStore } from "../src/controlStore.ts";
import { createIdentityResolver, createSpaceResolver } from "../src/context.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-control-tenancy-"));
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
  return { dir, control, store: createControlTenancyStore(control, { now: () => now + 1000 }) };
}

test("control tenancy exposes only explicit live memberships", (t) => {
  const { store } = fixture(t);
  assert.equal(store.spacesFor("usr_owner").length, 1);
  assert.deepEqual(store.spacesFor("usr_alice"), []);
  assert.equal(store.defaultSpaceFor("usr_alice"), undefined);
  assert.throws(() => store.requireMembership("usr_alice", "spc_personal"), { code: "not-found" });
});

test("canonical resolver never creates users or Personal Spaces on first request", (t) => {
  const { dir, store } = fixture(t);
  const resolver = createSpaceResolver({
    store,
    identities: createIdentityResolver({ ownerUserId: "usr_owner", deployment: "server-trusted", ambientOwner: false }),
    dataDir: dir,
    deployment: "server-trusted",
    provisionMissing: false,
  });
  const alice = { kind: "ui-session", sessionId: "s", rememberedDeviceId: "d", userId: "usr_alice" } as AuthPrincipal & { userId: string };
  assert.throws(() => resolver.forPrincipal(alice), { code: "not-found" });
  assert.deepEqual(store.spacesFor("usr_alice"), []);
  assert.equal(resolver.identity({ kind: "local-user", trustedLoopback: true }), null);
  assert.equal(resolver.identity({ kind: "internal-service", serviceId: "polyth-control" }), null);
});

test("space creation is explicit, audited, and keeps immutable storage identity", (t) => {
  const { control, store } = fixture(t);
  const space = store.createSpace({ name: "Work", ownerId: "usr_alice" });
  assert.match(space.id, /^spc_[a-f0-9-]{36}$/);
  assert.equal(space.slug, space.id);
  assert.equal(store.requireMembership("usr_alice", space.id).role, "owner");
  const renamed = store.renameSpace("usr_alice", space.id, { name: "Research" });
  assert.equal(renamed.name, "Research");
  assert.equal(renamed.slug, space.slug);
  assert.ok(control.get("SELECT 1 FROM audit_events WHERE action='space.created' AND resource_id=?", space.id));
  assert.ok(control.get("SELECT 1 FROM outbox o JOIN audit_events a ON a.seq=o.audit_seq WHERE a.resource_id=?", space.id));
});

test("membership grants are explicit and the last active owner is preserved", (t) => {
  const { store } = fixture(t);
  const shared = store.createSpace({ name: "Shared", ownerId: "usr_owner" });
  store.addMember("usr_owner", shared.id, "usr_alice", "member");
  assert.equal(store.roleOf("usr_alice", shared.id), "member");
  assert.throws(() => store.removeMember("usr_owner", shared.id, "usr_owner"), { code: "last-owner" });
  store.removeMember("usr_owner", shared.id, "usr_alice");
  assert.equal(store.roleOf("usr_alice", shared.id), undefined);
});

test("reference-only grants never become Space membership", (t) => {
  const { control, store } = fixture(t);
  control.transaction(() => control.run("INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms) VALUES('spc_personal','usr_alice','reference','active',1)"));
  assert.equal(store.roleOf("usr_alice", "spc_personal"), undefined);
  assert.deepEqual(store.spacesFor("usr_alice"), []);
});


test("Space admins cannot create, change, or remove owners", (t) => {
  const { store } = fixture(t);
  const shared = store.createSpace({ name: "Shared", ownerId: "usr_owner" });
  store.addMember("usr_owner", shared.id, "usr_alice", "admin");

  assert.throws(
    () => store.addMember("usr_alice", shared.id, "usr_alice", "owner"),
    { code: "forbidden" },
  );
  assert.throws(
    () => store.removeMember("usr_alice", shared.id, "usr_owner"),
    { code: "forbidden" },
  );

  store.addMember("usr_owner", shared.id, "usr_alice", "owner");
  assert.equal(store.roleOf("usr_alice", shared.id), "owner");
  store.addMember("usr_owner", shared.id, "usr_alice", "member");
  assert.equal(store.roleOf("usr_alice", shared.id), "member");
});
