import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalSecurity,
  isDirectInternalCoreEntrypoint,
} from "../../packages/server/src/runtimeSecurity.ts";

const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
const serverPackage = JSON.parse(readFileSync(new URL("../../packages/server/package.json", import.meta.url), "utf8")) as {
  exports: Record<string, string>;
};
const supervisor = readFileSync(new URL("../supervisor.ts", import.meta.url), "utf8");
const core = fileURLToPath(new URL("../../packages/server/src/indexCore.ts", import.meta.url));
const canonical = fileURLToPath(new URL("../../packages/server/src/index.ts", import.meta.url));

test("direct internal composition-root execution requires canonical bootstrap", () => {
  assert.equal(isDirectInternalCoreEntrypoint(core), true);
  assert.equal(isDirectInternalCoreEntrypoint(canonical), false);

  const previous = process.argv[1];
  process.argv[1] = core;
  try {
    assert.throws(
      () => canonicalSecurity(),
      (error: Error & { code?: string }) => error.code === "canonical-entrypoint-required",
    );
  } finally {
    if (previous === undefined) process.argv.splice(1, 1);
    else process.argv[1] = previous;
  }
});

test("supported server launch surfaces use the canonical bootstrap", () => {
  assert.match(rootPackage.scripts.start ?? "", /packages\/server\/src\/index\.ts/);
  assert.doesNotMatch(rootPackage.scripts.start ?? "", /indexCore\.ts/);
  assert.match(rootPackage.scripts.dev ?? "", /packages\/server\/src\/index\.ts/);
  assert.doesNotMatch(rootPackage.scripts.dev ?? "", /indexCore\.ts/);
  assert.equal(serverPackage.exports["."], "./src/index.ts");
  assert.match(supervisor, /packages\/server\/src\/index\.ts/);
  assert.doesNotMatch(supervisor, /serverEntry\s*=.*indexCore\.ts/);
});
