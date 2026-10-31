import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverRepositories } from "../src/repositoryDiscovery.ts";

test("selected folder discovery finds immediate Git roots and deduplicates canonical symlink targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-discovery-"));
  try {
    const selection = join(dir, "selection");
    const external = join(dir, "external");
    await mkdir(selection); await mkdir(external);
    execFileSync("git", ["-C", external, "init", "--quiet"]);
    await symlink(external, join(selection, "api"), "dir");
    await symlink(external, join(selection, "api-again"), "dir");
    await mkdir(join(selection, "plain"));
    const result = await discoverRepositories(selection);
    assert.equal(result.truncated, false);
    assert.equal(result.repositories.length, 1);
    assert.equal(result.repositories[0]!.path, external);
    assert.equal(result.repositories[0]!.linked, true);
    await assert.rejects(() => discoverRepositories("/proc"), { code: "invalid-path" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
