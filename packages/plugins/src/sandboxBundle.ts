import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { confineBundlePlugin } from "./confineBundle.ts";
import { writeHashedBundle } from "./hashedBundle.ts";

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

const sdkEntry = fileURLToPath(new URL("../../package-sdk/src/public.ts", import.meta.url));

export async function buildSandboxBundle(opts: {
  installDir: string;
  entryPath: string;
  outDir: string;
}): Promise<{ file: string; integrity: string }> {
  const installDir = await realpath(opts.installDir);
  const requested = resolve(installDir, opts.entryPath);
  if (!inside(installDir, requested)) throw new Error("ui entry escapes the plugin install directory");
  const entry = await realpath(requested);
  if (!inside(installDir, entry)) throw new Error("ui entry escapes the plugin install directory");
  if (!(await stat(entry)).isFile()) throw new Error("ui entry must resolve to a file");
  const sdkRoot = await realpath(fileURLToPath(new URL("../../package-sdk/src", import.meta.url)));
  const contractsRoot = await realpath(fileURLToPath(new URL("../../contracts/src", import.meta.url)));

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    outfile: join(opts.outDir, "sandbox.js"),
    logLevel: "silent",
    alias: { "@polyth/package-sdk": sdkEntry },
    plugins: [confineBundlePlugin({ installDir, allowedRoots: [installDir, sdkRoot, contractsRoot] })],
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("sandbox bundle produced no output");
  return writeHashedBundle({
    outDir: opts.outDir,
    fileName: (integrity) => `sandbox-${integrity}.js`,
    priorPattern: /^sandbox-[a-f0-9]{64}\.js$/,
    contents: output.contents,
  });
}
