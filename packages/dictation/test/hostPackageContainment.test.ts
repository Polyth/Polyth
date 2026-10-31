// Moved from apps/web/test/packageContainment.test.ts: the host must not name
// a removable package, so dictation's own browser-graph boundary is checked
// here. Assertions are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const packagesDir = join(root, "packages");

test("dictation web entry resolves only its browser-safe public surface", async () => {
  const result = await build({
    entryPoints: [join(packagesDir, "dictation/widgets/index.tsx")],
    bundle: true,
    platform: "browser",
    format: "esm",
    outdir: join(root, ".polyth-build-test"),
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some((input) => input.endsWith("packages/dictation/src/browser.ts")));
  assert.equal(
    inputs.some((input) => input.endsWith("packages/dictation/src/localModels.ts")),
    false,
    "the browser graph must not include the Node-only local model manager",
  );
});
