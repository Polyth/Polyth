import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthPrincipal, RequestIngress } from "@polyth/contracts";
import {
  BOOTSTRAP_USER_ID,
  createIdentityResolver,
  createSpaceResolver,
  createTenancyStore,
} from "@polyth/tenancy";
import { createAuthService, type AuthRequestLike } from "../src/auth.ts";
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
