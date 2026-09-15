import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageConnectionContribution } from "@polyth/package-sdk/manifest";
import { connectionReviewItems } from "../src/connectionFingerprint.ts";
import {
  connectionAuthorization,
  listPublicConnections,
  retireConnectionIds,
  setTokenConnection,
} from "../src/connections.ts";
import {
  approveConnectionDefinitions,
  readConnectionFingerprints,
  retireConnectionApprovals,
} from "../src/grants.ts";
import { memoryOpaqueVault, testSpaceStorage } from "./helpers.ts";

const spec: PackageConnectionContribution = {
  id: "tracker",
  label: "Tracker",
  kind: "token",
  origins: ["https://api.example.com"],
};

test("removed connections cannot resurrect an old credential when the id returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-connection-remove-"));
  const storage = testSpaceStorage(join(root, "space"));
  const vault = memoryOpaqueVault();
  const packageId = "com-example";
  const spaceId = "space-a";
  const scope = { storage, spaceId, vault };

  approveConnectionDefinitions(storage, packageId, [spec], [spec.id]);
  await setTokenConnection(scope, packageId, spec, "old-secret");
  assert.equal(listPublicConnections(storage, packageId, [spec])[0]?.status, "connected");
  assert.ok(readConnectionFingerprints(storage, packageId)[spec.id]);
  assert.ok(await connectionAuthorization(scope, packageId, spec));

  retireConnectionApprovals(storage, packageId, [spec.id]);
  await retireConnectionIds(vault, storage, packageId, spaceId, [spec.id]);

  assert.equal(readConnectionFingerprints(storage, packageId)[spec.id], undefined);
  assert.equal(listPublicConnections(storage, packageId, [spec])[0]?.status, "disconnected");
  await assert.rejects(
    () => connectionAuthorization(scope, packageId, spec),
    (error: Error & { code?: string }) => error.code === "CAPABILITY_DENIED",
  );

  const review = connectionReviewItems([], [spec], readConnectionFingerprints(storage, packageId));
  assert.equal(review.length, 1);
  assert.equal(review[0]?.id, spec.id);
  assert.equal(review[0]?.kind, "new");
});
