import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitService } from "../src/index.ts";

test("agent beta GitService preserves reads and rejects repository mutations", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-beta-git-"));
  const before = process.env.POLYTH_AGENT_BETA;
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Beta"], { cwd: root });
    execFileSync("git", ["config", "user.email", "beta@example.invalid"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "two\n");

    process.env.POLYTH_AGENT_BETA = "1";
    const git = createGitService();
    const status = await git.status(root);
    assert.equal(status.unstaged.some((item) => item.path === "a.txt"), true);
    assert.match((await git.diff(root, { path: "a.txt" })).diff, /two/);

    await assert.rejects(() => git.stage(root, ["a.txt"]), /read-only/);
    await assert.rejects(() => git.commit(root, "blocked"), /read-only/);
    await assert.rejects(() => git.checkout(root, "main"), /read-only/);
    await assert.rejects(() => git.fetch(root), /read-only/);
    await assert.rejects(() => git.worktrees.create(root, { branch: "beta-test" }), /read-only/);
  } finally {
    if (before === undefined) delete process.env.POLYTH_AGENT_BETA;
    else process.env.POLYTH_AGENT_BETA = before;
    rmSync(root, { recursive: true, force: true });
  }
});
