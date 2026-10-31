// The session-import dialog uses the shared primitives. Moved out of
// apps/web/test/interactionPolish.test.ts so the host test no longer names the
// removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the session-import dialog uses shared primitives", async () => {
  const source = await read("../widgets/index.tsx");
  assert.doesNotMatch(source, /className="(?:primary-btn|small-btn|danger-btn|icon-btn)(?:\s|")/);
  assert.match(source, /Dialog/);
  assert.doesNotMatch(source, /import Dialog from "\.\/a11y\/Dialog\.tsx"/);
  assert.match(source, /<Checkbox/);
});
