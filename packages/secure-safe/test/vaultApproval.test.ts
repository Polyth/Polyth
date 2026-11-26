// Each Credential Vault key carries the person's approval level for agent runs
// that use it: Full access only by default, and only the four known levels.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureSafeService } from "../src/index.ts";

test("a key's approval level: Full access only by default, one of four levels, kept across edits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-vault-approval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vault = createSecureSafeService({ dataDir: dir });
  const plain = await vault.create({ handle: "DEPLOY", label: "Deploy", value: "v1" });
  assert.equal(plain.approval, "full");
  const safe = await vault.create({ handle: "STATUS", label: "Status", value: "v2", approval: "safe" });
  assert.equal(safe.approval, "safe");
  await assert.rejects(vault.create({ handle: "X", label: "X", value: "v", approval: "sometimes" as never }), { code: "invalid-input" });

  assert.equal((await vault.update(plain.id, { approval: "always" })).approval, "always");
  assert.equal((await vault.update(plain.id, { label: "Deploy key" })).approval, "always", "other edits keep it");
  await assert.rejects(vault.update(plain.id, { approval: "never" as never }), { code: "invalid-input" });
  // Persisted with the metadata, never next to a value.
  const reopened = createSecureSafeService({ dataDir: dir });
  assert.deepEqual(reopened.list().map((entry) => [entry.handle, entry.approval]), [["DEPLOY", "always"], ["STATUS", "safe"]]);
});
