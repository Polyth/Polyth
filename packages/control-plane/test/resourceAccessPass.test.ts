import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "../src/index.ts";
import { createResourceAccessAuthority, type ResourceAccess } from "../src/resourceAccess.ts";
import { createResourceRegistry, type ResourceLifecycle } from "../src/resources.ts";
import { createResourceSharingAuthority } from "../src/resourceSharing.ts";

// An access pass must decide every resource exactly as `access` does, errors
// included, while reading the shared facts once.
test("an access pass decides every resource exactly as access does, with constant reads", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-resource-access-pass-"));
  const control = openControlPlane({ directory: root });
  const now = 10_000;
  const resources = createResourceRegistry(control, { now: () => now });
  const limited = new Map<string, string[]>([["usr_limited", ["prj_space"]]]);
  const access = createResourceAccessAuthority(control, resources, {
    now: () => now,
    projectAllowed: (principalId, projectId) => limited.get(principalId)?.includes(projectId) ?? true,
  });
  const sharing = createResourceSharingAuthority(control, resources, { now: () => now });
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });

  const people: Array<[string, string, number | null]> = [
    ["usr_owner", "owner", null], ["usr_admin", "admin", null], ["usr_member", "member", null],
    ["usr_plain", "member", null], ["usr_viewer", "viewer", null], ["usr_limited", "member", null],
    ["usr_expired", "member", 5_000],
  ];
  control.transaction(() => {
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    for (const space of ["spc_home", "spc_work"]) {
      control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES(?,'org_home',?,?,'shared',1,1)", space, space, space);
    }
    for (const [id, role, expires] of [...people, ["usr_outside", "owner", null] as [string, string, null]]) {
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, id);
      control.run(
        "INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms,expires_at_ms) VALUES(?,?,?,'active',1,?)",
        id === "usr_outside" ? "spc_work" : "spc_home", id, role, expires,
      );
    }
    control.run("INSERT OR IGNORE INTO principals(id,kind,status) VALUES('system:polyth-runtime','system','active')");
  });

  let op = 0;
  const make = (
    resourceId: string,
    owner: string,
    visibility: "space" | "private" | "restricted" | "inherit",
    parentId?: string,
    accessParentId?: string,
    spaceId = "spc_home",
  ) => {
    const operationId = `op_${op += 1}`;
    const begun = resources.begin({
      operationId, resourceId, kind: parentId ? "session" : "project", orgId: "org_home", spaceId,
      ...(parentId ? { parentId } : {}), ...(accessParentId ? { accessParentId } : {}),
      ownerPrincipalId: owner, createdBy: owner, visibility,
    });
    resources.recordDomainReady(operationId, resourceId);
    return resources.activate(operationId, begun.resource.revision);
  };
  make("prj_space", "usr_owner", "space");
  make("prj_private", "usr_owner", "private");
  make("prj_work", "usr_outside", "space", undefined, undefined, "spc_work");
  const ids: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    const project = i % 9 === 4 ? "prj_private" : "prj_space";
    const owner = i % 4 === 1 ? "usr_member" : "usr_owner";
    const visibility = (["inherit", "private", "restricted", "space"] as const)[i % 4]!;
    const id = `ses_${i}`;
    make(id, owner, visibility, project);
    ids.push(id);
    if (i % 5 === 2) {
      make(`${id}_child`, owner, "inherit", project, id);
      ids.push(`${id}_child`);
    }
  }
  make("ses_work", "usr_outside", "space", "prj_work", undefined, "spc_work");
  ids.push("ses_work", "prj_space", "prj_private", "ses_unknown", "../escape", "");
  sharing.share({ resourceId: "ses_2", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner", visibility: "restricted", grants: [{ principalId: "usr_member", access: "collaborate" }, { principalId: "usr_viewer", access: "manage" }] });
  sharing.share({ resourceId: "ses_3", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner", visibility: "space", grants: [{ principalId: "usr_viewer", access: "manage" }] });
  sharing.share({ resourceId: "ses_6", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner", visibility: "restricted", grants: [{ principalId: "usr_plain", access: "view" }] });
  sharing.share({ resourceId: "ses_7_child", orgId: "org_home", spaceId: "spc_home", actor: "usr_owner", visibility: "inherit", grants: [{ principalId: "usr_member", access: "manage" }] });
  control.transaction(() => {
    // An expired grant counts for nobody.
    control.run("INSERT INTO resource_grants(resource_id,principal_id,access,granted_by,created_at_ms,updated_at_ms,expires_at_ms) VALUES('ses_10','usr_plain','manage','usr_owner',1,1,9000)");
    // Transitional lifecycles, and a row whose inheritance is broken.
    control.run("UPDATE resources SET lifecycle='archiving' WHERE id='ses_11'");
    control.run("UPDATE resources SET lifecycle='deleting' WHERE id='ses_12'");
    control.run("UPDATE resources SET lifecycle='provisioning' WHERE id='ses_13'");
    control.run("UPDATE resources SET lifecycle='archived' WHERE id='ses_14'");
  });

  const outcome = (decide: () => ResourceAccess | undefined): unknown => {
    try { return { ok: decide() }; } catch (cause) { return { error: (cause as { code?: unknown }).code, message: (cause as Error).message }; }
  };
  const lifecycleSets: Array<readonly ResourceLifecycle[] | undefined> = [undefined, ["active", "archived", "archiving", "deleting"], ["provisioning", "quarantined"], []];
  const principals = [...people.map(([id]) => id), "usr_outside", "system:polyth-runtime", "usr_unknown", "bad id"];
  let compared = 0;
  const seen = new Set<string>();
  for (const principalId of principals) {
    for (const spaceId of ["spc_home", "spc_work"]) {
      for (const lifecycles of lifecycleSets) {
        const scope = { principalId, orgId: "org_home", spaceId, ...(lifecycles ? { lifecycles } : {}) };
        const pass = access.accessPass(scope, ids);
        for (const resourceId of ids) {
          const decided = outcome(() => pass(resourceId)) as { ok?: ResourceAccess; error?: string };
          seen.add(decided.error ?? decided.ok?.level ?? "none");
          assert.deepEqual(
            decided,
            outcome(() => access.access({ ...scope, resourceId })),
            `${principalId} ${spaceId} ${lifecycles?.join(",") ?? "default"} ${resourceId}`,
          );
          compared += 1;
        }
      }
    }
  }
  assert.ok(compared > 4_000);
  assert.deepEqual([...seen].sort(), ["collaborate", "invalid-input", "manage", "none", "view"]);

  // A broken inheritance chain fails the pass where it fails `access`.
  make("prj_broken", "usr_owner", "inherit");
  const broken = { principalId: "usr_plain", orgId: "org_home", spaceId: "spc_home" };
  assert.deepEqual(
    outcome(() => access.accessPass(broken, ["ses_1", "prj_broken"])("prj_broken")),
    outcome(() => access.access({ ...broken, resourceId: "prj_broken" })),
  );
  assert.equal((outcome(() => access.access({ ...broken, resourceId: "prj_broken" })) as { error?: unknown }).error, "recovery-required");

  // Reads per pass do not grow with the number of resources.
  const reads = (count: number): number => {
    const original = { get: control.get, all: control.all };
    let n = 0;
    control.get = ((...args: Parameters<typeof control.get>) => { n += 1; return original.get.apply(control, args); }) as typeof control.get;
    control.all = ((...args: Parameters<typeof control.all>) => { n += 1; return original.all.apply(control, args); }) as typeof control.all;
    try {
      const pass = access.accessPass({ principalId: "usr_member", orgId: "org_home", spaceId: "spc_home" }, ids.slice(0, count));
      for (const resourceId of ids.slice(0, count)) pass(resourceId);
    } finally { Object.assign(control, original); }
    return n;
  };
  assert.equal(reads(20), reads(70));
  assert.ok(reads(70) <= 8, `reads: ${reads(70)}`);
});

test("batched resource and grant reads return exactly the per-id reads", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-resource-batch-"));
  const control = openControlPlane({ directory: root });
  const resources = createResourceRegistry(control, { now: () => 5 });
  const sharing = createResourceSharingAuthority(control, resources, { now: () => 5 });
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });
  control.transaction(() => {
    control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
    for (const id of ["usr_a", "usr_b", "usr_c"]) {
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, id);
      control.run("INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms) VALUES('spc_home',?,'member','active',1)", id);
    }
  });
  const ids: string[] = [];
  for (let i = 0; i < 1_100; i += 1) {
    const resourceId = i === 0 ? "prj_home" : `ses_${i}`;
    const begun = resources.begin({
      operationId: `op_${i}`, resourceId, kind: i === 0 ? "project" : "session", orgId: "org_home", spaceId: "spc_home",
      ...(i === 0 ? {} : { parentId: "prj_home" }), ownerPrincipalId: "usr_a", createdBy: "usr_a",
      visibility: i % 3 === 0 ? "restricted" : "inherit",
    });
    if (i % 7 !== 3) {
      resources.recordDomainReady(`op_${i}`, resourceId);
      resources.activate(`op_${i}`, begun.resource.revision);
    }
    if (i % 3 === 0 && i % 7 !== 3) {
      sharing.share({ resourceId, orgId: "org_home", spaceId: "spc_home", actor: "usr_a", visibility: "restricted", grants: [{ principalId: "usr_c", access: "view" }, { principalId: "usr_b", access: "collaborate" }] });
    }
    ids.push(resourceId);
  }
  const asked = [...ids, "ses_unknown", "../bad", "", ids[5]!];
  const rows = resources.resourcesByIds(asked);
  for (const id of asked) {
    let single;
    try { single = resources.resource(id); } catch { single = undefined; }
    assert.deepEqual(rows.get(id), single, id);
  }
  assert.equal(rows.size, ids.length);
  const grants = sharing.grantsByResource(ids);
  for (const id of ids) {
    const single = sharing.grants(id);
    assert.deepEqual(grants.get(id) ?? [], single, id);
  }
  assert.ok([...grants.values()].some((list) => list.length === 2));
});
