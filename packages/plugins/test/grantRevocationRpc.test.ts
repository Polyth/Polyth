import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ProjectService, SessionService, SpaceContext } from "@polyth/contracts";
import type { PackageManifest } from "@polyth/package-sdk/manifest";
import { grantCapabilities, writeGrants } from "../src/grants.ts";
import { invokePackageRpc } from "../src/packageRpc.ts";
import { testSpaceStorage } from "./helpers.ts";

test("persisted capability revocation takes effect on the very next RPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-grant-revoke-"));
  const storage = testSpaceStorage(root);
  const manifest = {
    manifestVersion: 1,
    id: "com-example-revoke",
    version: "1.0.0",
    display: { name: "Revoke", description: "test" },
    runtime: { kind: "sandboxed" },
    capabilities: [{ name: "storage.package" }, { name: "ui.render" }],
  } as PackageManifest;
  const deps = {
    space: { spaceId: "spc_a", userId: "usr_a" } as SpaceContext,
    storage,
    sessions: {} as SessionService,
    projects: {} as ProjectService,
    appendEvent: async () => ({}),
    manifest,
    enabled: true,
  };

  grantCapabilities(storage, manifest.id, [{ name: "storage.package" }]);
  await invokePackageRpc(deps, "storage.set", { key: "note", value: "allowed" });
  assert.equal(await invokePackageRpc(deps, "storage.get", { key: "note" }), "allowed");

  // Simulate an admin replacing the persisted grant set. No process/runtime
  // restart and no new deps object is allowed to preserve the stale authority.
  writeGrants(storage, manifest.id, [{
    name: "ui.render",
    grantedAt: Date.now(),
    grantedBy: "usr_admin",
  }]);

  await assert.rejects(
    invokePackageRpc(deps, "storage.get", { key: "note" }),
    { code: "CAPABILITY_DENIED" },
  );
});
