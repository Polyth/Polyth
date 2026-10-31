import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopServerPackages } from "../src/serverPackages.ts";
import { build } from "esbuild";
import { desktopServerPackagesPlugin, loadDesktopServerPackages } from "../serverPackageInventory.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const packagesDir = join(repositoryRoot, "packages");

test("desktop bundles every discovered server package with its manifest descriptor", async () => {
  // Only installed packages have a manifest; a leftover build directory (a
  // removed package's gitignored dist/_inbox) must not fail the discovery gate.
  const expected = (await Promise.all((await readdir(packagesDir)).sort().map(async (id) => {
    const manifest = await readFile(join(packagesDir, id, "package.json"), "utf8")
      .then((raw) => JSON.parse(raw) as {
        polyth?: { serverEntry?: string; descriptor?: Record<string, unknown> };
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "EISDIR") return null;
        throw error;
      });
    if (!manifest?.polyth?.serverEntry || !manifest.polyth.descriptor) return null;
    return { id, descriptor: { id, ...manifest.polyth.descriptor } };
  }))).filter((item): item is NonNullable<typeof item> => item !== null);

  assert.deepEqual(
    desktopServerPackages
      .map(({ id, descriptor }) => ({ id, descriptor }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    expected.filter((item): item is NonNullable<typeof item> => item !== null),
  );
  assert.ok(desktopServerPackages.every(({ factory }) => typeof factory === "function"));
});

test("bundled server inventory includes discovered factories without runtime directory discovery", async () => {
  const result = await build({
    entryPoints: [join(repositoryRoot, "apps/desktop/src/serverPackages.ts")],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [desktopServerPackagesPlugin(repositoryRoot)],
    // This test checks generated static imports; the main-process bundle check resolves their implementations.
    external: [join(packagesDir, "*")],
    logLevel: "silent",
  });
  const source = result.outputFiles[0]!.text;
  // Each package's own manifest entry, whatever packages are installed.
  for (const id of (await readdir(packagesDir)).sort()) {
    let manifest: { polyth?: { serverEntry?: string } };
    try {
      manifest = JSON.parse(await readFile(join(packagesDir, id, "package.json"), "utf8")) as typeof manifest;
    } catch {
      continue;
    }
    const entry = manifest.polyth?.serverEntry;
    if (!entry) continue;
    assert.ok(source.includes(`${id}/${entry.replace(/^\.\//, "")}`), `${id} server entry is bundled`);
  }
  assert.doesNotMatch(source, /discoverServerPackages|loadDesktopServerPackages|readdir/);
});

test("desktop discovery rejects a factory symlink outside its package", async (t) => {
  const scratch = join(repositoryRoot, ".scratch/judgment");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "desktop-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "packages/fixture");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@polyth/fixture", polyth: {
    serverEntry: "./entry.mjs", descriptor: { name: "Fixture", description: "Fixture", core: false, enabled: true, hasSettings: false },
  } }));
  await writeFile(join(root, "outside.mjs"), "export default () => ({});");
  await symlink(join(root, "outside.mjs"), join(dir, "entry.mjs"));
  await assert.rejects(loadDesktopServerPackages(root), /escapes its package/);
});


test("optional advanced packages stay disabled by default", () => {
  // Knowledge and Multirun became default-on with the curated defaults.
  const expectedDisabled = new Set([
    "fusion",
    "personal-coach",
    "recap",
    "walkthrough",
  ]);
  const byId = new Map(desktopServerPackages.map((item) => [item.id, item.descriptor]));
  // A checkout with removable packages deleted simply discovers fewer entries;
  // assert opt-in for the ones present and require at least one so the check
  // cannot pass vacuously.
  let present = 0;
  for (const id of expectedDisabled) {
    const descriptor = byId.get(id);
    if (!descriptor) continue;
    present += 1;
    assert.equal(descriptor.enabled, false, `${id} must be opt-in`);
  }
  assert.ok(present > 0, "at least one optional advanced package is present to check");
});
