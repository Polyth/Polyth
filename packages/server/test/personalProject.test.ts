import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
  const work = mkdtempSync(join(tmpdir(), "polyth-first-run-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
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

test("nobody can register the server's data folder; a parent of it is an ordinary project", async t => {
  const f = fixture(t);
  const owner = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  for (const path of [f.root, join(f.root, "spaces"), f.storageDir]) {
    await assert.rejects(owner.add(path), (error: { code?: string }) => error.code === "invalid-path", path);
  }
  // Answers the same whether or not the folder exists.
  await assert.rejects(owner.add(join(f.root, "no-such-folder")), (error: { code?: string }) => error.code === "invalid-path");
  await assert.rejects(owner.create(join(f.root, "no-such-folder")), (error: { code?: string }) => error.code === "invalid-path");
  const outside = mkdtempSync(join(tmpdir(), "polyth-outside-data-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal((await owner.add(outside)).path, resolve(outside));
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

test("a private room belongs to one person: its folder, list and resource keep everyone else out", async (t) => {
  const { registry, ctx, security } = fixture(t);
  const owner = canonicalProjectService(ctx("usr_owner", "owner"), registry);
  const member = canonicalProjectService(ctx("usr_member"), registry);
  const viewer = canonicalProjectService(ctx("usr_viewer", "viewer"), registry);
  const shared = await owner.create(join(mkdtempSync(join(tmpdir(), "polyth-room-")), "wellness"), "Wellness");

  const room = await member.ensurePrivateRoom!(shared.id);
  assert.equal(room.parentProjectId, shared.id);
  assert.equal(room.name, "Wellness");
  assert.ok(room.path.includes(`${sep}personal${sep}`));
  assert.ok(existsSync(room.path));
  assert.equal((await member.ensurePrivateRoom!(shared.id)).id, room.id, "one room per person and project");

  // On nobody's project list, not even its owner's.
  assert.ok(!(await member.list()).some((project) => project.id === room.id));
  assert.ok(!(await owner.list()).some((project) => project.id === room.id));
  // The owner of the Space cannot open or find it, and gets their own room.
  assert.equal(await owner.get(room.id).catch((error: { code?: string }) => error.code), "not-found");
  assert.deepEqual((await owner.privateRooms!(shared.id)).map((row) => row.id), []);
  // Settings are no back door: a foreign room reads as missing, and can't be written.
  assert.equal(await owner.getPresentationSettings!(room.id).catch((error: { code?: string }) => error.code), "not-found");
  await assert.rejects(owner.putPresentationSettings!(room.id, {} as never, 0), (error: { code?: string }) => error.code === "not-found");
  assert.deepEqual((await member.privateRooms!(shared.id)).map((row) => row.id), [room.id]);
  assert.notEqual((await owner.ensurePrivateRoom!(shared.id)).id, room.id);
  // The folder can't be registered by anyone else, existing or not.
  await assert.rejects(owner.add(room.path), (error: { code?: string }) => error.code === "invalid-path");
  // A viewer doesn't get one; a room or personal project doesn't nest.
  await assert.rejects(viewer.ensurePrivateRoom!(shared.id), (error: { code?: string }) => error.code === "forbidden");
  await assert.rejects(member.ensurePrivateRoom!(room.id), (error: { code?: string }) => error.code === "conflict");

  // The shell's own list carries the room for its owner, and who else is here.
  const shell = await member.listForShell!();
  assert.equal(shell.find((project) => project.id === shared.id)?.sharedWith, 2);
  assert.ok(shell.some((project) => project.id === room.id));
  assert.ok(!(await viewer.listForShell!()).some((project) => project.parentProjectId));
  void security;
});

test("a room's appearance follows its project, and it survives the project as a private project", async (t) => {
  const { registry, ctx } = fixture(t);
  const owner = canonicalProjectService(ctx("usr_owner", "owner"), registry);
  const member = canonicalProjectService(ctx("usr_member"), registry);
  const shared = await owner.create(join(mkdtempSync(join(tmpdir(), "polyth-room-")), "wellness"), "Wellness");
  const room = await member.ensurePrivateRoom!(shared.id);
  await owner.update!(shared.id, { name: "Family health", color: "#123456" });
  const renamed = await member.get(room.id);
  assert.equal(renamed?.name, "Family health");
  assert.equal(renamed?.color, "#123456");
  await assert.rejects(member.update!(room.id, { name: "Mine" }), (error: { code?: string }) => error.code === "conflict");

  await owner.remove(shared.id);
  const detached = (await member.list()).find((project) => project.id === room.id);
  assert.ok(detached, "its owner now sees it as a project");
  assert.equal(detached?.parentProjectId, undefined);
  assert.equal(detached?.detachedFromProjectId, shared.id);
  assert.equal(detached?.name, "Family health");
  assert.ok(!(await owner.list()).some((project) => project.id === room.id), "still private");
});

test("an account limited to a project keeps its room there and has none elsewhere", async (t) => {
  const { registry, ctx } = fixture(t);
  const owner = canonicalProjectService(ctx("usr_owner", "owner"), registry);
  const allowed = await owner.create(join(mkdtempSync(join(tmpdir(), "polyth-room-")), "allowed"), "Allowed");
  const other = await owner.create(join(mkdtempSync(join(tmpdir(), "polyth-room-")), "other"), "Other");
  const limited = limitedProjectsForActor(ctx("usr_member"), canonicalProjectService(ctx("usr_member"), registry), () => ({ projects: [allowed.id] }) as never);
  const room = await limited.ensurePrivateRoom!(allowed.id);
  assert.equal(room.parentProjectId, allowed.id);
  await assert.rejects(limited.ensurePrivateRoom!(other.id), (error: { code?: string }) => error.code === "not-found");
});
