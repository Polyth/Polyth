import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type {
  AgentCapabilityContribution,
  RouteHandler,
  SecureSafeService,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  SPACE_SECURE_SAFE,
  type PeopleHost,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createSpaceStorage } from "@polyth/tenancy";
import {
  createSecureSafeService,
  runWithSecureSafeSpace,
  secretSavePartition,
} from "../src/index.ts";
import registerPackage, { createSpaceSafeRegistry } from "../src/serverEntry.ts";
import { createCredentialVaultListAgentTool } from "../src/agentTool.ts";

// Values below are synthetic test strings, never real credentials.
const ctx = (spaceId: string, userId: string, storageDir: string, role = "member"): SpaceContext => ({
  spaceId,
  userId,
  storageDir,
  role,
} as SpaceContext);

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-personal-safe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rootX = join(root, "space-x");
  const rootY = join(root, "space-y");
  mkdirSync(rootX, { recursive: true });
  mkdirSync(rootY, { recursive: true });
  const storages = new Map([["spc_x", createSpaceStorage(rootX)], ["spc_y", createSpaceStorage(rootY)]]);
  // Alice and Bob are members of X; only Carol is a member of Y.
  const members = new Map([["spc_x", new Set(["alice", "bob"])], ["spc_y", new Set(["carol"])]]);
  const personal = new Map<string, SecureSafeService>();
  const people = {
    isMember: (userId: string, spaceId: string) => members.get(spaceId)?.has(userId) ?? false,
    credentialVault(userId: string, packageId: string) {
      assert.equal(packageId, "secure-safe");
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(userId)) throw Object.assign(new Error("userId is invalid"), { code: "invalid-input" });
      let safe = personal.get(userId);
      if (!safe) {
        safe = createSecureSafeService({ dataDir: join(root, "people", userId, "vault", "secure-safe"), localOnly: true });
        personal.set(userId, safe);
      }
      return safe;
    },
  } as unknown as PeopleHost;
  const services = createServerServiceRegistry();
  const host = {
    services,
    people,
    spaceStorage: (space: SpaceContext) => storages.get(space.spaceId)!,
    systemSpaceContext: (spaceId: string) => ctx(spaceId, "system:runtime", join(root, spaceId)),
  } as unknown as ServerPackageHost;
  return { root, rootX, rootY, host, services, people, x: (userId: string, role = "member") => ctx("spc_x", userId, rootX, role), y: (userId: string) => ctx("spc_y", userId, rootY) };
}

async function call(routes: RouteHandler, space: SpaceContext, method: string, path: string, input: Record<string, unknown> = {}) {
  let status = 0;
  let payload: unknown;
  const handled = await routes({
    path,
    method,
    body: async () => input,
    json: (code: number, value: unknown) => { status = code; payload = value; },
    space,
  } as never);
  return { handled, status, payload };
}

