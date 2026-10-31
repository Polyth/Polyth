import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";

test("Judgment's root and settings browser graphs cannot import an SDK or server authority", async () => {
  for (const entry of ["src/index.ts", "widgets/index.tsx"]) {
    const result = await build({ entryPoints: [resolve(import.meta.dirname, "..", entry)],
      bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
      outdir: resolve(import.meta.dirname, "../../../.scratch/judgment/boundary-build"), logLevel: "silent" });
    const inputs = Object.keys(result.metafile.inputs);
    assert.equal(inputs.some((path) => /judgment-jev|@typesafe-ai|judgment\/src\/server|secure-safe\/src\/(index|serverEntry)\.ts/.test(path)), false);
  }
});
