import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { createProjectService } from "../src/projects.ts";
import { canonicalProjectService } from "../src/projectResourceAuthority.ts";
import { limitedProjectsForActor } from "../src/accountLimits.ts";

function fixture(t: test.TestContext, opts: { canonical?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "polyth-personal-project-"));
  const storageDir = join(root, "spaces", "home");
  let dispose = () => {};
  let security: ReturnType<typeof createCanonicalSecurity> | undefined;
  if (opts.canonical !== false) {
    const created = createCanonicalSecurity({ dataDir: root, origin: "http://127.0.0.1:4400", localOnly: true, now: () => 1_000 });
    security = created;
    created.control.transaction(() => {
      for (const [id, name] of [["usr_owner", "Owner"], ["usr_member", "Member"], ["usr_viewer", "Viewer"]] as const) {
        created.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
        created.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
      }
      created.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
      created.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_owner','owner')");
      created.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_member','member')");
      created.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_viewer','guest')");
      created.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
      created.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_owner','owner',1)");
      created.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_member','member',1)");
      created.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_viewer','viewer',1)");
    });
    const binding = bindCanonicalSecurity(created);
    dispose = () => { binding.dispose(); created.close(); };
  }
  // After the security bootstrap: it refuses to initialize over existing state.
  mkdirSync(storageDir, { recursive: true });
  const registry = createProjectService(root);
  const ctx = (userId: string, role: SpaceContext["role"] = "member"): SpaceContext => ({
    spaceId: "spc_home",
    spaceSlug: "home",
    userId,
    role,
    deployment: "local-trusted",
    storageDir,
  });
  t.after(() => {
    dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, storageDir, security, registry, ctx };
}

test("a person's first-run personal project is a private folder inside Space storage", async t => {
  const f = fixture(t);
  const service = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const project = await service.ensurePersonal!("Особисте");

  assert.equal(project.personal, true);
  assert.equal(project.name, "Особисте");
  assert.equal(project.spaceId, "spc_home");
  assert.ok(existsSync(project.path), "the folder is created");
  assert.ok(project.path.startsWith(realpathSync(f.storageDir) + sep + "personal" + sep), project.path);
  assert.ok(!project.path.includes("usr_owner"), "no principal id text in the path");
  assert.equal(existsSync(join(project.path, ".git")), false, "not a Git repository");
  assert.equal("personalOwner" in project, false, "the owner stays server-side");
  assert.equal(project.icon, "/assets/project-icons/user.svg");

  const resource = f.security!.resources.resource(project.id);
  assert.equal(resource?.visibility, "private");
  assert.equal(resource?.ownerPrincipalId, "usr_owner");
  assert.equal(resource?.lifecycle, "active");

  // Idempotent: the same row, even across a fresh scoped view.
  const again = await canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry).ensurePersonal!();
  assert.equal(again.id, project.id);
  assert.deepEqual((await service.list()).map((row) => row.id), [project.id]);
});

test("only its owner can see a personal project; every member gets their own", async t => {
  const f = fixture(t);
  const owner = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const member = canonicalProjectService(f.ctx("usr_member"), f.registry);
  const mine = await owner.ensurePersonal!();

  // Someone else's personal project is not a project the member can see, so
  // it neither shows up nor blocks the member's own first run.
  assert.deepEqual(await member.list(), []);
  assert.equal(await member.get(mine.id).catch((error: { code?: string }) => error.code), "not-found");
  const theirs = await member.ensurePersonal!();
  assert.notEqual(theirs.id, mine.id);
  assert.notEqual(theirs.path, mine.path);
  assert.deepEqual((await member.list()).map((row) => row.id), [theirs.id]);
  assert.deepEqual((await owner.list()).map((row) => row.id), [mine.id]);
});

test("a personal project is a first-run start, refused once another project is visible", async t => {
  const f = fixture(t);
  const service = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const work = join(f.root, "work");
  mkdirSync(work, { recursive: true });
  await service.add(work, "Work");
  await assert.rejects(service.ensurePersonal!(), (error: { code?: string }) => error.code === "conflict");
  assert.equal(f.registry.personalProject("spc_home", "usr_owner"), undefined);
});

test("viewers, system principals and project-limited accounts get no personal project", async t => {
  const f = fixture(t);
  await assert.rejects(
    canonicalProjectService(f.ctx("usr_viewer", "viewer"), f.registry).ensurePersonal!(),
    (error: { code?: string }) => error.code === "forbidden",
  );
  await assert.rejects(
    canonicalProjectService(f.ctx("system:polyth-runtime", "owner"), f.registry).ensurePersonal!(),
    (error: { code?: string }) => error.code === "forbidden",
  );
  const limited = limitedProjectsForActor(
    f.ctx("usr_member"),
    canonicalProjectService(f.ctx("usr_member"), f.registry),
    () => ({ projects: ["some-other-project"], harnesses: null, messagesPerDay: null, chatsPerDay: null }),
  );
  await assert.rejects(limited.ensurePersonal!(), (error: { code?: string }) => error.code === "forbidden");
  assert.equal(f.registry.personalProject("spc_home", "usr_member"), undefined);
});

test("nobody can register a personal folder as an ordinary project", async t => {
  const f = fixture(t);
  const owner = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const mine = await owner.ensurePersonal!();
  const member = canonicalProjectService(f.ctx("usr_member"), f.registry);
  const refused = (error: { code?: string; message?: string }) =>
    error.code === "invalid-path" && error.message === "this folder is reserved for a personal project";
  // Existing and not-yet-created personal folders answer the same way.
  await assert.rejects(member.add(mine.path, "Squat"), refused);
  await assert.rejects(member.add(join(f.storageDir, "personal", "0".repeat(32)), "Probe"), refused);
  await assert.rejects(owner.add(join(mine.path, "inner"), "Inner"), refused);
  assert.deepEqual((await member.list()).map((row) => row.id), []);
});

test("a blank or oversized name falls back to the default", async t => {
  const f = fixture(t);
  const project = await canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry).ensurePersonal!("   ");
  assert.equal(project.name, "Personal");
});

test("without the resource authority, other people's personal projects still don't block a first run", async t => {
  const f = fixture(t, { canonical: false });
  const owner = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const member = canonicalProjectService(f.ctx("usr_member"), f.registry);
  const mine = await owner.ensurePersonal!();
  const theirs = await member.ensurePersonal!();
  assert.notEqual(mine.id, theirs.id);
  assert.equal((await owner.ensurePersonal!()).id, mine.id);
  const work = join(f.root, "work");
  mkdirSync(work, { recursive: true });
  await f.registry.forSpace({ spaceId: "spc_home" }).add(work, "Work");
  await assert.rejects(
    canonicalProjectService(f.ctx("usr_viewer", "member"), f.registry).ensurePersonal!(),
    (error: { code?: string }) => error.code === "conflict",
  );
});
