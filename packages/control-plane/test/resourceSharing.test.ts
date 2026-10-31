import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "../src/index.ts";
import { createResourceAccessAuthority } from "../src/resourceAccess.ts";
import { createResourceSharingAuthority } from "../src/resourceSharing.ts";
import { createResourceRegistry, type ResourceVisibility } from "../src/resources.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-resource-sharing-"));
  const control = openControlPlane({ directory: root });
  let now = 1_000;
  const resources = createResourceRegistry(control, { now: () => now });
  const access = createResourceAccessAuthority(control, resources, { now: () => now });
  const sharing = createResourceSharingAuthority(control, resources, { now: () => now });
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });

  control.transaction(() => {
    for (const id of ["usr_owner", "usr_admin", "usr_member", "usr_other", "usr_viewer", "usr_outside"]) {
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, id);
    }
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    for (const space of ["spc_home", "spc_work"]) {
      control.run(
        "INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES(?,'org_home',?,?,'shared',1,1)",
        space, space, space,
      );
    }
    const member = (space: string, principal: string, role: string) => control.run(
      "INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms) VALUES(?,?,?,'active',1)",
      space, principal, role,
    );
    member("spc_home", "usr_owner", "member");
    member("spc_home", "usr_admin", "admin");
    member("spc_home", "usr_member", "member");
    member("spc_home", "usr_other", "member");
    member("spc_home", "usr_viewer", "viewer");
    member("spc_work", "usr_outside", "owner");
  });

  let counter = 0;
  const make = (input: {
    id: string;
    kind?: string;
    visibility: ResourceVisibility;
    parentId?: string;
    accessParentId?: string;
    owner?: string;
    spaceId?: string;
  }) => {
    const operationId = `op_${++counter}`;
    const begun = resources.begin({
      operationId,
      resourceId: input.id,
      kind: input.kind ?? "session",
      orgId: "org_home",
      spaceId: input.spaceId ?? "spc_home",
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.accessParentId ? { accessParentId: input.accessParentId } : {}),
      ownerPrincipalId: input.owner ?? "usr_owner",
      createdBy: input.owner ?? "usr_owner",
      visibility: input.visibility,
    });
    resources.recordDomainReady(operationId, input.id);
    return resources.activate(operationId, begun.resource.revision);
  };
  make({ id: "prj_home", kind: "project", visibility: "space" });
  const level = (resourceId: string, principalId: string, spaceId = "spc_home") =>
    access.access({ resourceId, principalId, orgId: "org_home", spaceId })?.level;
  return { control, resources, access, sharing, make, level, tick: (ms: number) => { now += ms; } };
}