test("each member manages only their own personal credentials; Space writes stay admin-only", async (t) => {
  const f = fixture(t);
  const pkg = registerPackage(f.host);
  const routes = pkg.routes!;

  const created = await call(routes, f.x("alice"), "POST", "/api/secure-safe/personal", { handle: "gh", label: "GitHub", value: "alice-gh-value" });
  assert.equal(created.status, 200);
  const aliceEntry = created.payload as { id: string; handle: string };

  // Bob sees none of Alice's entries and cannot address them by id.
  assert.deepEqual((await call(routes, f.x("bob"), "GET", "/api/secure-safe/personal")).payload, []);
  await assert.rejects(
    call(routes, f.x("bob"), "PATCH", `/api/secure-safe/personal/${aliceEntry.id}`, { value: "bob-overwrite" }),
    (error: { code?: string }) => error.code === "not-found",
  );
  assert.deepEqual((await call(routes, f.x("bob"), "DELETE", `/api/secure-safe/personal/${aliceEntry.id}`)).payload, { ok: false });
  // Even an admin reaches only their own partition through the route.
  assert.deepEqual((await call(routes, f.x("bob", "admin"), "GET", "/api/secure-safe/personal")).payload, []);

  const listed = (await call(routes, f.x("alice"), "GET", "/api/secure-safe/personal")).payload as Array<{ handle: string }>;
  assert.deepEqual(listed.map((entry) => entry.handle), ["gh"]);
  // Personal entries are not Space entries.
  assert.deepEqual((await call(routes, f.x("alice"), "GET", "/api/secure-safe")).payload, []);
  // A member may rotate and delete their own.
  assert.equal((await call(routes, f.x("alice"), "PATCH", `/api/secure-safe/personal/${aliceEntry.id}`, { value: "alice-rotated" })).status, 200);
  await assert.rejects(
    call(routes, f.x("alice"), "POST", "/api/secure-safe", { handle: "shared", label: "Shared", value: "x" }),
    (error: { code?: string }) => error.code === "forbidden",
  );
  assert.deepEqual((await call(routes, f.x("alice"), "GET", "/api/secure-safe/access")).payload, { canManageSpace: false, personal: true });
  assert.deepEqual((await call(routes, f.x("bob", "admin"), "GET", "/api/secure-safe/access")).payload, { canManageSpace: true, personal: true });
  // System principals have no personal partition.
  await assert.rejects(
    call(routes, f.x("system:runtime", "owner"), "GET", "/api/secure-safe/personal"),
    (error: { code?: string }) => error.code === "unsupported",
  );
  assert.deepEqual((await call(routes, f.x("alice"), "DELETE", `/api/secure-safe/personal/${aliceEntry.id}`)).payload, { ok: true });

  // Values never left the person's own partition directory.
  const disk = readFileSync(join(f.root, "people", "alice", "vault", "secure-safe", "secure-safe-secrets.json"), "utf8");
  assert.doesNotMatch(disk, /alice-rotated/);
});

test("resolution is personal-first, never another member's, Space-only for system work and foreign Spaces", async (t) => {
  const f = fixture(t);
  const registry = createSpaceSafeRegistry(f.host);
  const spaceX = registry.forSpace(f.x("bob", "admin"));
  await spaceX.create({ handle: "deploy", label: "Deploy", value: "space-deploy" });
  await spaceX.create({ handle: "npm", label: "npm", value: "space-npm" });
  await registry.forPerson("spc_x", "alice")!.create({ handle: "deploy", label: "Mine", value: "alice-deploy" });
  await registry.forPerson("spc_x", "bob")!.create({ handle: "npm", label: "Mine", value: "bob-npm" });

  const env = (actorUserId?: string) => spaceX.resolveExecutionEnv!({
    projectId: "prj_1",
    envRefs: ["POLYTH_SAFE_DEPLOY", "POLYTH_SAFE_NPM"],
    ...(actorUserId ? { actorUserId } : {}),
  }).env;
  // Alice: her own deploy, the Space's npm — never Bob's npm.
  assert.deepEqual(env("alice"), { POLYTH_SAFE_DEPLOY: "alice-deploy", POLYTH_SAFE_NPM: "space-npm" });
  assert.deepEqual(env("bob"), { POLYTH_SAFE_DEPLOY: "space-deploy", POLYTH_SAFE_NPM: "bob-npm" });
  // System work (no actor, or a system principal): Space only.
  assert.deepEqual(env(), { POLYTH_SAFE_DEPLOY: "space-deploy", POLYTH_SAFE_NPM: "space-npm" });
  assert.deepEqual(env("system:runtime"), { POLYTH_SAFE_DEPLOY: "space-deploy", POLYTH_SAFE_NPM: "space-npm" });
  // Carol is not a member of X: her (or anyone's) claim yields Space only.
  await registry.forPerson("spc_y", "carol")!.create({ handle: "deploy", label: "Carol", value: "carol-deploy" });
  assert.equal(registry.forPerson("spc_x", "carol"), undefined);
  assert.deepEqual(env("carol"), { POLYTH_SAFE_DEPLOY: "space-deploy", POLYTH_SAFE_NPM: "space-npm" });
  // A personal-only handle stays invisible to everyone else.
  await registry.forPerson("spc_x", "alice")!.create({ handle: "private", label: "Only Alice", value: "alice-private" });
  assert.throws(
    () => spaceX.resolveExecutionEnv!({ projectId: "prj_1", envRefs: ["POLYTH_SAFE_PRIVATE"], actorUserId: "bob" }),
    (error: { code?: string }) => error.code === "not-found",
  );
  // Foreign Space Y never sees X's Space entries, even for its own member.
  assert.throws(
    () => registry.forSpace(f.y("carol")).resolveExecutionEnv!({ projectId: "prj_1", envRefs: ["POLYTH_SAFE_NPM"], actorUserId: "carol" }),
    (error: { code?: string }) => error.code === "not-found",
  );

  const used: string[] = [];
  await spaceX.useCredential!({ projectId: "prj_1", handle: "deploy", actorUserId: "alice" }, (value) => { used.push(value); });
  await spaceX.useCredential!({ projectId: "prj_1", handle: "deploy" }, (value) => { used.push(value); });
  await spaceX.useCredential!({ projectId: "prj_1", handle: "npm", actorUserId: "alice" }, (value) => { used.push(value); });
  assert.deepEqual(used, ["alice-deploy", "space-deploy", "space-npm"]);
  // A failing callback on a personal value is not retried with the Space's.
  let calls = 0;
  await assert.rejects(spaceX.useCredential!({ projectId: "prj_1", handle: "deploy", actorUserId: "alice" }, () => {
    calls += 1;
    throw Object.assign(new Error("fill target not found"), { code: "not-found" });
  }));
  assert.equal(calls, 1);
});

