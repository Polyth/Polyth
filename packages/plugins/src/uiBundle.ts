import { createHash } from "node:crypto";
import { rename, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { build } from "esbuild";

const EXTERNAL_REACT = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

/**
 * Builds a browser-loadable plugin module. UI entries must export:
 *
 *   export const modules: Record<string, ComponentType<Record<string, unknown>>>;
 *
 * React stays external so the browser import map gives plugins the host's
 * shared React instance.
 */
export async function buildUiBundle(opts: {
  installDir: string;
  entryPath: string;
  outDir: string;
}): Promise<{ file: string; integrity: string }> {
  const installDir = await realpath(opts.installDir);
  const requested = resolve(installDir, opts.entryPath);
  if (!inside(installDir, requested)) {
    throw new Error("ui entry escapes the plugin install directory");
  }

  const entry = await realpath(requested);
  if (!inside(installDir, entry)) {
    throw new Error("ui entry escapes the plugin install directory");
  }
  if (!(await stat(entry)).isFile()) {
    throw new Error("ui entry must resolve to a file");
  }

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    external: EXTERNAL_REACT,
    write: false,
    outfile: join(opts.outDir, "ui.mjs"),
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("ui bundle produced no output");

  const integrity = createHash("sha256").update(output.contents).digest("hex");
  const file = join(opts.outDir, `ui-${integrity}.mjs`);
  const temporary = join(opts.outDir, `.ui-${process.pid}-${Date.now()}.mjs`);
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(temporary, output.contents);
  await rename(temporary, file);

  for (const prior of await readdir(opts.outDir)) {
    if (prior !== basename(file) && /^ui-[a-f0-9]{64}\.mjs$/.test(prior)) {
      await rm(join(opts.outDir, prior), { force: true });
    }
  }
  return { file, integrity };
}
