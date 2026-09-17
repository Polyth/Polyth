import assert from "node:assert/strict";
import test from "node:test";
import type { SecureSafeService } from "@polyth/contracts";
import {
  createServerServiceRegistry,
  SPACE_SECURE_SAFE,
  type ServerPackageHost,
} from "../src/index.ts";
import { secretVault } from "../src/pluginRouteShared.ts";
import { memoryOpaqueVault } from "./helpers.ts";

test("package credential vault routes opaque keys to the owning Space safe", () => {
  const a = memoryOpaqueVault();
  const b = memoryOpaqueVault();
  const services = createServerServiceRegistry();
  services.provide(SPACE_SECURE_SAFE, {
    forSpace() { throw new Error("not used"); },
    forSpaceId(spaceId) {
      if (spaceId === "spc_a") return a as SecureSafeService;
      if (spaceId === "spc_b") return b as SecureSafeService;
      return undefined;
    },
  });
  const host = { services } as unknown as ServerPackageHost;
  const vault = secretVault(host);

  vault.putOpaque("pkgconn:spc_a:github:main", "token-a");
  vault.putOpaque("pkgconn:spc_b:github:main", "token-b");
  assert.equal(a.getOpaque("pkgconn:spc_a:github:main"), "token-a");
  assert.equal(a.getOpaque("pkgconn:spc_b:github:main"), null);
  assert.equal(b.getOpaque("pkgconn:spc_b:github:main"), "token-b");
  assert.equal(b.getOpaque("pkgconn:spc_a:github:main"), null);

  vault.deleteOpaqueByPrefix("pkgconn:spc_a:github:");
  assert.equal(a.getOpaque("pkgconn:spc_a:github:main"), null);
  assert.equal(b.getOpaque("pkgconn:spc_b:github:main"), "token-b");

  assert.throws(
    () => vault.putOpaque("pkgconn:spc_missing:github:main", "nope"),
    { code: "HOST_UNAVAILABLE" },
  );
});
