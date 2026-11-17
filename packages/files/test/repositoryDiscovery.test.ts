import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
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

test("an inherited GIT_DIR does not redirect repository discovery to another repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-discovery-env-"));
  const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  try {
    const selection = join(dir, "selection");
    const first = join(selection, "first");
    const second = join(dir, "second");
    await mkdir(first, { recursive: true }); await mkdir(second);
    execFileSync("git", ["-C", first, "init", "--quiet"]);
    execFileSync("git", ["-C", second, "init", "--quiet"]);
    process.env.GIT_DIR = join(second, ".git");
    process.env.GIT_WORK_TREE = second;
    const result = await discoverRepositories(selection);
    assert.deepEqual(result.repositories.map((repository) => repository.path), [await realpath(first)]);
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
    if (saved.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.tree;
    await rm(dir, { recursive: true, force: true });
  }
});