test("the routed host vault resolves for the actor and redacts the signed-in person's values", async (t) => {
  const f = fixture(t);
  registerPackage(f.host);
  const registry = f.services.require(SPACE_SECURE_SAFE) as ReturnType<typeof createSpaceSafeRegistry>;
  await registry.forSpace(f.x("bob", "admin")).create({ handle: "deploy", label: "Deploy", value: "space-deploy-value" });
  await registry.forPerson("spc_x", "alice")!.create({ handle: "deploy", label: "Mine", value: "alice-deploy-value" });
  await registry.forPerson("spc_x", "bob")!.create({ handle: "other", label: "Bob", value: "bob-other-value" });
  const resolved: Array<{ handles: readonly string[] }> = [];
  const router = createSecureSafeService({ dataDir: join(f.root, "host"), onResolved: (info) => { resolved.push(info); } });

  const asAlice = (run: () => unknown) => runWithSecureSafeSpace(f.x("alice"), run);
  assert.deepEqual(asAlice(() => router.resolveExecutionEnv!({ projectId: "p", envRefs: ["POLYTH_SAFE_DEPLOY"], actorUserId: "alice" }).env), { POLYTH_SAFE_DEPLOY: "alice-deploy-value" });
  assert.deepEqual(asAlice(() => router.resolveExecutionEnv!({ projectId: "p", envRefs: ["POLYTH_SAFE_DEPLOY"] }).env), { POLYTH_SAFE_DEPLOY: "space-deploy-value" });
  assert.equal(resolved.length, 2);
  // Redaction keeps covering Space values and adds the signed-in person's own,
  // but never reveals that a string matches another member's secret.
  assert.equal(
    asAlice(() => router.redact!("alice-deploy-value space-deploy-value bob-other-value")),
    "[redacted] [redacted] bob-other-value",
  );
  // forPerson is bound to the Space context and its members.
  assert.ok(asAlice(() => router.forPerson!("alice")));
  assert.equal(asAlice(() => router.forPerson!("carol")), undefined);
  assert.equal(router.forPerson!("alice"), undefined);
});

test("secret request partition: personal by default, Space only for an admin who picks it", () => {
  const decide = (input: Partial<Parameters<typeof secretSavePartition>[0]>) =>
    secretSavePartition({ spaceAdmin: false, privateChat: false, person: "alice", ...input });
  assert.equal(decide({}), "personal");
  assert.equal(decide({ requested: "personal", spaceAdmin: true }), "personal");
  assert.equal(decide({ spaceAdmin: true, privateChat: true }), "personal");
  assert.equal(decide({ spaceAdmin: true, privateChat: false }), "space");
  assert.equal(decide({ requested: "space", spaceAdmin: true, privateChat: true }), "space");
  assert.throws(() => decide({ requested: "space" }), (error: { code?: string }) => error.code === "forbidden");
  assert.throws(() => decide({ requested: "everyone" as never }), (error: { code?: string }) => error.code === "invalid-input");
  // Trusted system work has no person: Space, and never a personal claim.
  assert.equal(decide({ person: undefined }), "space");
  assert.throws(() => decide({ person: undefined, requested: "personal" }), (error: { code?: string }) => error.code === "invalid-input");
});

