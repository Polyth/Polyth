// Test fixtures created with `mkdtemp` are removed by the test that made them.
// The test wrappers (scripts/run-tmp.mjs) already confine whatever a run
// leaves behind to a private TMPDIR, but a test file run any other way writes
// straight into the shared /tmp, where tens of thousands of fixture
// directories once piled up. This is a static ratchet: a file that calls
// `mkdtemp` must also remove something (`rm`, `rmSync`, `rmdir`). Files that
// already leaked when the check was added are listed, relative to their test
// directory, in that directory's `temp-leaks.allowlist.json`, so a removable
// package carries its own list. The lists only shrink: fixing a file means
// deleting its entry, and adding one is not the fix.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const ALLOWLIST = "temp-leaks.allowlist.json";
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const CREATES = /\bmkdtemp(?:Sync)?\b/;
const REMOVES = /\b(?:rm|rmSync|rmdir|rmdirSync)\s*\(/;

function testDirs(): string[] {
  const dirs = [join(root, "scripts/test")];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const dir = join(root, group, entry.name, "test");
      if (entry.isDirectory() && existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (SOURCE.test(entry.name)) out.push(path);
  }
  return out;
}

function leaks(path: string): boolean {
  const text = readFileSync(path, "utf8");
  return CREATES.test(text) && !REMOVES.test(text);
}

const repoPath = (path: string) => relative(root, path).split(sep).join("/");

/** Allowlisted files per test directory, as repo-relative paths. */
function allowlists(): { file: string; entries: string[] }[] {
  return testDirs()
    .filter((dir) => existsSync(join(dir, ALLOWLIST)))
    .map((dir) => {
      const file = repoPath(join(dir, ALLOWLIST));
      const names: string[] = JSON.parse(readFileSync(join(dir, ALLOWLIST), "utf8"));
      assert.deepEqual([...names].sort(), names, `keep ${file} sorted`);
      return { file, entries: names.map((name) => repoPath(join(dir, name))) };
    });
}

test("test files that create temporary directories also remove them", () => {
  const allowed = new Set(allowlists().flatMap(({ entries }) => entries));
  const offenders = testDirs()
    .flatMap((dir) => sourceFiles(dir))
    .filter(leaks)
    .map(repoPath)
    .filter((path) => !allowed.has(path));
  assert.deepEqual(offenders, [], "remove mkdtemp fixtures in t.after/after hooks (rmSync(dir, { recursive: true, force: true }))");
});

test("the leak allowlists only name files that still leak", () => {
  const stale = allowlists().flatMap(({ file, entries }) =>
    entries.filter((path) => !existsSync(join(root, path)) || !leaks(join(root, path))).map((path) => `${file}: ${path}`));
  assert.deepEqual(stale, [], "delete these entries from their temp-leaks.allowlist.json (and the file once it is empty)");
});
