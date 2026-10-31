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

test("the Coach workspace resolves shared primitives through host.ui only", async () => {
  // The workspace, its panels, the rows, the proposal/insight cards and the
  // sidebar entry take every primitive from `host.ui.components`. The settings
  // page is the one deliberate exception: `PageHead`, `Switch` and
  // `confirmAlert` have no package-facing equivalent yet and every other
  // package's settings page imports them the same way.
  const root = resolve(import.meta.dirname, "../../..");
  const result = await build({
    entryPoints: [resolve(import.meta.dirname, "../widgets/CoachWorkspace.tsx")],
    bundle: true,
    platform: "browser",
    format: "esm",
    outdir: resolve(root, ".polyth-build-test"),
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const shellImports = Object.keys(result.metafile.inputs).filter((input) => input.includes("apps/web/src"));
  assert.deepEqual(shellImports, []);
});
