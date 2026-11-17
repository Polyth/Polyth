// Chat attachments in `_inbox/` never reach source control: every write into
// the folder gives it a `.gitignore` of `*`, so Git ignores it in any project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService, type FileService } from "../src/index.ts";
import { INBOX_GITIGNORE, isInboxPath, withIgnoredInbox } from "../src/inboxIgnore.ts";
import { createAttachmentSourceService, ignoreExistingInboxes } from "../src/serverEntry.ts";

const tempRoot = (t: { after(fn: () => void): void }, prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const gitEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
};

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { env: gitEnv(), encoding: "utf8" });

test("an upload into _inbox stays out of a repository's status", async (t) => {
  const root = tempRoot(t, "polyth-inbox-git-");
  git(root, "init", "--quiet");
  writeFileSync(join(root, "README.md"), "hello\n");
  const files = createFileService();
  await files.writeBytes(root, "_inbox/0f2c-image.png", new Uint8Array([1, 2, 3]));
  await files.write(root, "./_inbox/0f2d-notes.txt", "notes");

  assert.equal(readFileSync(join(root, "_inbox/.gitignore"), "utf8"), INBOX_GITIGNORE);
  assert.equal(git(root, "status", "--porcelain", "--untracked-files=all"), "?? README.md\n");
  git(root, "add", "-A");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "README.md\n", "`git add -A` leaves attachments out");
});

test("only the top-level _inbox gets the file, and a person's own one is kept", async (t) => {
  const root = tempRoot(t, "polyth-inbox-scope-");
  const files = createFileService();
  await files.writeBytes(root, "src/_inbox/data.bin", new Uint8Array([1]));
  await files.mkdir(root, "assets");
  assert.equal(existsSync(join(root, "_inbox")), false, "no inbox is created for other writes");
  assert.equal(existsSync(join(root, "src/_inbox/.gitignore")), false);

  mkdirSync(join(root, "_inbox"));
  writeFileSync(join(root, "_inbox/.gitignore"), "*.png\n");
  await files.writeBytes(root, "_inbox/a-file.png", new Uint8Array([1]));
  assert.equal(readFileSync(join(root, "_inbox/.gitignore"), "utf8"), "*.png\n");

  const other = tempRoot(t, "polyth-inbox-mkdir-");
  await files.mkdir(other, "_inbox");
  assert.equal(readFileSync(join(other, "_inbox/.gitignore"), "utf8"), INBOX_GITIGNORE);
  writeFileSync(join(other, "upload.bin"), "x");
  await files.rename(other, "upload.bin", "_inbox/upload.bin");
  assert.equal(existsSync(join(other, "_inbox/upload.bin")), true);
});

test("isInboxPath matches the folder however it is spelled", () => {
  for (const rel of ["_inbox", "_inbox/", "./_inbox/a.png", "_inbox\\a.png", "/_inbox/a", "x/../_inbox/a"]) {
    assert.equal(isInboxPath(rel), true, rel);
  }
  for (const rel of ["", "src/_inbox/a", "_inboxes/a", "inbox/a", "../_inbox/a"]) {
    assert.equal(isInboxPath(rel), false, rel);
  }
});

test("staged and materialized attachments carry the file at both roots", async (t) => {
  const projectRoot = tempRoot(t, "polyth-inbox-project-");
  const worktree = tempRoot(t, "polyth-inbox-worktree-");
  const files = createFileService();
  const service = createAttachmentSourceService(async () => files, async () => projectRoot);
  const staged = await service.stage!({ projectId: "p1", name: "card.png", bytes: new Uint8Array([7]) });
  assert.equal(readFileSync(join(projectRoot, "_inbox/.gitignore"), "utf8"), INBOX_GITIGNORE);
  await service.materialize({ projectId: "p1", projectRoot, execRoot: worktree, rel: staged.path });
  assert.equal(readFileSync(join(worktree, "_inbox/.gitignore"), "utf8"), INBOX_GITIGNORE);
});

test("existing inboxes of local projects are given the file; nothing else is touched", async (t) => {
  const withInbox = tempRoot(t, "polyth-inbox-existing-");
  const without = tempRoot(t, "polyth-inbox-none-");
  const remote = tempRoot(t, "polyth-inbox-remote-");
  mkdirSync(join(withInbox, "_inbox"));
  writeFileSync(join(withInbox, "_inbox/old-image.png"), "x");
  mkdirSync(join(remote, "_inbox"));
  await ignoreExistingInboxes([
    { path: withInbox },
    { path: without },
    { path: remote, remote: { kind: "ssh" } },
    { path: join(without, "missing") },
  ], createFileService());
  assert.equal(readFileSync(join(withInbox, "_inbox/.gitignore"), "utf8"), INBOX_GITIGNORE);
  assert.equal(existsSync(join(without, "_inbox")), false);
  assert.equal(existsSync(join(remote, "_inbox/.gitignore")), false);
});

test("a failed .gitignore write never costs the upload", async (t) => {
  const root = tempRoot(t, "polyth-inbox-fail-");
  const inner = createFileService();
  const written: string[] = [];
  const failing: FileService = {
    ...inner,
    async writeBytes(r, rel, data) {
      if (rel.endsWith(".gitignore")) throw new Error("read-only");
      written.push(rel);
      return inner.writeBytes(r, rel, data);
    },
  };
  const warn = t.mock.method(console, "warn", () => {});
  await withIgnoredInbox(failing).writeBytes(root, "_inbox/a.png", new Uint8Array([1]));
  assert.deepEqual(written, ["_inbox/a.png"]);
  assert.equal(warn.mock.callCount(), 1);
});
