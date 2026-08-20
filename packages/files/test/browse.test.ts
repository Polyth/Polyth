// Host directory browsing for the project folder picker: listing, hidden
// entries, blocked pseudo-filesystems, ~ expansion, and mkdir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { browseHost, isBlockedHostPath, mkdirHost, resolveHostPath } from "../src/browse.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-browse-"));

test("browseHost lists only directories, sorted, with parent/home info", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "beta"));
  mkdirSync(join(dir, "alpha"));
  writeFileSync(join(dir, "notes.txt"), "not a folder");
  const r = await browseHost(dir);
  assert.equal(r.path, dir);
  assert.equal(r.parent, join(dir, ".."));
  assert.equal(r.home, homedir());
  assert.deepEqual(r.entries.map((e) => e.name), ["alpha", "beta"]);
  assert.ok(r.entries.every((e) => e.path.startsWith(dir)));
  assert.ok(r.entries.every((e) => typeof e.modifiedAt === "number"));
});

test("hidden directories are excluded by default and included on demand", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "visible"));
  mkdirSync(join(dir, ".secret"));
  const plain = await browseHost(dir);
  assert.deepEqual(plain.entries.map((e) => e.name), ["visible"]);
  const withHidden = await browseHost(dir, { hidden: true });
  assert.deepEqual(withHidden.entries.map((e) => e.name), ["visible", ".secret"]);
  assert.equal(withHidden.entries[1]!.hidden, true);
});

test("blocked pseudo-filesystems are refused", async () => {
  for (const p of ["/proc", "/sys", "/dev", "/proc/self", "/dev/shm"]) {
    assert.equal(isBlockedHostPath(p), true, p);
    await assert.rejects(() => browseHost(p), (err: Error & { code?: string }) => err.code === "invalid-path");
  }
  assert.equal(isBlockedHostPath("/devices"), false, "prefix match must be segment-aware");
  assert.equal(isBlockedHostPath("/home/user/proc"), false);
});

test("empty and ~ paths default to the home directory", () => {
  assert.equal(resolveHostPath(undefined), homedir());
  assert.equal(resolveHostPath(""), homedir());
  assert.equal(resolveHostPath("~"), homedir());
  assert.equal(resolveHostPath("~/projects"), join(homedir(), "projects"));
});

test("relative paths are rejected", () => {
  assert.throws(() => resolveHostPath("projects/app"), (err: Error & { code?: string }) => err.code === "invalid-path");
});

test("browsing a missing or non-directory path fails with a typed error", async () => {
  const dir = tmp();
  await assert.rejects(() => browseHost(join(dir, "nope")), (err: Error & { code?: string }) => err.code === "not-found");
  writeFileSync(join(dir, "file.txt"), "x");
  await assert.rejects(() => browseHost(join(dir, "file.txt")), (err: Error & { code?: string }) => err.code === "invalid-path");
});

test("mkdirHost creates nested folders and refuses blocked paths", async () => {
  const dir = tmp();
  const target = join(dir, "new", "nested");
  const r = await mkdirHost(target);
  assert.equal(r.path, target);
  const listed = await browseHost(join(dir, "new"));
  assert.deepEqual(listed.entries.map((e) => e.name), ["nested"]);
  await assert.rejects(() => mkdirHost("/proc/polyth-test"), (err: Error & { code?: string }) => err.code === "invalid-path");
});
