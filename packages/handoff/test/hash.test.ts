import test from "node:test";
import assert from "node:assert/strict";
import { hashText } from "../src/hash.ts";

test("hashText is deterministic FNV-1a 64-bit hex", () => {
  assert.equal(hashText(""), "cbf29ce484222325");
  assert.equal(hashText("hello"), hashText("hello"));
  assert.notEqual(hashText("hello"), hashText("hello!"));
  assert.match(hashText("x"), /^[0-9a-f]{16}$/);
});
