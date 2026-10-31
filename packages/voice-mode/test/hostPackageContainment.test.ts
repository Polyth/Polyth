// Moved from apps/web/test/packageContainment.test.ts: the host must not name
// a removable package. Voice mode declares dictation, so the browser-graph
// boundary between the two lives with its declared dependent. Assertions are
// unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const packagesDir = join(root, "packages");

test("voice mode reaches dictation only through its browser-safe exports", async () => {
  const result = await build({
    entryPoints: [join(packagesDir, "voice-mode/widgets/index.tsx")],
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
  assert.ok(inputs.some((input) => input.endsWith("packages/dictation/widgets/voiceRuntime.ts")));
  for (const nodeOnly of ["localModels.ts", "localRuntime.ts", "localNemotron.ts", "serverEntry.ts"]) {
    assert.equal(
      inputs.some((input) => input.endsWith(`packages/dictation/src/${nodeOnly}`)),
      false,
      `the voice mode browser graph must not include dictation's Node-only ${nodeOnly}`,
    );
  }
  assert.equal(
    inputs.some((input) => input.endsWith("packages/dictation/widgets/voice.tsx")),
    false,
    "voice mode does not import the dictation UI module (separate bundles share no state)",
  );
});
