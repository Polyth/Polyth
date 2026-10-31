#!/usr/bin/env node
// Developer Certificate of Origin check: every commit a pull request adds must
// carry a `Signed-off-by:` trailer naming its author (`git commit -s`), the
// contributor's statement that they may submit it under the project license
// (https://developercertificate.org). Merge commits and GitHub Apps' bot
// commits are exempt.
//
// Usage: node scripts/ci/check-dco.mjs <base-sha> <head-sha>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FIELD = "\x1f";
const RECORD = "\x1e";

const isBot = (name, email) => /\[bot\]$/i.test(name) || /\[bot\]@users\.noreply\.github\.com$/i.test(email);

/** Sign-off trailers of a commit message, as lowercase email addresses. */
export const signOffEmails = (message) =>
  [...message.matchAll(/^Signed-off-by:\s*.+?<([^>\s]+)>\s*$/gim)].map((match) => match[1].toLowerCase());

/** Commits that miss their author's sign-off. */
export const missingSignOffs = (commits) => commits.filter((commit) =>
  commit.parents < 2
  && !isBot(commit.name, commit.email)
  && !signOffEmails(commit.message).includes(commit.email.toLowerCase()));

export const commitsBetween = (base, head) => execFileSync(
  "git",
  ["log", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%B%x1e", `${base}..${head}`],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split(RECORD)
  .map((record) => record.replace(/^\n/, ""))
  .filter(Boolean)
  .map((record) => {
    const [sha, parents, name, email, message] = record.split(FIELD);
    return { sha, parents: parents.trim().split(/\s+/).filter(Boolean).length, name, email, message };
  });

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: check-dco.mjs <base-sha> <head-sha>");
    process.exit(2);
  }
  const commits = commitsBetween(base, head);
  const missing = missingSignOffs(commits);
  for (const commit of missing) {
    console.error(`::error::${commit.sha.slice(0, 12)} by ${commit.name} <${commit.email}> has no "Signed-off-by: ${commit.name} <${commit.email}>" trailer`);
  }
  if (missing.length > 0) {
    console.error([
      "",
      "Every commit needs a Developer Certificate of Origin sign-off that matches its author.",
      "Add it with `git commit -s`; for commits already made: `git rebase --signoff <base>` and force-push.",
      "See CONTRIBUTING.md#sign-your-commits.",
    ].join("\n"));
    process.exit(1);
  }
  console.log(`DCO: ${commits.length} commit(s) checked, all signed off.`);
}
