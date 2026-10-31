import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bundlePackageAssets } from "../scripts/bundle-package-assets.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "polyth-bundle-packages-"));
  const webDist = join(root, "web");
  const packagesDir = join(root, "packages");
  const ios = join(root, "ios-public");
  const android = join(root, "android-public");
  await Promise.all([webDist, ios, android].map((dir) => mkdir(dir, { recursive: true })));
  for (const id of ["alpha", "beta"]) {
    const dist = join(packagesDir, id, "dist", "web");
    await mkdir(join(dist, "chunks"), { recursive: true });
    await writeFile(join(dist, "entry.js"), `export default "${id}";\n`);
    await writeFile(join(dist, "entry.css"), ".x{}\n");
    await writeFile(join(dist, "entry.js.map"), "{}");
    await writeFile(join(dist, "package-manifest.json"), "{}");
  }
  await writeFile(join(packagesDir, "beta", "dist", "web", "chunks", "dep.js"), "export {};\n");
  await writeFile(join(webDist, "packages-manifest.json"), JSON.stringify({
    packages: ["alpha", "beta"].map((id) => ({
      id,
      module: `/packages/${id}/entry.js`,
      styles: [`/packages/${id}/entry.css?b=1`],
    })),
  }));
  return { root, webDist, packagesDir, ios, android };
}

test("copies each manifest package (entry, styles, chunks) into every public dir at the manifest paths", async () => {
  const { root, webDist, packagesDir, ios, android } = await fixture();
  try {
    const result = await bundlePackageAssets({ webDist, packagesDir, publicDirs: [ios, android] });
    assert.equal(result.packages, 2);
    assert.equal(result.files, 5, "alpha: entry.js+css, beta: entry.js+css+chunk; maps and the build manifest are excluded");
    for (const target of [ios, android]) {
      assert.equal(await readFile(join(target, "packages/alpha/entry.js"), "utf8"), 'export default "alpha";\n');
      assert.ok((await stat(join(target, "packages/beta/entry.css"))).isFile());
      assert.ok((await stat(join(target, "packages/beta/chunks/dep.js"))).isFile());
      await assert.rejects(stat(join(target, "packages/alpha/entry.js.map")));
      await assert.rejects(stat(join(target, "packages/alpha/package-manifest.json")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails loudly when a manifest-listed file is missing or no public dir exists", async () => {
  const { root, webDist, packagesDir, ios } = await fixture();
  try {
    await rm(join(packagesDir, "beta", "dist", "web", "entry.css"));
    await assert.rejects(
      bundlePackageAssets({ webDist, packagesDir, publicDirs: [ios] }),
      /beta: manifest lists \/packages\/beta\/entry\.css\?b=1 but .* is missing/,
    );
    await assert.rejects(
      bundlePackageAssets({ appRoot: join(root, "no-app"), webDist, packagesDir }),
      /no Capacitor public directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
