import test from "node:test";
import assert from "node:assert/strict";
import { isPairingLink, previewPairingLink } from "../src/index.ts";

test("pairing preview rejects oversized, control, and non-pair URLs", () => {
  assert.equal(isPairingLink("polyth://pair?v=1&t=abc"), true);
  assert.equal(previewPairingLink("https://evil.example/pair").ok, false);
  assert.equal(previewPairingLink("polyth://pair?v=1&t=abc\u0000").ok, false);
  assert.equal(previewPairingLink("polyth://pair?v=1&t=" + "A".repeat(20_000)).ok, false);
});
