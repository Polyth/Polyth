import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitsBetween, missingSignOffs, signOffEmails } from "../ci/check-dco.mjs";

const commit = (over: Partial<{ sha: string; parents: number; name: string; email: string; message: string }>) => ({
  sha: "a".repeat(40), parents: 1, name: "Ada", email: "ada@example.com", message: "Change\n", ...over,
});

test("a commit needs a sign-off naming its own author", () => {
  assert.deepEqual(signOffEmails("Fix\n\nSigned-off-by: Ada <Ada@Example.com>\n"), ["ada@example.com"]);
  const signed = commit({ message: "Fix\n\nSigned-off-by: Ada <ada@example.com>\n" });
  const unsigned = commit({ sha: "b".repeat(40) });
  const someoneElse = commit({ sha: "c".repeat(40), message: "Fix\n\nSigned-off-by: Bob <bob@example.com>\n" });
  const inline = commit({ sha: "d".repeat(40), message: "Mentions Signed-off-by: Ada <ada@example.com> mid-line\n" });
  assert.deepEqual(missingSignOffs([signed, unsigned, someoneElse, inline]).map((c) => c.sha[0]), ["b", "c", "d"]);
});

test("merge commits and GitHub App bots are exempt", () => {
  assert.deepEqual(missingSignOffs([
    commit({ parents: 2 }),
    commit({ name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" }),
  ]), []);
});

test("reads author, parents and message of each commit in a range", () => {
  const repo = mkdtempSync(join(tmpdir(), "polyth-dco-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Ada");
    git("config", "user.email", "ada@example.com");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a"), "1");
    git("add", "a");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "a"), "2");
    git("commit", "-q", "-a", "-s", "-m", "signed");
    writeFileSync(join(repo, "a"), "3");
    git("commit", "-q", "-a", "-m", "unsigned");
    const head = git("rev-parse", "HEAD");
    const previous = process.cwd();
    process.chdir(repo);
    try {
      const commits = commitsBetween(base, head);
      assert.deepEqual(commits.map((c) => c.message.split("\n")[0]), ["unsigned", "signed"]);
      assert.deepEqual(missingSignOffs(commits).map((c) => c.message.split("\n")[0]), ["unsigned"]);
    } finally {
      process.chdir(previous);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
