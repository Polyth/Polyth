import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { createProjectService } from "../src/projects.ts";
import { canonicalProjectService } from "../src/projectResourceAuthority.ts";
import { limitedProjectsForActor } from "../src/accountLimits.ts";
import { managedFolderName, managedProjectLocation, parseManagedProjectInput, reserveManagedFolder } from "../src/managedProjects.ts";
import { projectRoutes } from "../src/routes/projects.ts";
import type { SpaceServicesFor } from "../src/spaceScope.ts";

function fixture(t: test.TestContext, opts: { canonical?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "polyth-managed-project-"));
  const storageDir = join(root, "spaces", "home");
  let dispose = () => {};
  if (opts.canonical !== false) {
    const security = createCanonicalSecurity({ dataDir: root, origin: "http://127.0.0.1:4400", localOnly: true, now: () => 1_000 });
    security.control.transaction(() => {
      for (const [id, name] of [["usr_owner", "Owner"], ["usr_member", "Member"], ["usr_viewer", "Viewer"]] as const) {
        security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
        security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
      }
      security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
      security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_owner','owner')");
      security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_member','member')");
      security.control.run("INSERT INTO organization_memberships(org_id,user_id,role) VALUES('org_home','usr_viewer','guest')");
      security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES('spc_home','org_home','Home','home','shared',1,1)");
      security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_owner','owner',1)");
      security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_member','member',1)");
      security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home','usr_viewer','viewer',1)");
    });
    const binding = bindCanonicalSecurity(security);
    dispose = () => { binding.dispose(); security.close(); };
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
  return { root, storageDir, registry, ctx };
}

/** Run as Polyth Desktop with a throwaway home directory. */
function asDesktop(t: test.TestContext): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "polyth-managed-home-")));
  const previous = { desktop: process.env.POLYTH_DESKTOP, home: process.env.HOME };
  process.env.POLYTH_DESKTOP = "1";
  process.env.HOME = home;
  t.after(() => {
    if (previous.desktop === undefined) delete process.env.POLYTH_DESKTOP;
    else process.env.POLYTH_DESKTOP = previous.desktop;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("on a server a new project gets its own folder in Space storage", async t => {
  const f = fixture(t);
  const composition = { version: 1 as const, directions: ["research" as const], packageOverrides: {} };
  const project = await canonicalProjectService(f.ctx("usr_member"), f.registry).createManaged!({ name: "Подорож до Італії", composition });

  assert.equal(project.name, "Подорож до Італії");
  assert.equal(project.spaceId, "spc_home");
  assert.deepEqual(project.composition, composition);
  assert.ok(existsSync(project.path), "the folder is created");
  assert.equal(dirname(project.path), join(realpathSync(f.storageDir), "projects"));
  assert.match(basename(project.path), /^[0-9a-f-]{36}$/, "the folder name carries no request text");
  assert.equal(existsSync(join(project.path, ".git")), false, "not a Git repository");
  assert.equal("managedOperation" in project, false, "the retry key stays server-side");
  assert.equal(project.personal, undefined, "it is an ordinary project");

  // It behaves as an ordinary project, visible beside the others.
  assert.deepEqual((await canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry).list()).map((p) => p.id), [project.id]);
});

test("on Desktop it is a readable folder under ~/Polyth, and same names never share one", async t => {
  const home = asDesktop(t);
  const f = fixture(t);
  const service = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);

  const first = await service.createManaged!({ name: "Подорож до Італії" });
  assert.equal(first.path, join(home, "Polyth", "Подорож до Італії"));
  assert.ok(existsSync(first.path));

  const second = await service.createManaged!({ name: "Подорож до Італії" });
  assert.equal(second.path, join(home, "Polyth", "Подорож до Італії 2"));
  assert.equal(second.name, "Подорож до Італії", "the project keeps the chosen name");
  assert.notEqual(second.id, first.id);
});

