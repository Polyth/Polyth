import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitService } from "../src/index.ts";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);
const { summarizeUnifiedDiff } = await import("../widgets/PendingChangesBar.tsx");

const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const dirs: string[] = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repo() {
  const root = mkdtempSync(join(tmpdir(), "polyth-diffstats-"));
  dirs.push(root);
  const g = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "T"); g("config", "user.email", "t@example.invalid");
  const lines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n") + "\n";
  writeFileSync(join(root, "staged.txt"), lines(5));
  writeFileSync(join(root, "unstaged.txt"), lines(5));
  writeFileSync(join(root, "both.txt"), lines(6));
  writeFileSync(join(root, "gone.txt"), lines(4));
  writeFileSync(join(root, "gone2.txt"), lines(3));
  writeFileSync(join(root, "old-name.txt"), lines(20, "r"));
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  g("add", "."); g("commit", "-qm", "seed");
  writeFileSync(join(root, "staged.txt"), lines(5).replace("l1", "changed1\nextra"));
  g("add", "staged.txt");
  writeFileSync(join(root, "unstaged.txt"), lines(3));
  writeFileSync(join(root, "both.txt"), lines(6).replace("l0", "A0"));
  g("add", "both.txt");
  writeFileSync(join(root, "both.txt"), lines(6).replace("l0", "A0").replace("l5", "B5\nB6"));
  unlinkSync(join(root, "gone2.txt"));
  unlinkSync(join(root, "gone.txt"));
  g("rm", "-q", "--cached", "gone.txt");
  g("mv", "old-name.txt", "new-name.txt");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 9, 9, 9, 0, 1]));
  g("add", "bin.dat");
  writeFileSync(join(root, "fresh.txt"), lines(7, "n") + "++plus\nno newline");
  writeFileSync(join(root, "fresh.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, "empty.txt"), "");
  symlinkSync("fresh.txt", join(root, "link"));
  return root;
}

test("diffStats equals the per-file diff for every changed path, in a constant number of git processes", async () => {
  const root = repo();
  const wrapDir = mkdtempSync(join(tmpdir(), "polyth-diffstats-bin-"));
  dirs.push(wrapDir);
  const log = join(wrapDir, "argv.log");
  const wrapper = join(wrapDir, "git");
  writeFileSync(wrapper, `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(log, "");
  const git = createGitService({ bin: wrapper });
  const processes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;

  const stats = await git.diffStats(root);
  const bulkProcesses = processes();
  assert.ok(bulkProcesses <= 3, `diffStats started ${bulkProcesses} git processes`);

  const status = await git.status(root);
  assert.ok(status.staged.length >= 4 && status.unstaged.length >= 3 && status.untracked.length >= 3);
  const expectSide = async (side: "staged" | "unstaged", paths: string[]) => {
    for (const path of paths) {
      const per = summarizeUnifiedDiff((await git.diff(root, { path, staged: side === "staged" })).diff);
      assert.deepEqual(stats[side][path], per, `${side}:${path}`);
    }
  };
  await expectSide("staged", status.staged.map((f) => f.path));
  await expectSide("unstaged", [...status.unstaged, ...status.untracked].map((f) => f.path).filter((p) => p !== "link"));
  assert.deepEqual(Object.keys(stats.staged).sort(), status.staged.map((f) => f.path).sort());
  // The rename is counted as the per-file diff counts it: a whole new file.
  assert.deepEqual(stats.staged["new-name.txt"], { additions: 20, deletions: 0 });
  assert.deepEqual(stats.staged["bin.dat"], { additions: 0, deletions: 0 });
  // A symlink cannot be counted exactly without reading it as git does: left out.
  assert.equal(stats.unstaged["link"], undefined);

  // The count does not grow with the number of files.
  const before = processes();
  for (let i = 0; i < 25; i++) writeFileSync(join(root, `more${i}.txt`), "x\n");
  await git.diffStats(root);
  assert.equal(processes() - before, bulkProcesses);
});

test("diffStats leaves conflicted files out and answers an empty repository", async () => {
  const git = createGitService();
  const root = mkdtempSync(join(tmpdir(), "polyth-diffstats-"));
  dirs.push(root);
  const g = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "T"); g("config", "user.email", "t@example.invalid");
  assert.deepEqual(await git.diffStats(root), { staged: {}, unstaged: {} });
  writeFileSync(join(root, "c.txt"), "base\n");
  g("add", "."); g("commit", "-qm", "base");
  g("checkout", "-qb", "other");
  writeFileSync(join(root, "c.txt"), "other\n"); g("commit", "-qam", "other");
  g("checkout", "-q", "main");
  writeFileSync(join(root, "c.txt"), "main\n"); g("commit", "-qam", "main");
  try { g("merge", "other"); } catch { /* conflict expected */ }
  const stats = await git.diffStats(root);
  assert.equal(stats.unstaged["c.txt"], undefined);
  assert.equal(stats.staged["c.txt"], undefined);
});

test("content lines that look like diff headers are counted the same by both counters", async () => {
  const git = createGitService();
  const root = mkdtempSync(join(tmpdir(), "polyth-diffstats-"));
  dirs.push(root);
  const g = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "T"); g("config", "user.email", "t@example.invalid");
  writeFileSync(join(root, "q.sql"), "select 1;\n-- old comment\n--- rule\nselect 2;\n");
  writeFileSync(join(root, "other.txt"), "a\n");
  g("add", "."); g("commit", "-qm", "base");
  writeFileSync(join(root, "q.sql"), "select 1;\n++i;\n+++ more\nselect 2;\n");
  writeFileSync(join(root, "other.txt"), "b\n");
  const stats = await git.diffStats(root);
  assert.deepEqual(stats.unstaged["q.sql"], { additions: 2, deletions: 2 });
  assert.deepEqual(summarizeUnifiedDiff((await git.diff(root, { path: "q.sql" })).diff), { additions: 2, deletions: 2 });
  // Several files in one patch: each file's headers are skipped, its hunks counted.
  assert.deepEqual(summarizeUnifiedDiff((await git.diff(root)).diff), { additions: 3, deletions: 3 });
});

test("one request reads a bounded number of untracked files and leaves the rest out", async () => {
  const git = createGitService();
  const root = mkdtempSync(join(tmpdir(), "polyth-diffstats-"));
  dirs.push(root);
  execFileSync(REAL_GIT, ["init", "-q", "-b", "main"], { cwd: root, stdio: "pipe" });
  for (let i = 0; i < 230; i++) writeFileSync(join(root, `gen${String(i).padStart(3, "0")}.txt`), "one\ntwo");
  const stats = await git.diffStats(root);
  const counted = Object.keys(stats.unstaged);
  assert.equal(counted.length, 200);
  for (const path of counted) assert.deepEqual(stats.unstaged[path], { additions: 2, deletions: 0 });
});
