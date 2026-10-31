import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountLimits, AuthPrincipal, HarnessAccessRule, HarnessSelection, RequestIngress, SessionService, SpaceContext } from "@polyth/contracts";
import {
  BOOTSTRAP_USER_ID,
  createIdentityResolver,
  createSpaceResolver,
  createTenancyStore,
} from "@polyth/tenancy";
import { privateHarnessSessionService } from "../src/accountPermissions.ts";
import { limitedSessionService, type LimitsAuthority } from "../src/accountLimits.ts";
import { createAuthService, type AuthRequestLike } from "../src/auth.ts";
import { personDefaultSessionService } from "../src/personHarnessDefault.ts";
import { createClientSettings } from "../src/clientSettings.ts";
import { createProjectService } from "../src/projects.ts";

const ingress: Extract<RequestIngress, { kind: "public-http" }> = {
  kind: "public-http",
  listenerId: "test",
  loopback: false,
  secure: false,
};

const requestFor = (token: string): AuthRequestLike => ({
  headers: { cookie: `polyth_auth=${token}`, "user-agent": "account-test" },
  socket: { remoteAddress: "10.0.0.20" },
});

const login = (auth: ReturnType<typeof createAuthService>, userId: string, password: string): string => {
  const result = auth.login(password, "10.0.0.20", "account-test", userId);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("login failed");
  return result.token;
};

function tenancyFor(dataDir: string) {
  const store = createTenancyStore({ file: join(dataDir, "tenancy.json") });
  if (!store.user(BOOTSTRAP_USER_ID)) {
    store.createUser("Owner", BOOTSTRAP_USER_ID);
    store.createSpace({ name: "Personal", ownerId: BOOTSTRAP_USER_ID, isDefault: true });
  }
  const identities = createIdentityResolver({
    ownerUserId: BOOTSTRAP_USER_ID,
    deployment: "server-trusted",
  });
  return {
    store,
    resolver: createSpaceResolver({
      store,
      identities,
      dataDir,
      deployment: "server-trusted",
    }),
  };
}

test("same server keeps two authenticated accounts isolated across projects, settings, and restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-multi-user-"));
  const authFile = join(dataDir, "auth.json");
  const auth = createAuthService({ file: authFile });
  auth.setPassword("usr_alice", "alice-password");
  auth.setPassword("usr_bob", "bob-password");

  const aliceToken = login(auth, "usr_alice", "alice-password");
  const bobToken = login(auth, "usr_bob", "bob-password");
  const alicePrincipal = auth.resolve(requestFor(aliceToken), ingress).principal;
  const bobPrincipal = auth.resolve(requestFor(bobToken), ingress).principal;

  const first = tenancyFor(dataDir);
  const alice = first.resolver.forPrincipal(alicePrincipal);
  const bob = first.resolver.forPrincipal(bobPrincipal);
  assert.equal(alice.userId, "usr_alice");
  assert.equal(bob.userId, "usr_bob");
  assert.notEqual(alice.spaceId, bob.spaceId);
  assert.equal(first.store.spacesFor("usr_alice").length, 1);
  assert.equal(first.store.spacesFor("usr_bob").length, 1);

  const projects = createProjectService(dataDir);
  const aliceDir = join(dataDir, "alice-project");
  const bobDir = join(dataDir, "bob-project");
  mkdirSync(aliceDir);
  mkdirSync(bobDir);
  const aliceProject = await projects.forSpace(alice).add(aliceDir, "Alice");
  const bobProject = await projects.forSpace(bob).add(bobDir, "Bob");
  assert.deepEqual((await projects.forSpace(alice).list()).map((project) => project.id), [aliceProject.id]);
  assert.deepEqual((await projects.forSpace(bob).list()).map((project) => project.id), [bobProject.id]);
  assert.equal(await projects.forSpace(alice).get(bobProject.id), undefined);
  assert.equal(await projects.forSpace(bob).get(aliceProject.id), undefined);

  const settingsFile = join(dataDir, "client-settings.json");
  const settings = createClientSettings({ file: settingsFile });
  settings.put("usr_alice", { theme: "light", marker: "alice" });
  settings.put("usr_bob", { theme: "dark", marker: "bob" });
  assert.equal(settings.get("usr_alice").settings.marker, "alice");
  assert.equal(settings.get("usr_bob").settings.marker, "bob");
  assert.deepEqual(settings.get().settings, {}, "server-global code gets no ambient user's settings");

  const aliceWork = first.store.createSpace({ name: "Work", ownerId: "usr_alice" });
  first.resolver.remember(alicePrincipal, aliceWork.id);

  const restartedAuth = createAuthService({ file: authFile });
  const restarted = tenancyFor(dataDir);
  const restoredAlice = restarted.resolver.forPrincipal(
    restartedAuth.resolve(requestFor(aliceToken), ingress).principal,
  );
  const restoredBob = restarted.resolver.forPrincipal(
    restartedAuth.resolve(requestFor(bobToken), ingress).principal,
  );
  assert.equal(restoredAlice.userId, "usr_alice");
  assert.equal(restoredAlice.spaceId, aliceWork.id, "Alice restores her own selected Space");
  assert.equal(restoredBob.userId, "usr_bob");
  assert.equal(restoredBob.spaceId, bob.spaceId, "Bob keeps his independent default Space");

  const restartedSettings = createClientSettings({ file: settingsFile });
  assert.equal(restartedSettings.get("usr_alice").settings.marker, "alice");
  assert.equal(restartedSettings.get("usr_bob").settings.marker, "bob");

  const authDisk = readFileSync(authFile, "utf8");
  assert.equal(authDisk.includes("alice-password"), false);
  assert.equal(authDisk.includes("bob-password"), false);
  assert.equal(authDisk.includes(aliceToken), false);
  assert.equal(authDisk.includes(bobToken), false);
});

