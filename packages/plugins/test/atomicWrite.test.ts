import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync, openExclusiveTempSync } from "../src/atomicWrite.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "polyth-atomic-"));

const modeOf = (path: string): number => statSync(path).mode & 0o777;

const leftoverTemps = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.includes(".tmp-"));

const unix = process.platform !== "win32";

test("atomicWriteSync replaces the target and leaves no sibling temp files", () => {
  const dir = scratch();
  const file = join(dir, "state.json");
  atomicWriteSync(file, '{"v":1}\n');
  atomicWriteSync(file, '{"v":2}\n');
  assert.equal(readFileSync(file, "utf8"), '{"v":2}\n');
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("atomicWriteSync applies an explicit 0600 mode to a new file", { skip: !unix }, () => {
  const file = join(scratch(), "secret.json");
  atomicWriteSync(file, '{"token":1}\n', 0o600);
  assert.equal(modeOf(file), 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"token":1}\n');
});

test("openExclusiveTempSync applies 0600 before any bytes are written", { skip: !unix }, () => {
  const dir = scratch();
  const tmp = join(dir, "secret.json.tmp-test");
  const previous = process.umask(0);
  let fd: number | undefined;
  try {
    fd = openExclusiveTempSync(tmp, 0o600);
    assert.equal(modeOf(tmp), 0o600);
    assert.equal(statSync(tmp).size, 0);
  } finally {
    process.umask(previous);
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* test cleanup */ }
  }
});

test("atomicWriteSync preserves existing 0600 when mode is omitted", { skip: !unix }, () => {
  const file = join(scratch(), "auth.json");
  writeFileSync(file, '{"v":1}\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.equal(modeOf(file), 0o600);
  atomicWriteSync(file, '{"v":2}\n');
  assert.equal(readFileSync(file, "utf8"), '{"v":2}\n');
  assert.equal(modeOf(file), 0o600);
});

test("atomicWriteSync preserves an existing custom mode", { skip: !unix }, () => {
  const file = join(scratch(), "custom.json");
  writeFileSync(file, '{"v":1}\n', { mode: 0o640 });
  chmodSync(file, 0o640);
  assert.equal(modeOf(file), 0o640);
  atomicWriteSync(file, '{"v":2}\n');
  assert.equal(modeOf(file), 0o640);
});

test("atomicWriteSync uses umask semantics for a new non-secret file", { skip: !unix }, () => {
  const file = join(scratch(), "plain.json");
  const previous = process.umask(0o022);
  try {
    atomicWriteSync(file, '{"v":1}\n');
  } finally {
    process.umask(previous);
  }
  assert.equal(modeOf(file), 0o644);
});

test("atomicWriteSync failure cleans up the temporary file", () => {
  const dir = scratch();
  const file = join(dir, "target");
  mkdirSync(file);
  assert.throws(() => atomicWriteSync(file, '{"v":1}\n'));
  assert.deepEqual(leftoverTemps(dir), []);
  assert.equal(statSync(file).isDirectory(), true);
});

test("atomicWrite replaces the target, applies 0600, preserves mode, and cleans up", async () => {
  const dir = scratch();
  const file = join(dir, "state.json");
  await atomicWrite(file, '{"v":1}\n', 0o600);
  if (unix) assert.equal(modeOf(file), 0o600);
  await atomicWrite(file, '{"v":2}\n');
  assert.equal(readFileSync(file, "utf8"), '{"v":2}\n');
  if (unix) assert.equal(modeOf(file), 0o600);
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("atomicWrite failure cleans up the temporary file", async () => {
  const dir = scratch();
  const file = join(dir, "target");
  mkdirSync(file);
  await assert.rejects(() => atomicWrite(file, '{"v":1}\n'));
  assert.deepEqual(leftoverTemps(dir), []);
  assert.equal(statSync(file).isDirectory(), true);
});

test("concurrent writes do not share a temp filename", async () => {
  const dir = scratch();
  const file = join(dir, "state.json");
  await Promise.all([
    atomicWrite(file, '{"a":1}\n'),
    atomicWrite(file, '{"b":1}\n'),
    atomicWrite(file, '{"c":1}\n'),
    atomicWrite(file, '{"d":1}\n'),
    atomicWrite(file, '{"e":1}\n'),
  ]);
  assert.deepEqual(leftoverTemps(dir), []);
  assert.match(readFileSync(file, "utf8"), /^\{"[a-e]":1\}\n$/);
});

test("openExclusiveTempSync refuses to collide with an existing temp", () => {
  const dir = scratch();
  const tmp = join(dir, "state.json.tmp-same");
  writeFileSync(tmp, "taken");
  assert.throws(() => openExclusiveTempSync(tmp, 0o600));
});