test("the agent list tool shows the actor's own handles and the Space's, never another member's", async (t) => {
  const f = fixture(t);
  const registry = createSpaceSafeRegistry(f.host);
  await registry.forSpace(f.x("bob", "admin")).create({ handle: "deploy", label: "Space deploy", value: "v1" });
  await registry.forSpace(f.x("bob", "admin")).create({ handle: "shared", label: "Shared", value: "v2" });
  await registry.forPerson("spc_x", "alice")!.create({ handle: "deploy", label: "My deploy", value: "v3" });
  await registry.forPerson("spc_x", "bob")!.create({ handle: "bobs", label: "Bob's", value: "v4" });
  const tool = createCredentialVaultListAgentTool(
    (spaceId) => registry.forSpaceId(spaceId),
    (spaceId, userId) => registry.forPerson(spaceId, userId),
  ) as AgentCapabilityContribution & { execute(input: object, context: ToolExecutionContext): Promise<{ output: string }> };
  const list = async (actorUserId?: string) => JSON.parse((await tool.execute({}, {
    sessionId: "ses_1",
    projectId: "prj_1",
    spaceId: "spc_x",
    ...(actorUserId ? { actorUserId } : {}),
  } as ToolExecutionContext)).output).handles as Array<{ handle: string; label: string; partition: string }>;
  assert.deepEqual((await list("alice")).map((row) => [row.handle, row.label, row.partition]), [
    ["deploy", "My deploy", "personal"],
    ["shared", "Shared", "space"],
  ]);
  assert.deepEqual((await list()).map((row) => [row.handle, row.partition]), [["deploy", "space"], ["shared", "space"]]);
  assert.ok((await list("carol")).every((row) => row.partition === "space"));
  const output = JSON.stringify(await list("alice"));
  assert.doesNotMatch(output, /v1|v2|v3|v4|bobs/);
});

test("opaque keys are namespaced per package: no cross-package reads; legacy keys migrate idempotently", async (t) => {
  const f = fixture(t);
  // A Space store written before namespaces existed.
  const legacyDir = join(f.rootX, "secure-safe");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "secure-safe-secrets.json"), JSON.stringify({
    "opaque:google:spc_x:account:a1": "google-refresh",
    "opaque:gitlab:spc_x:account:g1": "gitlab-pat",
    "opaque:task-trackers:spc_x:jira": "jira-secret",
    "opaque:pkgconn:spc_x:example:main": "plugin-conn",
    "opaque:mystery-key-1": "unclaimed",
  }));
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  t.after(() => { console.warn = warn; });

  registerPackage({ ...f.host, services: bindPackageServices(f.services, "secure-safe") } as ServerPackageHost);
  const asPackage = (packageId: string) => bindPackageServices(f.services, packageId).require(SPACE_SECURE_SAFE).forSpaceId("spc_x")!;
  const google = asPackage("google");
  const gitlab = asPackage("gitlab");
  const plugins = asPackage("plugins");
  assert.equal(google.getOpaque("google:spc_x:account:a1"), "google-refresh");
  assert.equal(gitlab.getOpaque("gitlab:spc_x:account:g1"), "gitlab-pat");
  assert.equal(asPackage("task-trackers").getOpaque("task-trackers:spc_x:jira"), "jira-secret");
  assert.equal(plugins.getOpaque("pkgconn:spc_x:example:main"), "plugin-conn");
  // Cross-package reads, writes and prefix deletes cannot reach another's keys.
  assert.equal(gitlab.getOpaque("google:spc_x:account:a1"), null);
  assert.equal(asPackage("pkgconn").getOpaque("pkgconn:spc_x:example:main"), null);
  gitlab.putOpaque("google:spc_x:account:a1", "hijack");
  gitlab.deleteOpaqueByPrefix("google:");
  gitlab.deleteOpaque("pkg.google:google:spc_x:account:a1");
  assert.equal(google.getOpaque("google:spc_x:account:a1"), "google-refresh");
  // Unclaimed keys stay host-only, reported once by count.
  assert.equal(google.getOpaque("mystery-key-1"), null);
  const raw = f.services.require(SPACE_SECURE_SAFE).forSpaceId("spc_x")!;
  assert.equal(raw.getOpaque("mystery-key-1"), "unclaimed");
  assert.equal(warnings.filter((line) => line.includes("belong to no known package")).length, 1);
  assert.doesNotMatch(warnings.join("\n"), /unclaimed|google-refresh/);
  // Package facades never hand out person stores.
  assert.equal((google as SecureSafeService).forPerson, undefined);

  // Reopening the migrated file is a no-op (idempotent).
  const disk = JSON.parse(readFileSync(join(legacyDir, "secure-safe-secrets.json"), "utf8")) as Record<string, string>;
  assert.equal(disk["opaque:pkg.google:google:spc_x:account:a1"], "google-refresh");
  assert.equal(disk["opaque:google:spc_x:account:a1"], undefined);
  const reopened = createSecureSafeService({ dataDir: legacyDir, localOnly: true, migrateLegacyOpaque: true });
  assert.equal(reopened.getOpaque("pkg.google:google:spc_x:account:a1"), "google-refresh");
  assert.equal(reopened.getOpaque("pkg.plugins:pkgconn:spc_x:example:main"), "plugin-conn");

  // The host-level router service is namespaced the same way.
  f.services.provide(serverServiceKey<SecureSafeService>("secure-safe"), raw);
  const viaRouter = bindPackageServices(f.services, "task-trackers").require(serverServiceKey<SecureSafeService>("secure-safe"));
  assert.equal(viaRouter.getOpaque("task-trackers:spc_x:jira"), "jira-secret");
  assert.equal(viaRouter.getOpaque("google:spc_x:account:a1"), null);
});

