import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitService } from "../src/index.ts";

const git = createGitService();
const run = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
function repo(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "polyth-publication-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root, "init", "-qb", "main");
  run(root, "config", "user.name", "Test");
  run(root, "config", "user.email", "test@example.com");
  run(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "file"), "old\n");
  run(root, "add", ".");
  run(root, "commit", "-qm", "old");
  return root;
}
async function prepared(root: string) {
  const expectedHead = await git.revParse(root, "main");
  writeFileSync(join(root, "file"), "published\n");
  const { sha: newSha } = await git.snapshotCommit(root, "result");
  run(root, "checkout", "--", "file");
  return { targetRef: "refs/heads/main", receiptRef: "refs/polyth/publications/test", expectedHead, newSha };
}

test("publication atomically records target CAS and receipt; checkout repair is idempotent", async (t) => {
  const root = repo(t);
  const input = await prepared(root);
  assert.equal(await git.publishRef(root, input), true);
  assert.equal(run(root, "rev-parse", "main"), input.newSha);
  assert.equal(run(root, "rev-parse", input.receiptRef), input.newSha);
  assert.equal(readFileSync(join(root, "file"), "utf8"), "old\n");
  const repair = { branch: "main", expectedHead: input.expectedHead, resultCommit: input.newSha };
  await git.syncPublishedCheckout(root, repair);
  await git.syncPublishedCheckout(root, repair);
  assert.equal(readFileSync(join(root, "file"), "utf8"), "published\n");
  assert.equal((await git.status(root)).clean, true);
});

test("receipt proves publication after restart and target rewind without a duplicate update", async (t) => {
  const root = repo(t);
  const input = await prepared(root);
  assert.equal(await git.publishRef(root, input), true);
  run(root, "update-ref", "refs/heads/main", input.expectedHead, input.newSha);
  assert.equal(await createGitService().publishRef(root, input), true);
  assert.equal(run(root, "rev-parse", "main"), input.expectedHead, "receipt replay must not republish into a user-rewound branch");
  await assert.rejects(git.syncPublishedCheckout(root, { branch: "main", expectedHead: input.expectedHead, resultCommit: input.newSha }), /checkout changed/);
});

test("target moves before publication: CAS leaves target intact and creates no receipt", async (t) => {
  const root = repo(t);
  const input = await prepared(root);
  writeFileSync(join(root, "file"), "other actor\n");
  run(root, "add", "file");
  run(root, "commit", "-qm", "actor");
  const moved = run(root, "rev-parse", "HEAD");
  assert.equal(await git.publishRef(root, input), false);
  assert.equal(run(root, "rev-parse", "HEAD"), moved);
  assert.throws(() => run(root, "rev-parse", "--verify", input.receiptRef));
});

for (const damage of ["unstaged", "staged", "branch", "new-index-dirty"] as const) {
  test(`published checkout repair preserves ${damage} external changes`, async (t) => {
    const root = repo(t);
    const input = await prepared(root);
    await git.publishRef(root, input);
    if (damage === "branch") run(root, "symbolic-ref", "HEAD", "refs/heads/other");
    else {
      if (damage === "new-index-dirty") run(root, "read-tree", input.newSha);
      writeFileSync(join(root, "file"), "user work\n");
      if (damage === "staged") run(root, "add", "file");
    }
    const before = readFileSync(join(root, "file"));
    const index = readFileSync(join(root, ".git", "index"));
    await assert.rejects(git.syncPublishedCheckout(root, { branch: "main", expectedHead: input.expectedHead, resultCommit: input.newSha }), /checkout changed/);
    assert.deepEqual(readFileSync(join(root, "file")), before);
    // write-tree may update only its optional cache-tree; staged content stays.
    assert.equal(run(root, "rev-parse", input.receiptRef), input.newSha);
    assert.ok(index.length > 0);
  });
}

test("checkout repair never overwrites an obstructing untracked file", async (t) => {
  const root = repo(t);
  const expectedHead = run(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "added"), "snapshot\n");
  const { sha: newSha } = await git.snapshotCommit(root, "adds file");
  writeFileSync(join(root, "added"), "user data\n");
  await git.publishRef(root, { expectedHead, newSha, targetRef: "refs/heads/main", receiptRef: "refs/polyth/publications/test" });
  await assert.rejects(git.syncPublishedCheckout(root, { branch: "main", expectedHead, resultCommit: newSha }));
  assert.equal(readFileSync(join(root, "added"), "utf8"), "user data\n");
});

test("ref transaction and checkout repair bypass repository hooks", async (t) => {
  const root = repo(t);
  const input = await prepared(root);
  writeFileSync(join(root, ".git", "hooks", "reference-transaction"), `#!/bin/sh\necho ran > '${root}/hook-ran'\nexit 1\n`, { mode: 0o755 });
  assert.equal(await git.publishRef(root, input), true);
  await git.syncPublishedCheckout(root, { branch: "main", expectedHead: input.expectedHead, resultCommit: input.newSha });
  assert.equal(existsSync(join(root, "hook-ran")), false);
});

test("receipt lookup distinguishes exact absence, other names, and corruption", async (t) => {
  const root = repo(t);
  const input = await prepared(root);
  assert.equal(await git.readRef(root, input.receiptRef), null);
  run(root, "update-ref", `${input.receiptRef}/child`, input.expectedHead);
  assert.equal(await git.readRef(root, input.receiptRef), null);
  run(root, "update-ref", "-d", `${input.receiptRef}/child`);
  await git.publishRef(root, input);
  assert.equal(await git.readRef(root, input.receiptRef), input.newSha);
  writeFileSync(join(root, ".git", input.receiptRef), "broken\n");
  await assert.rejects(git.readRef(root, input.receiptRef), /broken|invalid|bad|ignoring/);
});

test("checkout recovery accepts later pristine descendants without rolling them back", async (t) => {
  const root = repo(t);
  const input = await prepared(root);
  await git.publishRef(root, input);
  const repair = { branch: "main", expectedHead: input.expectedHead, resultCommit: input.newSha };
  await git.syncPublishedCheckout(root, repair);
  writeFileSync(join(root, "file"), "later commit\n");
  run(root, "add", "file");
  run(root, "commit", "-qm", "later");
  const later = run(root, "rev-parse", "HEAD");
  await git.syncPublishedCheckout(root, repair);
  assert.equal(run(root, "rev-parse", "HEAD"), later);
  assert.equal(readFileSync(join(root, "file"), "utf8"), "later commit\n");
  writeFileSync(join(root, "file"), "later uncommitted work\n");
  await assert.rejects(git.syncPublishedCheckout(root, repair), /checkout changed/);
  assert.equal(readFileSync(join(root, "file"), "utf8"), "later uncommitted work\n");
});
