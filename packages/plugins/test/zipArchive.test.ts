import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openZipArchive } from "../src/zipArchive.ts";
import { buildZip, type ZipFixtureEntry } from "./zipFixture.ts";

const withArchive = async (entries: readonly ZipFixtureEntry[], comment: string, run: (path: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-zip-archive-"));
  try {
    const file = join(dir, "a.zip");
    writeFileSync(file, buildZip(entries, comment));
    await run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("lists regular files with their facts and reads one at a time", async () => {
  await withArchive([
    { name: "repo/", mode: 0o040755 },
    { name: "repo/SKILL.md", body: "hello" },
    { name: "repo/run.sh", body: "#!/bin/sh\n", mode: 0o100755 },
  ], "abc", async (file) => {
    const archive = await openZipArchive(file);
    try {
      assert.equal(archive.comment, "abc");
      assert.deepEqual(archive.entries.map((entry) => [entry.path, entry.bytes, entry.executable]), [
        ["repo/SKILL.md", 5, false],
        ["repo/run.sh", 10, true],
      ]);
      assert.equal((await archive.read("repo/SKILL.md", 64)).toString(), "hello");
    } finally {
      archive.close();
    }
  });
});

test("a read is refused above its limit and for a file the archive does not hold", async () => {
  await withArchive([{ name: "big.txt", body: "x".repeat(2000) }], "", async (file) => {
    const archive = await openZipArchive(file);
    try {
      await assert.rejects(archive.read("big.txt", 100), /too large/);
      await assert.rejects(archive.read("../../etc/passwd", 100), (error: { code?: string }) => error.code === "not-found");
    } finally {
      archive.close();
    }
  });
});

test("a symbolic link is skipped, never listed or followed", async () => {
  await withArchive([
    { name: "ok.txt", body: "ok" },
    { name: "link", body: "/etc/passwd", mode: 0o120777 },
  ], "", async (file) => {
    const archive = await openZipArchive(file);
    try {
      assert.deepEqual(archive.entries.map((entry) => entry.path), ["ok.txt"]);
      await assert.rejects(archive.read("link", 100), (error: { code?: string }) => error.code === "not-found");
    } finally {
      archive.close();
    }
  });
});

test("an entry that climbs out of the archive refuses the whole archive", async () => {
  await withArchive([{ name: "../escape.txt", body: "no" }], "", async (file) => {
    await assert.rejects(openZipArchive(file));
  });
});

test("thousands of files open without being extracted", async () => {
  const many = Array.from({ length: 3000 }, (_, index) => ({ name: `repo/f${index}.txt`, body: "x" }));
  await withArchive(many, "", async (file) => {
    const archive = await openZipArchive(file);
    try {
      assert.equal(archive.entries.length, 3000);
    } finally {
      archive.close();
    }
  });
});
