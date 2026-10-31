import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWebPackages } from "../webPackages.ts";

const fixture = (): Promise<string> => mkdtemp(join(tmpdir(), "polyth-web-packages-"));

async function writePackage(
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  entry = "export default () => () => () => undefined;",
): Promise<string> {
  const dir = join(root, id);
  await mkdir(join(dir, "widgets"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "widgets", "index.mjs"), entry);
  return dir;
}

test("web package discovery reads marked workspace manifests in stable order", async () => {
  const root = await fixture();
  await writePackage(root, "zeta", {
    name: "@example/zeta",
    polyth: { webEntry: "./widgets/index.mjs" },
  });
  await writePackage(root, "alpha", {
    name: "@example/alpha",
    polyth: { webEntry: "./widgets/index.mjs" },
  });
  await writePackage(root, "unmarked", { name: "@example/unmarked" });

  const packages = await discoverWebPackages(root);
  assert.deepEqual(packages.map((pkg) => pkg.id), ["alpha", "zeta"]);
  assert.deepEqual(packages.map((pkg) => pkg.packageName), ["@example/alpha", "@example/zeta"]);
  assert.ok(packages.every((pkg) => pkg.entryFile.endsWith("/widgets/index.mjs")));
});

test("web package discovery rejects invalid and escaping entries", async () => {
  const invalidRoot = await fixture();
  await writePackage(invalidRoot, "invalid", {
    polyth: { webEntry: "../outside.mjs" },
  });
  await assert.rejects(() => discoverWebPackages(invalidRoot), /relative path without/);

  const symlinkRoot = await fixture();
  const outside = join(symlinkRoot, "outside.mjs");
  await writeFile(outside, "export default () => () => () => undefined;");
  const dir = await writePackage(symlinkRoot, "escape", {
    polyth: { webEntry: "./widgets/index.mjs" },
  });
  await writeFile(join(dir, "widgets", "index.mjs"), "");
  await symlink(outside, join(dir, "widgets", "linked.mjs"));
  const manifest = {
    polyth: { webEntry: "./widgets/linked.mjs" },
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  await assert.rejects(() => discoverWebPackages(symlinkRoot), /escapes its package directory/);
});

test("missing web package roots discover as empty", async () => {
  assert.deepEqual(await discoverWebPackages("/definitely/missing/polyth-packages"), []);
});
