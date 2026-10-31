import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLegacyPackageData, packageDataDir } from "../src/packageData.ts";

const withRoot = (run: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "polyth-package-data-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test("packageDataDir is the package's own directory under <dataDir>/packages", () => withRoot((root) => {
  const dir = packageDataDir({ storageDir: root, pluginId: "ssh" });
  assert.equal(dir, join(root, "packages", "ssh"));
  assert.ok(existsSync(dir));
  assert.throws(() => packageDataDir({ storageDir: root, pluginId: "../escape" }), /package id/);
}));

test("adoptLegacyPackageData moves legacy files once and never overwrites", (t) => withRoot((root) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => { warnings.push(String(message)); });
  writeFileSync(join(root, "ssh.json"), "legacy");
  mkdirSync(join(root, "voices", "a"), { recursive: true });
  writeFileSync(join(root, "voices", "a", "model.bin"), "v");
  const host = { storageDir: root, pluginId: "ssh" };

  assert.deepEqual(adoptLegacyPackageData(host, ["ssh.json", "voices/a", "missing.json"]), ["ssh.json", "voices/a"]);
  assert.equal(readFileSync(join(root, "packages", "ssh", "ssh.json"), "utf8"), "legacy");
  assert.equal(existsSync(join(root, "ssh.json")), false);
  assert.ok(existsSync(join(root, "packages", "ssh", "voices", "a", "model.bin")));
  assert.deepEqual(warnings, []);

  // A legacy file reappearing after adoption must not clobber the owned copy,
  // and is reported rather than silently ignored.
  writeFileSync(join(root, "ssh.json"), "stale");
  assert.deepEqual(adoptLegacyPackageData(host, ["ssh.json"]), ["ssh.json"]);
  assert.equal(readFileSync(join(root, "packages", "ssh", "ssh.json"), "utf8"), "legacy");
  assert.equal(readFileSync(join(root, "ssh.json"), "utf8"), "stale");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /ssh: legacy data ssh\.json exists beside the adopted copy/);

  assert.throws(() => adoptLegacyPackageData(host, ["../outside"]), /relative/);
  assert.throws(() => adoptLegacyPackageData(host, ["/abs"]), /relative/);
}));
