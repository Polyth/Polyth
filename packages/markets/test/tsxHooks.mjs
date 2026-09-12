import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

// Node cannot strip JSX from .tsx; transform it with the repo's esbuild so
// package layout tests can import the real component instead of regexing it.
export async function load(url, context, nextLoad) {
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