test("a folder the person already has is never adopted", async t => {
  const home = asDesktop(t);
  const f = fixture(t);
  const mine = join(home, "Polyth", "Рецепти");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "борщ.txt"), "мій файл");

  const project = await canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry).createManaged!({ name: "Рецепти" });

  assert.equal(project.path, join(home, "Polyth", "Рецепти 2"));
  assert.deepEqual(readdirSync(project.path), []);
});

test("a registered path whose folder was deleted is not handed to a new project", async t => {
  const home = asDesktop(t);
  const f = fixture(t);
  const service = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const first = await service.createManaged!({ name: "Дім" });
  rmSync(first.path, { recursive: true, force: true });

  const second = await service.createManaged!({ name: "Дім" });

  assert.notEqual(second.id, first.id);
  assert.equal(second.path, join(home, "Polyth", "Дім 2"));
});

test("a resend after a lost response returns the first project and makes no second folder", async t => {
  const home = asDesktop(t);
  const f = fixture(t);
  const service = canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry);
  const input = { name: "Фінанси", clientOperationId: "op-11111111" };

  const [first, concurrent] = await Promise.all([service.createManaged!(input), service.createManaged!(input)]);
  const resent = await service.createManaged!(input);

  assert.equal(concurrent.id, first.id);
  assert.equal(resent.id, first.id);
  assert.deepEqual(readdirSync(join(home, "Polyth")), ["Фінанси"], "the losing resend gave its folder back");
  assert.equal((await service.list()).length, 1);
});

test("another person's retry key finds nothing of yours", async t => {
  const f = fixture(t);
  const input = { name: "Фінанси", clientOperationId: "op-22222222" };

  const owner = await canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry).createManaged!(input);
  const member = await canonicalProjectService(f.ctx("usr_member"), f.registry).createManaged!(input);

  assert.notEqual(member.id, owner.id);
  assert.notEqual(member.path, owner.path);
});

test("a failed provision takes its folder back", async t => {
  const home = asDesktop(t);
  const f = fixture(t, { canonical: false });
  const failing = Object.create(f.registry) as typeof f.registry;
  failing.provision = async () => { throw new Error("disk trouble"); };

  await assert.rejects(canonicalProjectService(f.ctx("usr_owner", "owner"), failing).createManaged!({ name: "Нотатки" }), /disk trouble/);

  assert.deepEqual(readdirSync(join(home, "Polyth")), []);
});

test("a viewer and a project-limited account cannot create one", async t => {
  const f = fixture(t);
  await assert.rejects(
    canonicalProjectService(f.ctx("usr_viewer", "viewer"), f.registry).createManaged!({ name: "Ні" }),
    (error: { code?: string }) => error.code === "forbidden",
  );

  const limited = limitedProjectsForActor(
    f.ctx("usr_member"),
    canonicalProjectService(f.ctx("usr_member"), f.registry),
    () => ({ projects: ["some-other-project"], harnesses: null, messagesPerDay: null, chatsPerDay: null }),
  );
  await assert.rejects(limited.createManaged!({ name: "Ні" }), (error: { code?: string }) => error.code === "forbidden");

  assert.equal(existsSync(join(f.storageDir, "projects")), false, "a refused caller creates no folder");
});

test("it also works without the canonical resource authority", async t => {
  const f = fixture(t, { canonical: false });
  const project = await canonicalProjectService(f.ctx("usr_owner", "owner"), f.registry).createManaged!({ name: "Дім" });
  assert.ok(project.path.startsWith(realpathSync(f.storageDir) + sep + "projects" + sep), project.path);
  await assert.rejects(
    canonicalProjectService(f.ctx("usr_viewer", "viewer"), f.registry).createManaged!({ name: "Ні" }),
    (error: { code?: string }) => error.code === "forbidden",
  );
});

