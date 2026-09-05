import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentProfile } from "@polyth/contracts";
import {
  BOOTSTRAP_USER_ID,
  createIdentityResolver,
  createSpaceResolver,
  createTenancyStore,
  deploymentProfileFromEnv,
  migrateToSpaces,
  resolveInside,
  slugify,
  spaceDirName,
  spaceStorageDir,
  type TenancyStore,
} from "../src/index.ts";

const tmp = (prefix = "polyth-tenancy-") => mkdtempSync(join(tmpdir(), prefix));

const storeIn = (dir: string): TenancyStore =>
  createTenancyStore({ file: join(dir, "tenancy.json") });

// ---- registry ---------------------------------------------------------------

test("membership is the only way to reach a space, and a stranger cannot tell it exists", () => {
  const store = storeIn(tmp());
  const alice = store.createUser("Alice");
  const bob = store.createUser("Bob");
  const home = store.createSpace({ name: "Home", ownerId: alice.id });

  assert.deepEqual(store.spacesFor(alice.id).map((s) => s.name), ["Home"]);
  assert.deepEqual(store.spacesFor(bob.id), []);

  // Bob is refused with the SAME error a nonexistent id produces, so a valid
  // id is not distinguishable from an invented one.
  const denial = (spaceId: string) => {
    try {
      store.requireMembership(bob.id, spaceId);
      throw new Error("expected a refusal");
    } catch (error) {
      return error as { code?: string; message: string };
    }
  };
  const real = denial(home.id);
  const invented = denial("spc_nope");
  assert.equal(real.code, "not-found");
  assert.equal(real.message, invented.message);
});

test("roles gate administrative actions without preventing multi-member growth", () => {
  const store = storeIn(tmp());
  const owner = store.createUser("Owner");
  const guest = store.createUser("Guest");
  const work = store.createSpace({ name: "Work", ownerId: owner.id });

  store.addMember(owner.id, work.id, guest.id, "viewer");
  assert.equal(store.roleOf(guest.id, work.id), "viewer");
  // A viewer sees the Space but may not administer it.
  assert.deepEqual(store.spacesFor(guest.id).map((s) => s.role), ["viewer"]);
  assert.throws(
    () => store.renameSpace(guest.id, work.id, { name: "Hijacked" }),
    (error: { code?: string }) => error.code === "forbidden",
  );
  assert.throws(
    () => store.addMember(guest.id, work.id, owner.id, "viewer"),
    (error: { code?: string }) => error.code === "forbidden",
  );
  // The last owner cannot be removed, so a Space can never become unreachable.
  assert.throws(
    () => store.removeMember(owner.id, work.id, owner.id),
    /at least one owner/,
  );
});

test("slugs are unique directory names and the default space is undeletable", () => {
  const store = storeIn(tmp());
  const user = store.createUser("User");
  const first = store.createSpace({ name: "Side Project!", ownerId: user.id });
  const second = store.createSpace({ name: "Side Project", ownerId: user.id });
  assert.equal(first.slug, "side-project");
  assert.equal(second.slug, "side-project-2");
  assert.equal(first.isDefault, true);

  assert.throws(() => store.deleteSpace(user.id, first.id), /default space/);
  store.deleteSpace(user.id, second.id);
  assert.deepEqual(store.spacesFor(user.id).map((s) => s.id), [first.id]);
});

test("a remembered selection is re-authorized on every read", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const alice = store.createUser("Alice");
  const bob = store.createUser("Bob");
  const home = store.createSpace({ name: "Home", ownerId: alice.id });

  store.select("device:1", alice.id, home.id);
  assert.equal(store.selection("device:1", alice.id), home.id);
  // Same device key, different identity: the remembered value is not honoured.
  assert.equal(store.selection("device:1", bob.id), undefined);

  // And it survives a reload of the file.
  assert.equal(storeIn(dir).selection("device:1", alice.id), home.id);
});

// ---- context resolution ------------------------------------------------------

const resolverFor = (dir: string, deployment: DeploymentProfile = "local-trusted") => {
  const store = storeIn(dir);
  const owner = store.createUser("Owner", BOOTSTRAP_USER_ID);
  const home = store.createSpace({ name: "Home", ownerId: owner.id, isDefault: true });
  const work = store.createSpace({ name: "Work", ownerId: owner.id });
  const resolver = createSpaceResolver({
    store,
    identities: createIdentityResolver({ ownerUserId: owner.id, deployment }),
    dataDir: dir,
    deployment,
  });
  return { store, owner, home, work, resolver };
};

test("anonymous callers get no context; explicit hints must be valid", () => {
  const { resolver, home } = resolverFor(tmp());

  assert.throws(
    () => resolver.forPrincipal({ kind: "anonymous" }),
    (error: { code?: string }) => error.code === "unauthorized",
  );

  const local = resolver.forPrincipal({ kind: "local-user", trustedLoopback: true });
  assert.equal(local.spaceId, home.id);
  assert.equal(local.role, "owner");

  // An explicit hint for a Space the caller does not belong to is an error,
  // not a silent fallback to their default.
  assert.throws(
    () => resolver.forPrincipal(
      { kind: "local-user", trustedLoopback: true },
      { explicit: "spc_someone_else" },
    ),
    (error: { code?: string }) => error.code === "not-found",
  );
});

