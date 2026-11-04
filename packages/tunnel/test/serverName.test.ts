import test from "node:test";
import assert from "node:assert/strict";
import { cleanServerName, fallbackServerName, SERVER_NAME_MAX_CHARS } from "../src/serverName.ts";

test("a server name is one printable line within the Link ticket limit", () => {
  assert.equal(cleanServerName("  Home\n\tstudio\u0007 "), "Home studio");
  assert.equal(cleanServerName(42), "");
  assert.equal(Array.from(cleanServerName("й".repeat(120))).length, SERVER_NAME_MAX_CHARS);
});

test("until the owner names it, the server goes by its short host name", () => {
  assert.equal(fallbackServerName("studio.local"), "studio");
  assert.equal(fallbackServerName(""), "Polyth");
});
