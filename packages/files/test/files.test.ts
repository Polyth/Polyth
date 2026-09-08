import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
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

test("rejects path escapes: .., symlink out; writes stay scoped", async () => {
  await withRoot(async (root) => {
    await assert.rejects(() => files.read(root, "../secret"), /escapes/i);
    await assert.rejects(() => files.write(root, "../../x", "no"), /escapes/i);
    await assert.rejects(() => files.tree(root, { path: ".." }), /escapes/i);

    const outside = await mkdtemp(path.join(tmpdir(), "polyth-out-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "nope");
      await symlink(outside, path.join(root, "link"));
      await assert.rejects(() => files.read(root, "link/secret.txt"), /escapes/i);
      // Absolute reads are allowed (agent-generated/read files may live
      // anywhere) but absolute writes are not.
      assert.equal((await files.read(root, path.join(outside, "secret.txt"))).content, "nope");
      await assert.rejects(() => files.write(root, path.join(outside, "secret.txt"), "x"), /escapes/i);
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

test("writeBytes roundtrips binary data and creates parent dirs", async () => {
  await withRoot(async (root) => {
    const data = new Uint8Array([0, 1, 2, 128, 255, 0, 7]);
    await files.writeBytes(root, "assets/blob.bin", data);
    const raw = await readFile(path.join(root, "assets", "blob.bin"));
    assert.deepEqual(new Uint8Array(raw), data);
  });
});

test("writeBytes rejects path escapes", async () => {
  await withRoot(async (root) => {
    const data = new Uint8Array([1]);
    await assert.rejects(() => files.writeBytes(root, "../evil.bin", data), /escapes/i);
    await assert.rejects(() => files.writeBytes(root, "/abs.bin", data), /escapes/i);
    await assert.rejects(() => files.writeBytes(root, "a/../../b.bin", data), /escapes/i);
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

test("searchScored ranks exact basename above prefix, substring, segment, fuzzy", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, "src", "app"), { recursive: true });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "src", "app.ts"), "");              // exact basename (sans ext)
    await writeFile(path.join(root, "src", "app-config.ts"), "");       // basename prefix
    await writeFile(path.join(root, "src", "webapp.ts"), "");           // basename substring
    await writeFile(path.join(root, "src", "app", "index.ts"), "");     // path segment
    await writeFile(path.join(root, "docs", "a-p-p-guide.md"), "");     // fuzzy only
    const hits = await files.searchScored(root, "app", { limit: 10 });
    const paths = hits.map((h) => h.path);
    assert.equal(paths[0], "src/app.ts");
    assert.ok(paths.indexOf("src/app-config.ts") < paths.indexOf("src/webapp.ts"));
    assert.ok(paths.indexOf("src/webapp.ts") < paths.indexOf("src/app/index.ts"));
    assert.equal(paths[paths.length - 1], "docs/a-p-p-guide.md");
    // scores descend and stay in [0,1]
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i]!.score <= hits[i - 1]!.score);
    for (const h of hits) assert.ok(h.score >= 0 && h.score <= 1);
    // exact hit highlights the basename range
    assert.deepEqual(hits[0]!.matches, [[4, 7]]);
  });
});

test("searchScored: includeDirs returns folders; spaces and diacritics fold", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, "my components"), { recursive: true });
    await writeFile(path.join(root, "my components", "Café.md"), "");
    const withDirs = await files.searchScored(root, "my comp", { includeDirs: true });
    assert.ok(withDirs.some((h) => h.path === "my components" && h.kind === "dir"));
    const withoutDirs = await files.searchScored(root, "my comp");
    assert.ok(!withoutDirs.some((h) => h.kind === "dir"));
    // diacritic-insensitive: "cafe" finds Café.md with the basename highlighted
    const folded = await files.searchScored(root, "cafe");
    assert.equal(folded.length, 1);
    assert.equal(folded[0]!.path, "my components/Café.md");
    assert.deepEqual(folded[0]!.matches, [[14, 18]]);
  });
});

test("searchScored: empty query bounded by limit; symlinked dirs not followed", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, "a"));
    await writeFile(path.join(root, "a", "one.txt"), "");
    await writeFile(path.join(root, "a", "two.txt"), "");
    // symlink loop: a/loop -> root
    try {
      await symlink(root, path.join(root, "a", "loop"), "dir");
    } catch { /* symlinks unavailable — skip loop half */ }
    const all = await files.searchScored(root, "", { limit: 1 });
    assert.equal(all.length, 1);
    const hits = await files.searchScored(root, "one", { limit: 50 });
    assert.deepEqual(hits.map((h) => h.path), ["a/one.txt"]);
  });
});

