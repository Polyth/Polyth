import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateAbsoluteLocalPath } from "../src/localPath.ts";

test("local path validation identifies accessible files and directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-local-path-"));
  const directory = join(root, "folder");
  const file = join(directory, "file.txt");
  try {
    await mkdir(directory);
    await writeFile(file, "test");
    assert.deepEqual(await validateAbsoluteLocalPath(directory), { path: directory, directory: true });
    assert.deepEqual(await validateAbsoluteLocalPath(file), { path: file, directory: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local path validation rejects relative and missing paths", async () => {
  await assert.rejects(validateAbsoluteLocalPath("relative.txt"), /absolute local path/);
  await assert.rejects(validateAbsoluteLocalPath(join(tmpdir(), "polyth-path-does-not-exist")), /does not exist/);
});
