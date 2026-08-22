import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, "../src/shared");

test("built React import-map shims preserve every runtime ESM export", async () => {
  const expected = {
    react: Object.keys(await import("react")).sort(),
    "react-dom": Object.keys(await import("react-dom")).sort(),
    "react-dom-client": Object.keys(await import("react-dom/client")).sort(),
    "react-jsx-runtime": Object.keys(await import("react/jsx-runtime")).sort(),
    "react-jsx-dev-runtime": Object.keys(await import("react/jsx-dev-runtime")).sort(),
  };

  const result = await build({
    entryPoints: {
      react: join(shared, "react.ts"),
      "react-dom": join(shared, "react-dom.ts"),
      "react-dom-client": join(shared, "react-dom-client.ts"),
      "react-jsx-runtime": join(shared, "react-jsx-runtime.ts"),
      "react-jsx-dev-runtime": join(shared, "react-jsx-dev-runtime.ts"),
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    outdir: join(here, ".react-shim-test"),
    write: false,
    metafile: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });

  for (const [entryName, exports] of Object.entries(expected)) {
    const output = Object.entries(result.metafile.outputs)
      .find(([path]) => path.endsWith(`/${entryName}.js`))?.[1];
    assert.ok(output, `missing build output for ${entryName}`);
    assert.deepEqual([...output.exports].sort(), exports, `${entryName} export surface`);
  }
});