test("access levels follow ownership, audience, grants and Space role", t => {
  const f = fixture(t);
  f.make({ id: "ses_private", visibility: "private", parentId: "prj_home" });
  f.make({ id: "ses_restricted", visibility: "restricted", parentId: "prj_home" });
  f.make({ id: "ses_space", visibility: "space", parentId: "prj_home" });
  f.make({ id: "ses_legacy", visibility: "inherit", parentId: "prj_home" });

  for (const id of ["ses_private", "ses_restricted", "ses_space", "ses_legacy"]) {
    assert.equal(f.level(id, "usr_owner"), "manage", `${id}: the owner manages`);
  }
  assert.equal(f.level("ses_private", "usr_admin"), undefined, "Space admins do not see private chats");
  assert.equal(f.level("ses_private", "usr_member"), undefined);
  assert.equal(f.level("ses_restricted", "usr_member"), undefined, "restricted admits only granted people");

  // Space-wide: admins manage, members collaborate, viewers view.
  for (const id of ["ses_space", "ses_legacy"]) {
    assert.equal(f.level(id, "usr_admin"), "manage");
    assert.equal(f.level(id, "usr_member"), "collaborate");
    assert.equal(f.level(id, "usr_viewer"), "view");
  }
  // Another Space's member never reads, whatever the audience.
  assert.equal(f.level("ses_space", "usr_outside"), undefined);
  assert.equal(f.level("ses_space", "usr_outside", "spc_work"), undefined);

  f.sharing.share({
    resourceId: "ses_restricted", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner",
    grants: [{ principalId: "usr_member", access: "view" }, { principalId: "usr_viewer", access: "manage" }],
  });
  assert.equal(f.level("ses_restricted", "usr_member"), "view");
  assert.equal(f.level("ses_restricted", "usr_viewer"), "view", "a viewer membership caps any grant at view");
  assert.equal(f.level("ses_restricted", "usr_other"), undefined);

  // A grant raises one person above the Space-wide level.
  f.sharing.share({
    resourceId: "ses_space", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner",
    grants: [{ principalId: "usr_member", access: "manage" }],
  });
  assert.equal(f.level("ses_space", "usr_member"), "manage");
  assert.equal(f.level("ses_space", "usr_other"), "collaborate");

  // Ownership and grants never outlive membership.
  f.control.transaction(() => f.control.run(
    "UPDATE space_memberships SET state='revoked' WHERE space_id='spc_home' AND principal_id IN ('usr_owner','usr_member')",
  ));
  assert.equal(f.level("ses_private", "usr_owner"), undefined);
  assert.equal(f.level("ses_space", "usr_member"), undefined);
});

