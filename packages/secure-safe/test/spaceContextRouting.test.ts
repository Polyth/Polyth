import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SecureSafeService, SpaceContext } from "@polyth/contracts";
import {
  configureSecureSafeSpaceRouting,
  createSecureSafeService,
  runWithSecureSafeSpace,
} from "../src/index.ts";

const ctx = (spaceId: string, storageDir: string): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId: `usr_${spaceId}`,
  role: "owner",
  deployment: "server-trusted",
  storageDir,
});

test("a root Secure Safe routes identical handles to the active trusted Space", async t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-root-safe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const a = ctx("spc_a", join(root, "a"));
  const b = ctx("spc_b", join(root, "b"));
  const safeA = createSecureSafeService({ dataDir: join(a.storageDir, "secure-safe"), localOnly: true });
  const safeB = createSecureSafeService({ dataDir: join(b.storageDir, "secure-safe"), localOnly: true });
  const bySpace = new Map<string, SecureSafeService>([[a.spaceId, safeA], [b.spaceId, safeB]]);
  configureSecureSafeSpaceRouting((space) => bySpace.get(space.spaceId));

  const routed = createSecureSafeService({ dataDir: join(root, "legacy-root") });
  await runWithSecureSafeSpace(a, () => routed.upsertByHandle({
    handle: "API_TOKEN",
    label: "API token",
    kind: "token",
    value: "token-space-a",
  }));
  await runWithSecureSafeSpace(b, () => routed.upsertByHandle({
    handle: "API_TOKEN",
    label: "API token",
    kind: "token",
    value: "token-space-b",
  }));

  assert.equal(safeA.list().length, 1);
  assert.equal(safeB.list().length, 1);
  assert.equal(safeA.redact?.("token-space-a token-space-b"), "[redacted] token-space-b");
  assert.equal(safeB.redact?.("token-space-a token-space-b"), "token-space-a [redacted]");
  assert.equal(runWithSecureSafeSpace(a, () => routed.hasHandle("API_TOKEN")), true);
  assert.equal(runWithSecureSafeSpace(b, () => routed.hasHandle("API_TOKEN")), true);

  // A callback without a trusted Space may only inspect the legacy root. It
  // must not discover handles merely because another Space opened them.
  assert.equal(routed.hasHandle("API_TOKEN"), false);
  assert.equal(routed.list().length, 0);

  // Background sanitizer is intentionally conservative: over-redact known
  // plaintext from every opened physical safe rather than leak either value.
  assert.equal(routed.redact?.("token-space-a token-space-b"), "[redacted] [redacted]");
});
