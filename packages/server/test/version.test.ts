import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutVersion, serverVersion, UNKNOWN_VERSION } from "../src/version.ts";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const rootVersion = (JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { version: string }).version;

test("a checkout reports its root package.json version", () => {
  assert.equal(checkoutVersion(), rootVersion);
  assert.equal(serverVersion(), rootVersion);
  assert.equal(serverVersion("  "), rootVersion, "a blank host version does not hide the checkout's");
});

test("a host's release version wins, and a bundle without one is not mistaken for a checkout", (t) => {
  assert.equal(serverVersion("1.2.356"), "1.2.356");
  const dir = mkdtempSync(join(tmpdir(), "polyth-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A bundle at <root>/dist: three levels up is not a checkout, even if some
  // unrelated package.json named "polyth" sits there.
  const bundleDist = join(dir, "a", "b", "dist");
  mkdirSync(bundleDist, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "polyth", version: "9.9.9" }));
  assert.equal(checkoutVersion(bundleDist), UNKNOWN_VERSION);
});
