#!/usr/bin/env node
// Agent co-authorship check: a pull request's new commits must not credit an AI
// agent, model or harness in a `Co-authored-by:` trailer (AGENTS.md: no agent
// writes co-authorship; the configured human identity is the only author).
// Only the commits the pull request adds are checked, so existing history with
// such trailers does not fail every branch and nothing has to be rewritten.
//
// Usage: node scripts/ci/check-co-authors.mjs <base-sha> <head-sha>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { identityKind, parseCoAuthors } from "./commit-identities.mjs";

const FIELD = "\x1f";
const RECORD = "\x1e";

/** Agent identities credited as co-authors by the commits, one entry per trailer. */
export const agentCoAuthors = (commits) => commits.flatMap((commit) =>
  parseCoAuthors(commit.message)
    .filter((person) => identityKind(person) === "agent")
    .map((person) => ({ sha: commit.sha, name: person.name, email: person.email })));

export const commitsBetween = (base, head) => execFileSync(
  "git",
  ["log", "--format=%H%x1f%B%x1e", `${base}..${head}`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split(RECORD)
  .map((record) => record.replace(/^\n/, ""))
  .filter(Boolean)
  .map((record) => {
    const [sha, message] = record.split(FIELD);
    return { sha, message };
  });

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: check-co-authors.mjs <base-sha> <head-sha>");
    process.exit(2);
  }
  const commits = commitsBetween(base, head);
  const credited = agentCoAuthors(commits);
  for (const author of credited) {
    console.error(`::error::${author.sha.slice(0, 12)} credits AI agent "${author.name}" <${author.email}> as Co-authored-by`);
  }
  if (credited.length > 0) {
    console.error([
      "",
      "A pull request's new commits must not credit an AI agent, model or harness as a co-author.",
      "Remove the `Co-authored-by:` trailer naming the agent; the configured human identity is the only author.",
      "Existing history is not rewritten: only commits this pull request adds are checked.",
      "See AGENTS.md (Execution and completion).",
    ].join("\n"));
    process.exit(1);
  }
  console.log(`Co-authors: ${commits.length} commit(s) checked, no AI agent co-authors.`);
}
