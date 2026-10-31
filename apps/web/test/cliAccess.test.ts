import test from "node:test";
import assert from "node:assert/strict";
import { accessLevel, isCompleteUserCode, normalizeUserCode } from "../src/cliAccess.ts";

test("normalizeUserCode formats typed input as XXXX-XXXX, case-insensitively", () => {
  assert.equal(normalizeUserCode("abcd"), "ABCD");
  assert.equal(normalizeUserCode("abcd1234"), "ABCD-1234");
  assert.equal(normalizeUserCode(" abcd-12 34 zz"), "ABCD-1234");
  assert.equal(normalizeUserCode(""), "");
});

test("isCompleteUserCode only accepts the full shape", () => {
  assert.equal(isCompleteUserCode("ABCD-1234"), true);
  assert.equal(isCompleteUserCode("ABCD-123"), false);
  assert.equal(isCompleteUserCode("abcd-1234"), false);
});

test("accessLevel treats any session-steering grant as control", () => {
  assert.equal(accessLevel(["core.projects.read", "core.sessions.read"]), "read");
  assert.equal(accessLevel(["core.sessions.read", "core.sessions.message"]), "control");
  assert.equal(accessLevel([]), "read");
});
