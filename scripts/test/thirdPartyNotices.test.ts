import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundledPackages, packageRootOf, writeThirdPartyNotices } from "../third-party-notices.mjs";

const fakePackage = (root: string, dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void => {
  const pkg = join(root, "node_modules", dir);
  mkdirSync(join(pkg, "lib"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(pkg, "lib", "index.js"), "export {};\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(pkg, name), text);
};

test("package roots handle scoped and nested node_modules", () => {
  assert.equal(packageRootOf("/r/node_modules/react/index.js"), "/r/node_modules/react");
  assert.equal(packageRootOf("/r/node_modules/@scope/pkg/dist/a.js"), "/r/node_modules/@scope/pkg");
  assert.equal(packageRootOf("/r/node_modules/a/node_modules/b/x.js"), "/r/node_modules/a/node_modules/b");
  assert.equal(packageRootOf("/r/packages/server/src/index.ts"), null);
});

test("notices list each bundled package once with its license files, skipping own sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-notices-"));
  try {
    fakePackage(root, "alpha", { name: "alpha", version: "1.0.0", license: "MIT" }, { LICENSE: "MIT License\nCopyright (c) Alpha" });
    fakePackage(root, "@scope/beta", { name: "@scope/beta", version: "2.1.0", license: { type: "ISC" } }, { "LICENSE.md": "ISC beta", NOTICE: "Beta notice" });
    fakePackage(root, "gamma", { name: "gamma", version: "0.3.0", license: "BSD-3-Clause", author: "Gamma Author" });
    const metafiles = [
      { inputs: { "node_modules/alpha/lib/index.js": {}, "node_modules/@scope/beta/lib/index.js": {}, "src/own.ts": {} } },
      { inputs: { "node_modules/alpha/lib/index.js": {}, "node_modules/gamma/lib/index.js": {}, "<define:process>": {} } },
    ];
    assert.deepEqual(bundledPackages(metafiles, root).map((pkg) => pkg.id), ["@scope/beta@2.1.0", "alpha@1.0.0", "gamma@0.3.0"]);
    const file = join(root, "out", "THIRD_PARTY_NOTICES.txt");
    await writeThirdPartyNotices(file, metafiles, { product: "Test app", workingDir: root });
    const text = readFileSync(file, "utf8");
    assert.match(text, /^Test app includes the following third-party software/);
    assert.match(text, /alpha 1\.0\.0\nLicense: MIT\n\n--- LICENSE\nMIT License\nCopyright \(c\) Alpha/);
    assert.match(text, /--- LICENSE\.md\nISC beta\n\n--- NOTICE\nBeta notice/);
    assert.match(text, /gamma 0\.3\.0\nLicense: BSD-3-Clause\nAuthor: Gamma Author\n\n\(The package ships no license file/);
    assert.equal(text.match(/^alpha 1\.0\.0$/gm)?.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bundled package without any license information fails the build", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-notices-"));
  try {
    fakePackage(root, "mystery", { name: "mystery", version: "1.0.0" });
    await assert.rejects(
      writeThirdPartyNotices(join(root, "N.txt"), [{ inputs: { "node_modules/mystery/lib/index.js": {} } }], { workingDir: root }),
      /without any license information: mystery@1\.0\.0/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