test("a delegated child follows its parent chat, not its project", t => {
  const f = fixture(t);
  f.make({ id: "ses_parent", visibility: "private", parentId: "prj_home" });
  f.make({ id: "ses_child", visibility: "inherit", parentId: "prj_home", accessParentId: "ses_parent", owner: "usr_admin" });
  f.make({ id: "ses_grandchild", visibility: "inherit", parentId: "prj_home", accessParentId: "ses_child", owner: "usr_admin" });

  assert.equal(f.level("ses_child", "usr_owner"), "manage", "the parent's owner manages its subagents");
  assert.equal(f.level("ses_grandchild", "usr_owner"), "manage");
  assert.equal(f.level("ses_child", "usr_member"), undefined, "a private parent hides its subagents");
  assert.equal(f.level("ses_child", "usr_admin"), "manage", "whoever spawned the child owns it");

  f.sharing.share({
    resourceId: "ses_parent", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner",
    visibility: "restricted", grants: [{ principalId: "usr_member", access: "collaborate" }],
  });
  assert.equal(f.level("ses_child", "usr_member"), "collaborate");
  assert.equal(f.level("ses_grandchild", "usr_member"), "collaborate");

  f.sharing.share({ resourceId: "ses_parent", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner", visibility: "private" });
  assert.equal(f.level("ses_grandchild", "usr_member"), undefined, "narrowing the parent closes every subagent");
  assert.deepEqual(f.sharing.grants("ses_parent"), [], "making a chat private removes its people");
  assert.deepEqual(f.sharing.accessChildren("ses_parent"), ["ses_child"]);
});

test("share keeps the people list consistent and refuses invalid people", t => {
  const f = fixture(t);
  const row = f.make({ id: "ses_one", visibility: "restricted", parentId: "prj_home" });
  const share = (grants: Array<{ principalId: string; access: "view" | "collaborate" | "manage" }>, extra = {}) =>
    f.sharing.share({ resourceId: "ses_one", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner", grants, ...extra });

  assert.throws(() => share([{ principalId: "usr_owner", access: "view" }]), { code: "invalid-input" });
  assert.throws(() => share([{ principalId: "usr_outside", access: "view" }]), { code: "invalid-input" });
  assert.throws(() => share([{ principalId: "usr_nobody", access: "view" }]), { code: "invalid-input" });
  assert.throws(() => share([
    { principalId: "usr_member", access: "view" },
    { principalId: "usr_member", access: "manage" },
  ]), { code: "invalid-input" });
  assert.throws(() => share([{ principalId: "usr_member", access: "owner" as never }]), { code: "invalid-input" });
  assert.throws(() => f.sharing.share({
    resourceId: "ses_one", orgId: "org_home", spaceId: "spc_work", actor: "usr_owner", grants: [],
  }), { code: "not-found" }, "a resource is only shared inside its own Space");

  const first = share([{ principalId: "usr_member", access: "view" }, { principalId: "usr_other", access: "collaborate" }]);
  assert.equal(first.resource.accessRevision, row.accessRevision + 1);
  assert.deepEqual(first.grants.map((grant) => [grant.principalId, grant.access]), [
    ["usr_member", "view"], ["usr_other", "collaborate"],
  ]);
  // An unchanged list is a no-op; a stale revision is a conflict.
  const same = share([{ principalId: "usr_member", access: "view" }, { principalId: "usr_other", access: "collaborate" }]);
  assert.equal(same.resource.accessRevision, first.resource.accessRevision);
  assert.throws(() => share([], { expectedAccessRevision: row.accessRevision }), { code: "conflict" });

  const second = share([{ principalId: "usr_other", access: "manage" }], { expectedAccessRevision: first.resource.accessRevision });
  assert.deepEqual(second.grants.map((grant) => [grant.principalId, grant.access]), [["usr_other", "manage"]]);
  assert.equal(f.level("ses_one", "usr_member"), undefined);
  assert.equal(f.level("ses_one", "usr_other"), "manage");
  const audit = f.control.all<{ action: string }>("SELECT action FROM audit_events WHERE resource_id='ses_one' AND action='resource.shared'");
  assert.equal(audit.length, 2);
});

test("narrowing a chat server work owns makes the person narrowing it its owner", t => {
  const f = fixture(t);
  f.make({ id: "ses_bot", visibility: "inherit", parentId: "prj_home", owner: "system:polyth-runtime" });
  f.make({ id: "ses_bot2", visibility: "inherit", parentId: "prj_home", owner: "system:polyth-runtime" });
  const share = (resourceId: string, input: object) =>
    f.sharing.share({ resourceId, orgId: "org_home", spaceId: "spc_home", actor: "usr_admin", ...input });

  const narrowed = share("ses_bot", { visibility: "private" });
  assert.equal(narrowed.resource.ownerPrincipalId, "usr_admin");
  assert.equal(f.level("ses_bot", "usr_admin"), "manage", "the chat stays on its sharer's screen");
  assert.equal(f.level("ses_bot", "usr_member"), undefined);

  // Restricting with the sharer in the list keeps the list valid.
  const restricted = share("ses_bot2", {
    visibility: "restricted",
    grants: [{ principalId: "usr_admin", access: "manage" }, { principalId: "usr_member", access: "view" }],
  });
  assert.equal(restricted.resource.ownerPrincipalId, "usr_admin");
  assert.deepEqual(restricted.grants.map((grant) => grant.principalId), ["usr_member"]);
  const adopted = f.control.all("SELECT 1 FROM audit_events WHERE action='resource.owner-adopted'");
  assert.equal(adopted.length, 2);
});

test("startup reclaims private chats a system principal was left owning", t => {
  const f = fixture(t);
  f.make({ id: "ses_lost", visibility: "inherit", parentId: "prj_home", owner: "system:polyth-runtime" });
  f.make({ id: "ses_noone", visibility: "private", parentId: "prj_home", owner: "system:polyth-runtime" });
  // What `share` stored before it adopted: private, still owned by the runtime.
  f.control.transaction(() => {
    f.control.run("UPDATE resources SET visibility='private' WHERE id='ses_lost'");
    f.control.audit("usr_member", "resource.shared", "ses_lost");
  });
  assert.equal(f.level("ses_lost", "usr_member"), undefined);

  assert.deepEqual(f.sharing.reclaimUnreachable(), ["ses_lost"]);
  assert.equal(f.resources.resource("ses_lost")?.ownerPrincipalId, "usr_member");
  assert.equal(f.level("ses_lost", "usr_member"), "manage");
  assert.equal(f.resources.resource("ses_noone")?.ownerPrincipalId, "system:polyth-runtime", "no sharer, no guess");
  assert.deepEqual(f.sharing.reclaimUnreachable(), [], "idempotent");
});

test("an access parent is set once, in scope, and never loops", t => {
  const f = fixture(t);
  f.make({ id: "ses_a", visibility: "inherit", parentId: "prj_home" });
  f.make({ id: "ses_b", visibility: "inherit", parentId: "prj_home" });
  f.make({ id: "ses_private", visibility: "private", parentId: "prj_home" });
  f.make({ id: "prj_work", kind: "project", visibility: "space", spaceId: "spc_work", owner: "usr_outside" });
  f.make({ id: "ses_work", visibility: "inherit", parentId: "prj_work", spaceId: "spc_work", owner: "usr_outside" });

  const adopted = f.sharing.adoptAccessParent("ses_b", "ses_a");
  assert.equal(adopted.accessParentId, "ses_a");
  assert.equal(f.sharing.adoptAccessParent("ses_b", "ses_a").revision, adopted.revision, "repeating it is a no-op");
  assert.throws(() => f.sharing.adoptAccessParent("ses_b", "ses_private"), { code: "conflict" });
  assert.throws(() => f.sharing.adoptAccessParent("ses_a", "ses_b"), { code: "invalid-input" }, "a cycle is refused");
  assert.throws(() => f.sharing.adoptAccessParent("ses_private", "ses_a"), { code: "invalid-input" }, "only inheriting rows follow");
  assert.throws(() => f.sharing.adoptAccessParent("ses_a", "ses_work"), { code: "not-found" }, "never across Spaces");
  assert.throws(
    () => f.control.transaction(() => f.control.run("UPDATE resources SET access_parent_id=NULL WHERE id='ses_b'")),
    /immutable-resource-access-parent/,
  );
  assert.throws(() => f.make({ id: "ses_c", visibility: "private", parentId: "prj_home", accessParentId: "ses_a" }), { code: "invalid-input" });
  assert.throws(() => f.make({ id: "ses_d", visibility: "inherit", parentId: "prj_home", accessParentId: "ses_work" }), { code: "not-found" });
});

test("the Space policy has safe defaults and validates changes", t => {
  const f = fixture(t);
  assert.deepEqual(f.sharing.policy("spc_home"), {
    defaultVisibility: "private", allowSpaceVisibility: true, membersMayShare: true, maxMemberAccess: "manage", revision: 0,
  });
  const saved = f.sharing.setPolicy({
    spaceId: "spc_home", actor: "usr_admin", expectedRevision: 0,
    patch: { defaultVisibility: "space", maxMemberAccess: "view" },
  });
  assert.deepEqual(saved, {
    defaultVisibility: "space", allowSpaceVisibility: true, membersMayShare: true, maxMemberAccess: "view", revision: 1,
  });
  assert.throws(() => f.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_admin", expectedRevision: 0, patch: {} }), { code: "conflict" });
  assert.throws(
    () => f.sharing.setPolicy({ spaceId: "spc_home", actor: "usr_admin", patch: { allowSpaceVisibility: false } }),
    { code: "invalid-input" },
    "a Space-wide default needs Space-wide sharing",
  );
  const narrowed = f.sharing.setPolicy({
    spaceId: "spc_home", actor: "usr_admin", patch: { allowSpaceVisibility: false, defaultVisibility: "private" },
  });
  assert.equal(narrowed.revision, 2);
  assert.equal(f.sharing.policy("spc_work").revision, 0, "policies are per Space");
  assert.throws(() => f.sharing.setPolicy({ spaceId: "spc_missing", actor: "usr_admin", patch: {} }), { code: "not-found" });
});
