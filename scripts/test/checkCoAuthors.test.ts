import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentCoAuthors, commitsBetween } from "../ci/check-co-authors.mjs";

const commit = (sha: string, message: string) => ({ sha, message });

test("agent Co-authored-by trailers are rejected, people and bots are not", () => {
  const commits = [
    commit("a".repeat(40), "Fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"),
    commit("b".repeat(40), "Fix\n\nco-authored-by: Cursor Agent <cursoragent@cursor.com>\n"),
    commit("c".repeat(40), "Fix\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>\n"),
    commit("d".repeat(40), "Fix\n\nCo-Authored-By: Ada Lovelace <ada@example.com>\n"),
    commit("e".repeat(40), "Fix\n\nCo-Authored-By: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>\n"),
    commit("f".repeat(40), "Fix\n\nSigned-off-by: Claude Opus 5.5 <noreply@anthropic.com>\n"),
    commit("0".repeat(40), "Fix\n\nMentions Co-Authored-By: Claude <noreply@anthropic.com> mid-line\n"),
  ];
  assert.deepEqual(agentCoAuthors(commits).map((author) => author.sha[0]), ["a", "b", "c"]);
});

test("only commits a pull request adds are checked", () => {
  const repo = mkdtempSync(join(tmpdir(), "polyth-co-authors-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Ada");
    git("config", "user.email", "ada@example.com");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a"), "1");
    git("add", "a");
    git("commit", "-q", "-m", "Existing\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "a"), "2");
    git("commit", "-q", "-a", "-m", "Human pair\n\nCo-Authored-By: Ada Lovelace <ada@example.com>");
    writeFileSync(join(repo, "a"), "3");
    git("commit", "-q", "-a", "-m", "Agent pair\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
    const head = git("rev-parse", "HEAD");
    const previous = process.cwd();
    process.chdir(repo);
    try {
      const commits = commitsBetween(base, head);
      assert.deepEqual(commits.map((entry) => entry.message.split("\n")[0]), ["Agent pair", "Human pair"]);
      assert.deepEqual(agentCoAuthors(commits).map((author) => author.name), ["Claude Opus 5.5"]);
    } finally {
      process.chdir(previous);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
