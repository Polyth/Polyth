import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlPlane } from "../src/index.ts";

test("runtime system principal has no ambient human or tenant authority", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-runtime-system-principal-"));
  const control = openControlPlane({ directory: root });
  t.after(() => {
    control.close();
    rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(control.get<{ kind: string; status: string }>(
    "SELECT kind,status FROM principals WHERE id='system:polyth-runtime'",
  ), { kind: "system", status: "active" });
  assert.equal(control.get("SELECT 1 FROM users WHERE id='system:polyth-runtime'"), undefined);
  assert.equal(control.get("SELECT 1 FROM password_credentials WHERE user_id='system:polyth-runtime'"), undefined);
  assert.equal(control.get("SELECT 1 FROM instance_roles WHERE user_id='system:polyth-runtime'"), undefined);
  assert.equal(control.get("SELECT 1 FROM organization_memberships WHERE user_id='system:polyth-runtime'"), undefined);
  assert.equal(control.get("SELECT 1 FROM space_memberships WHERE principal_id='system:polyth-runtime'"), undefined);
});
