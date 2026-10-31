// Playground ships disabled so nothing surfaces it until a user opts in. This
// is the package's own manifest contract; it lives here (split from
// apps/web/test/canvasOptIn.test.ts) because a host test must not name the
// removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("playground ships disabled so nothing surfaces it until a user opts in", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    polyth?: { descriptor?: { enabled?: boolean; core?: boolean } };
  };
  assert.equal(manifest.polyth?.descriptor?.core, false);
  assert.equal(manifest.polyth?.descriptor?.enabled, false);
});
