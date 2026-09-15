import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

export async function load(url, context, nextLoad) {
  // Shared UI primitives ship their own stylesheets; Node cannot execute a
  // .css module, and the style bytes are irrelevant to behaviour tests.
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
