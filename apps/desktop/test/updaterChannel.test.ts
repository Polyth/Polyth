import assert from "node:assert/strict";
import test from "node:test";
import { resolveUpdaterChannel } from "../src/updaterChannel.ts";

test("Windows arm64 uses its architecture-specific update channel", () => {
  assert.equal(resolveUpdaterChannel("win32", "arm64"), "latest-arm64");
  assert.equal(resolveUpdaterChannel("win32", "x64"), undefined);
  assert.equal(resolveUpdaterChannel("linux", "arm64"), undefined);
  assert.equal(resolveUpdaterChannel("darwin", "arm64"), undefined);
});
