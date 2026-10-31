import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverServerPackages } from "../src/projectCompositionDiscovery.ts";

function packagesDir(t: { after(fn: () => void): void }, packages: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-former-ids-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [id, formerIds] of Object.entries(packages)) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, "package.json"), JSON.stringify({
      name: `@example/${id}`,
      polyth: {
        serverEntry: "./entry.ts",
        ...(formerIds === undefined ? {} : { formerIds }),
        descriptor: { name: id, description: id, core: false, enabled: true, hasSettings: false },
      },
    }));
  }
  return dir;
}

test("discovery reads polyth.formerIds and never claims a package that is present", async (t) => {
  const found = await discoverServerPackages(packagesDir(t, {
    agents: ["schedule", "planner", "schedule"],
    planner: undefined,
  }));
  const byId = new Map(found.map((pkg) => [pkg.id, pkg]));
  // `planner` is installed under its own id, so its data is never moved.
  assert.deepEqual(byId.get("agents")?.formerIds, ["schedule"]);
  assert.deepEqual(byId.get("planner")?.formerIds, []);
});

test("a malformed polyth.formerIds refuses discovery", async (t) => {
  for (const formerIds of ["schedule", ["Bad Id"], ["agents"], [""], Array.from({ length: 9 }, (_, i) => `old-${i}`)]) {
    await assert.rejects(() => discoverServerPackages(packagesDir(t, { agents: formerIds })), { code: "invalid-input" });
  }
});
