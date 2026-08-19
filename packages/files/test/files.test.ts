import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileService } from "../src/index.ts";

const files = createFileService();

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "polyth-files-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("tree lists one level, dirs first, skips .git and hidden by default", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, ".hidden"));
    await writeFile(path.join(root, "README.md"), "hi");
    await writeFile(path.join(root, ".env"), "x=1");
    await writeFile(path.join(root, "src", "a.ts"), "a");
    const listed = await files.tree(root);
    assert.deepEqual(
      listed.map((e) => e.name),
      ["src", "README.md"],
    );
    assert.equal(listed[0]!.dir, true);
    assert.equal(listed[1]!.dir, false);
    assert.ok(typeof listed[1]!.size === "number");

    const withHidden = await files.tree(root, { hidden: true });
    const names = withHidden.map((e) => e.name);
    assert.ok(names.includes(".hidden"));
    assert.ok(names.includes(".env"));
    assert.ok(!names.includes(".git"));

    const inner = await files.tree(root, { path: "src" });
    assert.equal(inner.length, 1);
    assert.equal(inner[0]!.path, "src/a.ts");
  });
});

test("read truncates over 512KB", async () => {
  await withRoot(async (root) => {
    const big = "x".repeat(512 * 1024 + 50);
    await writeFile(path.join(root, "big.txt"), big);
    const got = await files.read(root, "big.txt");
    assert.equal(got.truncated, true);
    assert.equal(got.content.length, 512 * 1024);
    assert.equal(got.path, "big.txt");
  });
});

test("read detects binary via NUL in first 8KB", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const got = await files.read(root, "blob.bin");
    assert.equal(got.content, "");
    assert.equal(got.tooLarge, true);
  });
});

test("rejects path escapes: .., absolute, symlink out", async () => {
  await withRoot(async (root) => {
    await assert.rejects(() => files.read(root, "../secret"), /escapes/i);
    await assert.rejects(() => files.read(root, "/etc/passwd"), /escapes/i);
    await assert.rejects(() => files.write(root, "../../x", "no"), /escapes/i);
    await assert.rejects(() => files.tree(root, { path: ".." }), /escapes/i);

    const outside = await mkdtemp(path.join(tmpdir(), "polyth-out-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "nope");
      await symlink(outside, path.join(root, "link"));
      await assert.rejects(() => files.read(root, "link/secret.txt"), /escapes/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("write creates parent dirs and stays inside root", async () => {
  await withRoot(async (root) => {
    await files.write(root, "a/b/c.txt", "hello");
    const got = await files.read(root, "a/b/c.txt");
    assert.equal(got.content, "hello");
    assert.equal(got.truncated, false);
  });
});

test("mkdir creates a project-relative folder and rejects escapes", async () => {
  await withRoot(async (root) => {
    await files.mkdir(root, "src/components");
    assert.equal((await files.tree(root, { path: "src" }))[0]!.path, "src/components");
    await assert.rejects(() => files.mkdir(root, "../outside"), /escapes/i);
  });
});

test("rename and remove stay inside the project", async () => {
  await withRoot(async (root) => {
    await files.write(root, "old.txt", "hello");
    await files.rename(root, "old.txt", "new.txt");
    assert.equal((await files.read(root, "new.txt")).content, "hello");
    await files.remove(root, "new.txt");
    await assert.rejects(() => files.read(root, "new.txt"));
    await assert.rejects(() => files.rename(root, "../old", "new"), /escapes/i);
    await files.write(root, "source.txt", "x");
    await assert.rejects(() => files.rename(root, "source.txt", "../new"), /escapes/i);
  });
});

test("search matches filename substring, skips .git and node_modules, respects limit", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, "src", "widget.ts"), "");
    await writeFile(path.join(root, "src", "other.ts"), "");
    await writeFile(path.join(root, "README.md"), "");
    await writeFile(path.join(root, "node_modules", "pkg", "widget.ts"), "");
    await writeFile(path.join(root, ".git", "widget.ts"), "");
    const hits = await files.search(root, "widget", 50);
    assert.deepEqual(hits, ["src/widget.ts"]);
    const limited = await files.search(root, ".ts", 1);
    assert.equal(limited.length, 1);
  });
});
