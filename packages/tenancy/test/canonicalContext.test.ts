import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AuthPrincipal } from "@polyth/contracts";
import { createIdentityResolver, createSpaceResolver } from "../src/context.ts";
import { createTenancyStore } from "../src/store.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-canonical-context-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createTenancyStore({ file: join(dir, "tenancy.json") });
  store.createUser("Owner", "usr_owner");
  const home = store.createSpace({ name: "Personal", ownerId: "usr_owner", isDefault: true });
  store.createUser("Alice", "usr_alice");
  const identities = createIdentityResolver({
    ownerUserId: "usr_owner",
    deployment: "local-trusted",
    ambientOwner: false,
  });
  const resolver = createSpaceResolver({
    store,
    identities,
    dataDir: dir,
    deployment: "local-trusted",
    provisionMissing: false,
  });
  return { store, resolver, home };
}

test("canonical identity never turns loopback or internal service into the owner", (t) => {
  const { resolver } = fixture(t);
  assert.equal(resolver.identity({ kind: "local-user", trustedLoopback: true }), null);
  assert.equal(resolver.identity({ kind: "internal-service", serviceId: "polyth-control" }), null);
  assert.equal(resolver.identity({ kind: "ui-session", sessionId: "s", rememberedDeviceId: "d" }), null);
  assert.equal(resolver.identity({ kind: "paired-device", deviceId: "dev", deviceEndpointId: "ep", connectionId: "conn", transport: "direct", grants: [], grantRevision: 1 }), null);
});

test("canonical access requires an explicit active identity and existing membership", (t) => {
  const { store, resolver, home } = fixture(t);
  const owner = { kind: "ui-session", sessionId: "owner", rememberedDeviceId: "browser", userId: "usr_owner" } as AuthPrincipal & { userId: string };
  const alice = { kind: "ui-session", sessionId: "alice", rememberedDeviceId: "browser-2", userId: "usr_alice" } as AuthPrincipal & { userId: string };
  assert.equal(resolver.forPrincipal(owner).spaceId, home.id);
  assert.throws(() => resolver.forPrincipal(alice), { code: "not-found" });
  assert.deepEqual(store.spacesFor("usr_alice"), []);
});

test("canonical resolver refuses unknown explicit identities instead of provisioning them", (t) => {
  const { store, resolver } = fixture(t);
  const unknown = { kind: "ui-session", sessionId: "unknown", rememberedDeviceId: "browser-3", userId: "usr_missing" } as AuthPrincipal & { userId: string };
  assert.throws(() => resolver.forPrincipal(unknown), { code: "unauthorized" });
  assert.equal(store.user("usr_missing"), undefined);
});