test("stat returns kind/size/mime/revision and rejects traversal", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, "img"));
    await writeFile(path.join(root, "img", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const st = await files.stat(root, "img/a.png");
    assert.equal(st.kind, "file");
    assert.equal(st.size, 4);
    assert.equal(st.mime, "image/png");
    assert.ok(st.revision && st.revision.length > 0);

    const dir = await files.stat(root, "img");
    assert.equal(dir.kind, "dir");

    await assert.rejects(() => files.stat(root, "../outside"), /escapes/);
  });
});

test("absolute paths outside the root are viewable (read/stat/readRaw), never writable", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "polyth-out-"));
    try {
      const abs = path.join(outside, "notes.txt");
      await writeFile(abs, "outside text");
      const got = await files.read(root, abs);
      assert.equal(got.content, "outside text");
      assert.equal(got.path, abs);
      const st = await files.stat(root, abs);
      assert.equal(st.kind, "file");
      assert.equal(st.mime, "text/plain");
      const raw = await files.readRaw(root, abs);
      assert.equal(raw.size, "outside text".length);
      await assert.rejects(() => files.write(root, abs, "x"), /escapes/i);
      await assert.rejects(() => files.mkdir(root, abs), /escapes/i);
      await assert.rejects(() => files.remove(root, abs), /escapes/i);
      await assert.rejects(() => files.rename(root, abs, "in-root.txt"), /escapes/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("slashless tmp references from chat resolve read-only when absent in the project", async () => {
  await withRoot(async (root) => {
    const name = `polyth-file-ref-${Date.now()}.png`;
    const abs = path.join(tmpdir(), name);
    try {
      await writeFile(abs, Buffer.from([1, 2, 3]));
      const rel = `tmp/${name}`;
      assert.equal((await files.stat(root, rel)).mime, "image/png");
      assert.deepEqual([...(await files.readRaw(root, rel)).data], [1, 2, 3]);
    } finally {
      await rm(abs, { force: true });
    }
  });
});

test("readRaw serves bytes with a whitelisted mime; html maps to octet-stream", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "pic.webp"), Buffer.from([1, 2, 3]));
    await writeFile(path.join(root, "page.html"), "<script>alert(1)</script>");
    await writeFile(path.join(root, "art.svg"), "<svg onload=alert(1)/>");

    const img = await files.readRaw(root, "pic.webp");
    assert.equal(img.mime, "image/webp");
    assert.equal(img.size, 3);
    assert.deepEqual([...img.data], [1, 2, 3]);

    // Executable document types must never be served with their real mime.
    assert.equal((await files.readRaw(root, "page.html")).mime, "application/octet-stream");
    assert.equal((await files.readRaw(root, "art.svg")).mime, "application/octet-stream");

    await assert.rejects(() => files.readRaw(root, "../pic.webp"), /escapes/);
    await assert.rejects(() => files.readRaw(root, "."), /Not a file/);
  });
});

test("write with matching baseRevision succeeds and returns new revision", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "a.txt"), "v1");
    const got = await files.read(root, "a.txt");
    assert.ok(got.revision);
    const res = await files.write(root, "a.txt", "v2", { baseRevision: got.revision! });
    assert.ok(res.revision);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "v2");
  });
});

test("write with stale baseRevision rejects with conflict and keeps disk content", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "a.txt"), "v1");
    const got = await files.read(root, "a.txt");
    // External change moves the on-disk revision.
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(path.join(root, "a.txt"), "external!");
    await assert.rejects(
      files.write(root, "a.txt", "mine", { baseRevision: got.revision! }),
      (err: Error & { code?: string }) => err.code === "conflict",
    );
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "external!");
  });
});

test("write with baseRevision against a missing file conflicts and does not recreate", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "gone.txt"), "v1");
    const got = await files.read(root, "gone.txt");
    await rm(path.join(root, "gone.txt"));
    await assert.rejects(
      files.write(root, "gone.txt", "resurrect", { baseRevision: got.revision! }),
      (err: Error & { code?: string }) => err.code === "conflict",
    );
    await assert.rejects(readFile(path.join(root, "gone.txt"), "utf8"), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
    const res = await files.write(root, "gone.txt", "recreated");
    assert.ok(res.revision);
    assert.equal(await readFile(path.join(root, "gone.txt"), "utf8"), "recreated");
  });
});

test("write without baseRevision still succeeds (explicit overwrite)", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "a.txt"), "v1");
    const res = await files.write(root, "a.txt", "v2");
    assert.ok(res.revision);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "v2");
  });
});

test("write refuses to overwrite a binary file with text", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "img.bin"), Buffer.from([1, 0, 2, 3]));
    await assert.rejects(
      files.write(root, "img.bin", "text now"),
      (err: Error & { code?: string }) => err.code === "invalid-input",
    );
    const still = await readFile(path.join(root, "img.bin"));
    assert.deepEqual([...still], [1, 0, 2, 3]);
  });
});