test("account switching is principal switching, and paired identity stays bound to its owner", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-account-switch-"));
  const auth = createAuthService({ file: join(dataDir, "auth.json") });
  auth.setPassword("usr_alice", "alice-password");
  auth.setPassword("usr_bob", "bob-password");
  const aliceToken = login(auth, "usr_alice", "alice-password");
  const bobToken = login(auth, "usr_bob", "bob-password");

  const { resolver } = tenancyFor(dataDir);
  assert.equal(resolver.forPrincipal(auth.resolve(requestFor(aliceToken), ingress).principal).userId, "usr_alice");
  assert.equal(resolver.forPrincipal(auth.resolve(requestFor(bobToken), ingress).principal).userId, "usr_bob");

  const paired = {
    kind: "paired-device",
    deviceId: "device-bob",
    deviceEndpointId: "endpoint-bob",
    connectionId: "connection-bob",
    transport: "direct",
    grants: [],
    grantRevision: 1,
    userId: "usr_bob",
  } as AuthPrincipal & { userId: string };
  assert.equal(resolver.forPrincipal(paired).userId, "usr_bob");
});

test("two people in one Space keep their own harness profiles and defaults; a foreign Space gets neither", async () => {
  const created: Array<{ by: string; harness: string }> = [];
  const base = (by: string) => ({
    async create(input: { harness?: HarnessSelection }) {
      created.push({ by, harness: input.harness?.mode === "pinned" ? input.harness.harnessId : "auto" });
      return { id: "s1" };
    },
    async snapshot() { return { harness: { mode: "pinned", harnessId: "claude" } }; },
  }) as unknown as SessionService;
  // Ida's private login, and a shared login limited to Ida and Bob in the shared Space.
  const access = () => new Map<string, HarnessAccessRule>([
    ["claude-ida", { accountOwnerUserId: "usr_ira" }],
    ["claude-team", { accountAllowedUserIds: ["usr_ira", "usr_bob"], accountAllowedSpaceIds: ["spc_shared"] }],
  ]);
  const limits: Record<string, AccountLimits | null> = {
    usr_ira: null,
    usr_bob: { projects: null, harnesses: ["claude", "claude-team"], messagesPerDay: null, chatsPerDay: null },
  };
  const authority: LimitsAuthority = { forUser: (id) => limits[id] ?? null, consume: () => "day", refund: () => {} };
  // Each person's saved default, already filtered by the resolver to what is
  // usable for them in the context's Space (harness-runtime's job).
  const defaults: Record<string, string> = { usr_ira: "claude-ida", usr_bob: "claude-team" };
  const usable = (userId: string, spaceId: string, harnessId: string) => {
    const rule = access().get(harnessId);
    if (rule?.accountOwnerUserId) return rule.accountOwnerUserId === userId;
    return !rule?.accountAllowedSpaceIds || rule.accountAllowedSpaceIds.includes(spaceId);
  };
  // The Space facade order: person default, account limits, restricted accounts.
  const sessionsFor = (userId: string, spaceId: string) => {
    const ctx = { userId, spaceId } as SpaceContext;
    return personDefaultSessionService(
      limitedSessionService(privateHarnessSessionService(base(userId), ctx, access), ctx, authority, access),
      ctx,
      async (c) => usable(c.userId, c.spaceId, defaults[c.userId]!) ? defaults[c.userId] : undefined,
    );
  };
  const pinned = (harnessId: string) => ({ mode: "pinned", harnessId }) as HarnessSelection;

  await sessionsFor("usr_ira", "spc_shared").create({ projectId: "p" });
  await sessionsFor("usr_bob", "spc_shared").create({ projectId: "p" });
  // Bob's default is not usable in his own Space: his limits' first entry applies.
  await sessionsFor("usr_bob", "spc_bob").create({ projectId: "p" });
  assert.deepEqual(created, [
    { by: "usr_ira", harness: "claude-ida" },
    { by: "usr_bob", harness: "claude-team" },
    { by: "usr_bob", harness: "claude" },
  ]);
  // Foreign person, foreign Space: refused even when named explicitly.
  await assert.rejects(sessionsFor("usr_bob", "spc_shared").create({ projectId: "p", harness: pinned("claude-ida") }), { code: "forbidden" });
  await assert.rejects(sessionsFor("usr_bob", "spc_bob").create({ projectId: "p", harness: pinned("claude-team") }), { code: "forbidden" });
  await assert.rejects(sessionsFor("usr_carol", "spc_shared").create({ projectId: "p", harness: pinned("claude-team") }), { code: "forbidden" });
  assert.equal(created.length, 3);
});
