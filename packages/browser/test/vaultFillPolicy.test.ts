import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import {
  allowBrowserVaultFill,
  clearBrowserVaultFillApprovals,
  isBrowserVaultFillAllowed,
  readBrowserVaultFillApprovals,
} from "../src/vaultFillPolicy.ts";

function storage(): SpaceStorage {
  const root = mkdtempSync(join(tmpdir(), "polyth-browser-vault-policy-"));
  return {
    root,
    packageDir(packageId) {
      const path = join(root, "packages", packageId);
      return path;
    },
    path(relative) { return join(root, relative); },
  };
}

const request = {
  spaceId: "space-a",
  projectId: "project-a",
  handle: "UI_PASSWORD",
  origin: "https://polyth.example.com",
} as const;

test("browser vault-fill approvals are persistent but scoped to Space, project, handle, and origin", async () => {
  const store = storage();
  assert.equal(await isBrowserVaultFillAllowed(store, request), false);
  await allowBrowserVaultFill(store, request);
  await allowBrowserVaultFill(store, request);

  assert.equal(await isBrowserVaultFillAllowed(store, request), true);
  assert.equal(await isBrowserVaultFillAllowed(store, { ...request, projectId: "project-b" }), false);
  assert.equal(await isBrowserVaultFillAllowed(store, { ...request, handle: "OTHER" }), false);
  assert.equal(await isBrowserVaultFillAllowed(store, { ...request, origin: "https://other.example" }), false);

  const rows = await readBrowserVaultFillApprovals(store);
  assert.deepEqual(rows.map(({ spaceId, projectId, handle, origin }) => ({ spaceId, projectId, handle, origin })), [request]);
  assert.doesNotMatch(readFileSync(join(store.packageDir("browser"), "vault-fill-approvals.json"), "utf8"), /secret|plaintext|value/i);

  await clearBrowserVaultFillApprovals(store);
  assert.equal(await isBrowserVaultFillAllowed(store, request), false);
});