test("the local control socket acts as the operator only in a trusted deployment", () => {
  const service = { kind: "internal-service", serviceId: "polyth-control" } as const;

  // Trusted: the filesystem-protected control socket speaks for the operator,
  // exactly like the loopback UI does.
  const trusted = resolverFor(tmp(), "local-trusted");
  assert.equal(trusted.resolver.forPrincipal(service).spaceId, trusted.home.id);

  // Hosted: there is no ambient operator, so a service gets no tenant and must
  // be handed an explicit context by whatever invoked it.
  const hosted = resolverFor(tmp(), "multi-tenant-sandboxed");
  assert.throws(
    () => hosted.resolver.forPrincipal(service),
    (error: { code?: string }) => error.code === "unauthorized",
  );
});

test("a bogus remembered hint falls back to the default space instead of failing", () => {
  const { resolver, home } = resolverFor(tmp());
  const ctx = resolver.forPrincipal(
    { kind: "local-user", trustedLoopback: true },
    { remembered: "spc_stale" },
  );
  assert.equal(ctx.spaceId, home.id);
});

test("each space gets its own storage root and switching changes it", () => {
  const dir = tmp();
  const { resolver, home, work } = resolverFor(dir);
  const principal = { kind: "local-user", trustedLoopback: true } as const;

  const inHome = resolver.forPrincipal(principal);
  resolver.remember(principal, work.id);
  const inWork = resolver.forPrincipal(principal);

  assert.equal(inHome.spaceId, home.id);
  assert.equal(inWork.spaceId, work.id);
  assert.notEqual(inHome.storageDir, inWork.storageDir);
  assert.ok(inHome.storageDir.endsWith(spaceDirName(home)));
  assert.ok(inWork.storageDir.endsWith(spaceDirName(work)));
});

// ---- filesystem containment ---------------------------------------------------

test("space paths refuse traversal, absolute injection, and symlink escape", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const user = store.createUser("User");
  const space = store.createSpace({ name: "Home", ownerId: user.id });
  const root = spaceStorageDir(dir, space);

  const secret = join(dir, "outside");
  mkdirSync(secret, { recursive: true });
  writeFileSync(join(secret, "credentials"), "s3cret");

  // Ordinary relative paths resolve inside.
  assert.ok(resolveInside(root, "attachments/file.txt").startsWith(root));

  for (const attempt of ["../outside/credentials", "attachments/../../outside", "/etc/passwd", "C:/windows", "\\\\host\\share"]) {
    assert.throws(
      () => resolveInside(root, attempt),
      (error: { code?: string }) => error.code === "invalid-path",
      `expected ${attempt} to be refused`,
    );
  }

  // A symlink planted inside the Space cannot be used to read outside it.
  symlinkSync(secret, join(root, "attachments", "escape"));
  assert.throws(
    () => resolveInside(root, "attachments/escape/credentials"),
    (error: { code?: string }) => error.code === "invalid-path",
  );
});

test("slugify never produces a directory-hostile name", () => {
  for (const input of ["../../etc", "  ", "Ünïcødé Spaße", "///", "a".repeat(200)]) {
    const slug = slugify(input);
    assert.match(slug, /^[a-z0-9][a-z0-9-]*$/, `bad slug for ${JSON.stringify(input)}`);
    assert.ok(slug.length <= 40);
  }
});

// ---- migration ----------------------------------------------------------------

test("migration adopts a single-user installation into Personal and is idempotent", async () => {
  const dir = tmp();
  const store = storeIn(dir);
  let projectsAdopted = 3;
  let sessionsAdopted = 7;
  const targets = {
    adoptProjects: () => { const n = projectsAdopted; projectsAdopted = 0; return n; },
    adoptSessions: () => { const n = sessionsAdopted; sessionsAdopted = 0; return n; },
  };

  const first = await migrateToSpaces({ store, targets });
  assert.equal(first.created, true);
  assert.equal(first.space.name, "Personal");
  assert.equal(first.space.isDefault, true);
  assert.equal(first.user.id, BOOTSTRAP_USER_ID);
  assert.equal(first.projectsAdopted, 3);
  assert.equal(first.sessionsAdopted, 7);

  // Second boot: same user, same Space, nothing left to adopt.
  const second = await migrateToSpaces({ store, targets });
  assert.equal(second.created, false);
  assert.equal(second.space.id, first.space.id);
  assert.equal(second.projectsAdopted, 0);
  assert.equal(second.sessionsAdopted, 0);

  // Rollback story: delete tenancy.json and the same identities come back.
  const rebuilt = await migrateToSpaces({ store: storeIn(tmp()), targets });
  assert.equal(rebuilt.user.id, BOOTSTRAP_USER_ID);
  assert.equal(rebuilt.space.name, "Personal");
});

// ---- deployment profile --------------------------------------------------------

test("the deployment profile comes from one env var and defaults to local-trusted", () => {
  assert.equal(deploymentProfileFromEnv({}), "local-trusted");
  assert.equal(deploymentProfileFromEnv({ POLYTH_DEPLOYMENT_PROFILE: "multi-tenant-sandboxed" }), "multi-tenant-sandboxed");
  assert.equal(deploymentProfileFromEnv({ POLYTH_DEPLOYMENT_PROFILE: "nonsense" }), "local-trusted");
});
