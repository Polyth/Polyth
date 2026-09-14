import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageConnectionContribution } from "@polyth/package-sdk/manifest";
import {
  connectionAuthorization,
  listPublicConnections,
  setTokenConnection,
  type PackageOpaqueVault,
} from "../src/connections.ts";
import { approveConnectionDefinitions } from "../src/grants.ts";
import { testSpaceStorage } from "./helpers.ts";

function memoryVault(): PackageOpaqueVault {
  const values = new Map<string, string>();
  return {
    putOpaque: (key, value) => { values.set(key, value); },
    getOpaque: (key) => values.get(key) ?? null,
    deleteOpaque: (key) => { values.delete(key); },
    deleteOpaqueByPrefix: (prefix) => {
      for (const key of [...values.keys()]) if (key.startsWith(prefix)) values.delete(key);
    },
  };
}

const connection = (origin: string): PackageConnectionContribution => ({
  id: "tracker",
  label: "Tracker",
  kind: "token",
  origins: [origin],
});

test("approving a changed connection fingerprint disconnects the old credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-connection-rotation-"));
  const storage = testSpaceStorage(root);
  const vault = memoryVault();
  const scope = { storage, spaceId: "space-a", vault };
  const oldSpec = connection("https://old.example");
  const nextSpec = connection("https://new.example");

  approveConnectionDefinitions(storage, "com-example", [oldSpec], [oldSpec.id]);
  await setTokenConnection(scope, "com-example", oldSpec, "old-secret");
  assert.deepEqual(await connectionAuthorization(scope, "com-example", oldSpec), {
    header: "authorization",
    value: "Bearer old-secret",
  });

  approveConnectionDefinitions(storage, "com-example", [nextSpec], [nextSpec.id]);
  assert.equal(listPublicConnections(storage, "com-example", [nextSpec])[0]?.status, "disconnected");
  assert.equal(await connectionAuthorization(scope, "com-example", nextSpec), null);

  await setTokenConnection(scope, "com-example", nextSpec, "new-secret");
  assert.deepEqual(await connectionAuthorization(scope, "com-example", nextSpec), {
    header: "authorization",
    value: "Bearer new-secret",
  });
});

test("re-approving an unchanged fingerprint preserves a connected credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-connection-stable-"));
  const storage = testSpaceStorage(root);
  const vault = memoryVault();
  const scope = { storage, spaceId: "space-a", vault };
  const spec = connection("https://api.example");

  approveConnectionDefinitions(storage, "com-example", [spec], [spec.id]);
  await setTokenConnection(scope, "com-example", spec, "same-secret");
  approveConnectionDefinitions(storage, "com-example", [spec], [spec.id]);

  assert.equal(listPublicConnections(storage, "com-example", [spec])[0]?.status, "connected");
  assert.deepEqual(await connectionAuthorization(scope, "com-example", spec), {
    header: "authorization",
    value: "Bearer same-secret",
  });
});
