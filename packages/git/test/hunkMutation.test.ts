import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitService } from "../src/index.ts";
import { gitDiffSnapshotDigest, mutateGitHunk } from "../src/hunkMutation.ts";
import { hunkDigest, splitHunks } from "../src/hunks.ts";

function repo(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "polyth-git-hunks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Polyth Test"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function commitFile(root: string, path: string, content: string): void {
  writeFileSync(join(root, path), content);
  git(root, "add", "--", path);
  git(root, "commit", "-qm", `add ${path}`);
}

async function identity(root: string, path: string, staged = false) {
  const service = createGitService();
  const current = await service.diff(root, { path, staged });
  return {
    service,
    current,
    hunks: splitHunks(current.diff),
    snapshot: gitDiffSnapshotDigest(current.diff),
  };
}

test("stage one of multiple hunks and leave the others untouched", async (t) => {
  const root = repo(t);
  const path = "multi.txt";
  commitFile(root, path, Array.from({ length: 36 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const lines = readFileSync(join(root, path), "utf8").split("\n");
  lines[1] = "TWO";
  lines[17] = "EIGHTEEN";
  lines[32] = "THIRTY-THREE";
  writeFileSync(join(root, path), lines.join("\n"));

  const { service, hunks, snapshot } = await identity(root, path);
  assert.equal(hunks.length, 3);
  await mutateGitHunk(service, root, "stage", {
    path,
    hunkIndex: 1,
    hunkDigest: hunkDigest(hunks[1]!),
    expectedSnapshotDigest: snapshot,
  });

  const staged = git(root, "diff", "--cached", "--", path);
  const unstaged = git(root, "diff", "--", path);
  assert.match(staged, /EIGHTEEN/);
  assert.doesNotMatch(staged, /TWO|THIRTY-THREE/);
  assert.match(unstaged, /TWO/);
  assert.match(unstaged, /THIRTY-THREE/);
  assert.doesNotMatch(unstaged, /EIGHTEEN/);
});

test("unstage only one staged hunk", async (t) => {
  const root = repo(t);
  const path = "unstage.txt";
  commitFile(root, path, Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const text = readFileSync(join(root, path), "utf8")
    .replace("line 2", "changed 2")
    .replace("line 25", "changed 25");
  writeFileSync(join(root, path), text);
  git(root, "add", "--", path);

  const { service, hunks, snapshot } = await identity(root, path, true);
  assert.equal(hunks.length, 2);
  await mutateGitHunk(service, root, "unstage", {
    path,
    hunkIndex: 0,
    hunkDigest: hunkDigest(hunks[0]!),
    expectedSnapshotDigest: snapshot,
  });

  const staged = git(root, "diff", "--cached", "--", path);
  const unstaged = git(root, "diff", "--", path);
  assert.doesNotMatch(staged, /\bchanged 2\b/);
  assert.match(staged, /changed 25/);
  assert.match(unstaged, /\bchanged 2\b/);
  assert.doesNotMatch(unstaged, /changed 25/);
});

test("discard one working-tree hunk", async (t) => {
  const root = repo(t);
  const path = "discard.txt";
  commitFile(root, path, Array.from({ length: 32 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  let text = readFileSync(join(root, path), "utf8");
  text = text.replace("line 3", "changed 3").replace("line 28", "changed 28");
  writeFileSync(join(root, path), text);

  const { service, hunks, snapshot } = await identity(root, path);
  assert.equal(hunks.length, 2);
  await mutateGitHunk(service, root, "discard", {
    path,
    hunkIndex: 1,
    hunkDigest: hunkDigest(hunks[1]!),
    expectedSnapshotDigest: snapshot,
  });

  const remaining = git(root, "diff", "--", path);
  assert.match(remaining, /changed 3/);
  assert.doesNotMatch(remaining, /changed 28/);
});

test("stale/shifted edits are rejected instead of applying to coincidental lines", async (t) => {
  const root = repo(t);
  const path = "stale.txt";
  commitFile(root, path, Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace("line 12", "reviewed change"));
  const { service, hunks, snapshot } = await identity(root, path);

  // External edit after the UI captured its snapshot shifts the same region.
  writeFileSync(join(root, path), `inserted externally\n${readFileSync(join(root, path), "utf8")}`);
  await assert.rejects(
    () => mutateGitHunk(service, root, "stage", {
      path,
      hunkIndex: 0,
      hunkDigest: hunkDigest(hunks[0]!),
      expectedSnapshotDigest: snapshot,
    }),
    (error: unknown) => (error as { code?: string }).code === "stale-hunk",
  );
  assert.equal(git(root, "diff", "--cached", "--", path), "");
});

test("CRLF and filenames requiring argv-safe handling remain supported", async (t) => {
  const root = repo(t);
  const path = "odd [name] with spaces.txt";
  commitFile(root, path, "one\r\ntwo\r\nthree\r\nfour\r\n");
  writeFileSync(join(root, path), "one\r\nTWO\r\nthree\r\nfour\r\n");
  const { service, hunks, snapshot } = await identity(root, path);
  assert.equal(hunks.length, 1);
  await mutateGitHunk(service, root, "stage", {
    path,
    hunkIndex: 0,
    hunkDigest: hunkDigest(hunks[0]!),
    expectedSnapshotDigest: snapshot,
  });
  assert.match(git(root, "diff", "--cached", "--", path), /TWO/);
});

test("binary diffs are rejected rather than corrupted", async (t) => {
  const root = repo(t);
  const path = "asset.bin";
  commitFile(root, path, "\x00\x01\x02before");
  writeFileSync(join(root, path), "\x00\x01\x02after");
  const service = createGitService();
  const current = await service.diff(root, { path });
  await assert.rejects(
    () => mutateGitHunk(service, root, "stage", {
      path,
      hunkIndex: 0,
      hunkDigest: "00000000",
      expectedSnapshotDigest: gitDiffSnapshotDigest(current.diff),
    }),
    (error: unknown) => (error as { code?: string }).code === "unsupported-diff"
      || (error as { code?: string }).code === "stale-hunk",
  );
  assert.equal(git(root, "diff", "--cached", "--", path), "");
});