test("a symlink planted at the storage root cannot move the folder out of the Space", async t => {
  const f = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), "polyth-managed-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(f.storageDir, "projects"));

  await assert.rejects(
    canonicalProjectService(f.ctx("usr_member"), f.registry).createManaged!({ name: "Втеча" }),
    (error: { code?: string }) => error.code === "invalid-path",
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("a project name becomes one safe folder name", () => {
  assert.equal(managedFolderName("Подорож до Італії"), "Подорож до Італії");
  // Traversal cannot survive: separators are gone and leading dots are stripped.
  assert.equal(managedFolderName("../../etc/passwd"), "etc passwd");
  assert.equal(managedFolderName("..\\..\\Windows"), "Windows");
  assert.equal(managedFolderName("..."), "Project");
  assert.equal(managedFolderName("  /  "), "Project");
  assert.equal(managedFolderName("a:b*c?d\"e<f>g|h"), "a b c d e f g h");
  assert.equal(managedFolderName("nul\0byte"), "nul byte");
  // A right-to-left override could make a folder read as something else.
  assert.equal(managedFolderName("invoice‮txt.exe"), "invoice txt.exe");
  assert.equal(managedFolderName("trailing dots..."), "trailing dots");
  assert.equal(managedFolderName("CON"), "Project CON");
  assert.equal(managedFolderName("lpt1.txt"), "Project lpt1.txt");

  const long = managedFolderName("щ".repeat(150));
  assert.ok(Buffer.byteLength(long) <= 200);
  const emoji = managedFolderName("📁".repeat(120));
  assert.ok(Buffer.byteLength(emoji) <= 200);
  assert.ok(!emoji.includes("�"), "no character is cut in half");
});

test("a request is rejected before any folder exists", () => {
  for (const name of [undefined, "", "   ", 7, "x".repeat(121)]) {
    assert.throws(() => parseManagedProjectInput({ name } as never), (error: { code?: string }) => error.code === "invalid-input");
  }
  for (const clientOperationId of ["short", "../../x-long-enough", 7]) {
    assert.throws(() => parseManagedProjectInput({ name: "Так", clientOperationId } as never), (error: { code?: string }) => error.code === "invalid-input");
  }
  assert.throws(() => parseManagedProjectInput({ name: "Так", composition: { version: 2 } } as never), (error: { code?: string }) => error.code === "invalid-input");
  assert.deepEqual(parseManagedProjectInput({ name: "  Дім   мій " }), { name: "Дім мій" });
});

test("reserving a folder gives up instead of looping forever", t => {
  const parent = mkdtempSync(join(tmpdir(), "polyth-managed-reserve-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  assert.throws(() => reserveManagedFolder(parent, "Дім", () => true), (error: { code?: string }) => error.code === "conflict");
});

test("the route ignores a client path, and reports what the deployment allows", async t => {
  const f = fixture(t);
  const ctx = f.ctx("usr_member");
  const spaces = (() => ({ projects: canonicalProjectService(ctx, f.registry) })) as unknown as SpaceServicesFor;
  const route = projectRoutes(spaces);
  const call = async (method: string, input: Record<string, unknown> = {}) => {
    let reply: { status: number; body: unknown } | undefined;
    const handled = await route({
      path: "/api/projects/managed",
      method,
      space: ctx,
      body: async () => input,
      json: (status: number, body: unknown) => { reply = { status, body }; },
    } as never);
    assert.equal(handled, true);
    return reply!;
  };

  const outside = join(f.root, "outside");
  const created = await call("POST", { name: "Дім", path: outside });
  assert.equal(created.status, 200);
  assert.ok((created.body as { path: string }).path.startsWith(join(realpathSync(f.storageDir), "projects")));
  assert.equal(existsSync(outside), false);

  assert.deepEqual((await call("GET")).body, { canChooseFolder: true });
});

test("a sandboxed deployment offers no folder picker, and only Desktop names a home folder", t => {
  assert.deepEqual(managedProjectLocation({ deployment: "multi-tenant-sandboxed" }), { canChooseFolder: false });
  assert.deepEqual(managedProjectLocation({ deployment: "server-trusted" }), { canChooseFolder: true });
  asDesktop(t);
  assert.deepEqual(managedProjectLocation({ deployment: "local-trusted" }), { canChooseFolder: true, rootLabel: "~/Polyth" });
});
