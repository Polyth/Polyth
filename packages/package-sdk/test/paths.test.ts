import test from "node:test";
import assert from "node:assert/strict";
import { isSafePackagePath } from "../src/paths.ts";

test("package asset paths reject traversal, absolute, and URL forms", () => {
  assert.equal(isSafePackagePath("ui.js"), true);
  assert.equal(isSafePackagePath("src/entry.ts"), true);
  assert.equal(isSafePackagePath("./ui.js"), true);
  for (const bad of [
    "../secret",
    "/etc/passwd",
    "C:\\Windows\\a.js",
    "foo\\bar.js",
    "https://evil.example/x.js",
    "file://tmp",
    "",
    "..",
    "a/../b.js",
    "a//b.js",
    "\\\\server\\share",
  ]) {
    assert.equal(isSafePackagePath(bad), false, bad);
  }
});
