import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopServerPackages } from "../src/serverPackages.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const packagesDir = join(repositoryRoot, "packages");

test("desktop bundles every discovered server package with its manifest descriptor", async () => {
  const expected = await Promise.all((await readdir(packagesDir)).sort().map(async (id) => {
    const manifest = JSON.parse(await readFile(join(packagesDir, id, "package.json"), "utf8")) as {
      polyth?: { serverEntry?: string; descriptor?: Record<string, unknown> };
    };
    if (!manifest.polyth?.serverEntry || !manifest.polyth.descriptor) return null;
    return { id, descriptor: { id, ...manifest.polyth.descriptor } };
  }));

  assert.deepEqual(
    desktopServerPackages.map(({ id, descriptor }) => ({ id, descriptor })),
    expected.filter((item): item is NonNullable<typeof item> => item !== null),
  );
  assert.ok(desktopServerPackages.every(({ factory }) => typeof factory === "function"));
});
