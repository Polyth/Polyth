// node --test type-strips .ts files but cannot execute JSX, so mounted
// component tests could never import a real .tsx page. This module-loader
// hook routes .tsx modules through esbuild's transform (same jsx: automatic
// the web build uses) — tests mount the actual components instead of
// test-only re-implementations. Register from a test file with:
//   import { register } from "node:module";
//   register("./tsxHooks.mjs", import.meta.url);
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if (!url.endsWith(".tsx")) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const source = await readFile(file, "utf8");
  const { code } = await transform(source, {
    loader: "tsx",
    jsx: "automatic",
    format: "esm",
    sourcefile: file,
  });
  return { format: "module", source: code, shortCircuit: true };
}
