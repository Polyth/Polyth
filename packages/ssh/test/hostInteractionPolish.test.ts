// The SSH project source offers a coarse-pointer alternative to its
// double-click shortcut. Moved out of apps/web/test/interactionPolish.test.ts
// so the host test no longer names the removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the SSH project source has a coarse-pointer double-click alternative", async () => {
  const ssh = await read("../widgets/ssh/SshProjectSource.tsx");
  assert.match(ssh, /matchMedia\?\.\("\(pointer: coarse\)"\)/);
  assert.match(ssh, /className="folder-row-enter"/);
});
