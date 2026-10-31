import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export async function writeHashedBundle(opts: {
  outDir: string;
  fileName: (integrity: string) => string;
  priorPattern: RegExp;
  contents: Uint8Array;
}): Promise<{ file: string; integrity: string }> {
  const integrity = createHash("sha256").update(opts.contents).digest("hex");
  const file = join(opts.outDir, opts.fileName(integrity));
  const temporary = join(opts.outDir, `.bundle-${randomBytes(8).toString("hex")}.tmp`);
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(temporary, opts.contents);
  await rename(temporary, file);
  for (const prior of await readdir(opts.outDir)) {
    if (prior !== basename(file) && opts.priorPattern.test(prior)) {
      await rm(join(opts.outDir, prior), { force: true });
    }
  }
  return { file, integrity };
}
