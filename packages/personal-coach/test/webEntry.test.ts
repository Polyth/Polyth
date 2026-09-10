import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";

test("Personal Coach web entry stays browser-safe and excludes the SQLite store", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const result = await build({
    entryPoints: [resolve(import.meta.dirname, "../widgets/index.tsx")],
    bundle: true,
    platform: "browser",
    format: "esm",
    outdir: resolve(root, ".polyth-build-test"),
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some((input) => input.endsWith("packages/personal-coach/widgets/index.tsx")));
  assert.equal(
    inputs.some((input) => input.endsWith("packages/personal-coach/src/index.ts")),
    false,
    "the browser graph must not resolve the Node-only SQLite Coach store",
  );
  assert.equal(
    inputs.some((input) => input.includes("node:sqlite")),
    false,
    "the browser graph must never include node:sqlite",
  );
});
