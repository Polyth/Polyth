import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { channelPublishes, serverDistTag, serverNpmPlan } from "../ci/publish-server-npm.mjs";

test("the server reaches npm under its channel's dist-tag; stable is what installs by default", () => {
  assert.equal(serverDistTag("1.2.357"), "latest");
  assert.equal(serverDistTag("1.2.357-nightly"), "nightly");
  assert.equal(channelPublishes("1.2.357"), true);
  assert.equal(channelPublishes("1.2.357-nightly"), false, "nightlies stay off npm unless listed");
  assert.equal(channelPublishes("1.2.357-nightly", "stable, nightly"), true);
});

test("only a complete set is published, platform packages before polyth", () => {
  const root = mkdtempSync(join(tmpdir(), "server-npm-"));
  try {
    const put = (dir: string, name: string) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, name), "x");
    };
    for (const target of ["linux-x64", "linux-arm64", "darwin-arm64"]) {
      put(`products-server-${target}`, `polyth-server-${target}-1.2.357.tgz`);
      put(`products-server-${target}`, "polyth-1.2.357.tgz");
    }
    const partial = serverNpmPlan(root, "1.2.357");
    assert.deepEqual(partial.missing, ["@polyth/server-darwin-x64"]);

    put("products-server-darwin-x64", "polyth-server-darwin-x64-1.2.357.tgz");
    put("products-server-darwin-x64", "polyth-1.2.357.tgz");
    const plan = serverNpmPlan(root, "1.2.357");
    assert.deepEqual(plan.missing, []);
    assert.equal(plan.tag, "latest");
    assert.deepEqual(plan.packages.map((pkg) => pkg.name), [
      "@polyth/server-darwin-arm64", "@polyth/server-darwin-x64", "@polyth/server-linux-arm64", "@polyth/server-linux-x64", "polyth",
    ]);
    assert.match(plan.packages.at(-1)!.file, /products-server-linux-x64[\\/]polyth-1\.2\.357\.tgz$/, "one runner's copy of the main package");
    assert.deepEqual(serverNpmPlan(root, "1.2.358").missing.length, 5, "another version's files do not count");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