test("package services bind once, and a repeated namespace on disk collapses", async (t) => {
  const f = fixture(t);
  // What hosts that bound services twice left behind: the migrated legacy
  // client secret under one namespace (unreadable to them), and a newer value
  // saved again under the repeated one.
  const dir = join(f.rootX, "secure-safe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "secure-safe-secrets.json"), JSON.stringify({
    "opaque:pkg.google:google:spc_x:client-secret": "client-secret",
    "opaque:pkg.task-trackers:task-trackers:spc_x:trello": "trello-old",
    "opaque:pkg.task-trackers:pkg.task-trackers:task-trackers:spc_x:trello": "trello-new",
    "opaque:pkg.gitlab:pkg.gitlab:gitlab:spc_x:account:g1": "gitlab-pat",
  }));
  registerPackage({ ...f.host, services: bindPackageServices(f.services, "secure-safe") } as ServerPackageHost);
  const vaultOf = (packageId: string) => bindPackageServices(f.services, packageId)
    .require(SPACE_SECURE_SAFE).forSpaceId("spc_x")!;

  assert.equal(vaultOf("google").getOpaque("google:spc_x:client-secret"), "client-secret");
  assert.equal(vaultOf("task-trackers").getOpaque("task-trackers:spc_x:trello"), "trello-new");
  assert.equal(vaultOf("gitlab").getOpaque("gitlab:spc_x:account:g1"), "gitlab-pat");
  vaultOf("google").putOpaque("google:spc_x:account:a1", "google-refresh");

  const disk = JSON.parse(readFileSync(join(dir, "secure-safe-secrets.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(disk).sort(), [
    "opaque:pkg.gitlab:gitlab:spc_x:account:g1",
    "opaque:pkg.google:google:spc_x:account:a1",
    "opaque:pkg.google:google:spc_x:client-secret",
    "opaque:pkg.task-trackers:task-trackers:spc_x:trello",
  ]);
  // A bound registry cannot be bound again: not for its own id (that nested
  // the namespace) and not for another package's (that would reach its keys).
  const gitlab = bindPackageServices(f.services, "gitlab");
  assert.throws(() => bindPackageServices(gitlab, "gitlab"), /already bound to "gitlab"/);
  assert.throws(() => bindPackageServices(gitlab, "google"), /already bound to "gitlab"/);
  assert.equal(gitlab.require(SPACE_SECURE_SAFE).forSpaceId("spc_x")!.getOpaque("google:spc_x:client-secret"), null);
});
