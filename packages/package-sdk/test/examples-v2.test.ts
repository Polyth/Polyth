import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePackageManifestJson, requiredAssets } from "../src/manifest.ts";

const examples = [
  "task-provider-extension",
  "tool-renderer-extension",
  "utility-extension",
];

test("v2 examples parse and use only public package SDK imports", () => {
  for (const name of examples) {
    const root = join(import.meta.dirname, `../../../examples/${name}`);
    const parsed = parsePackageManifestJson(readFileSync(join(root, "polyth-package.json"), "utf8"));
    assert.equal(parsed.ok, true, name);
    if (!parsed.ok) continue;
    assert.equal(parsed.manifest.manifestVersion, 2, name);
    assert.equal(parsed.manifest.runtime?.kind, "sandboxed", name);
    for (const asset of requiredAssets(parsed.manifest)) {
      assert.ok(existsSync(join(root, asset)), `${name}: missing ${asset}`);
      const source = readFileSync(join(root, asset), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
      assert.deepEqual(imports.filter((specifier) => specifier !== "@polyth/package-sdk"), [], `${name}: private import detected`);
    }
  }
});
