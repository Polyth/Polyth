import assert from "node:assert/strict";
import test from "node:test";
import { cleanDisplayName, gecosFullName, loginDisplayName, osDisplayName } from "../src/osDisplayName.ts";

test("the Linux full name is the GECOS field before its first comma", () => {
  assert.equal(gecosFullName("ida:x:1000:1000:Ida Lindqvist,,,:/home/ida:/bin/bash\n"), "Ida Lindqvist");
  assert.equal(gecosFullName("ida:x:1000:1000::/home/ida:/bin/bash"), "");
  assert.equal(gecosFullName(""), "");
});

test("names are printable, single-line and at most 80 characters", () => {
  assert.equal(cleanDisplayName("  Ida\tLindqvist \n"), "Ida Lindqvist");
  assert.equal(cleanDisplayName("Ida\u0000\u0007 Lindqvist"), "Ida Lindqvist");
  assert.equal([...cleanDisplayName("я".repeat(120))].length, 80);
  // The account rule counts UTF-16 units: an emoji takes two, and is never split.
  const emoji = cleanDisplayName("😀".repeat(50));
  assert.equal(emoji.length, 80);
  assert.equal([...emoji].length, 40);
  assert.equal(cleanDisplayName(null), "");
});

test("a login name becomes a capitalised fallback", () => {
  assert.equal(loginDisplayName("max"), "Max");
  assert.equal(loginDisplayName("Max.K"), "Max.K");
  assert.equal(loginDisplayName(""), "");
});

test("each platform asks its own source and falls back to the login name", async () => {
  const calls: string[] = [];
  const run = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args].join(" "));
    if (file === "id") return "Ida Lindqvist\n";
    if (file === "getent") return "ida:x:1000:1000:Ida L,Room 1,,:/home/ida:/bin/zsh\n";
    throw new Error("unexpected");
  };
  assert.equal(await osDisplayName({ platform: "darwin", username: "ida", run }), "Ida Lindqvist");
  assert.equal(await osDisplayName({ platform: "linux", username: "ida", run }), "Ida L");
  assert.equal(await osDisplayName({ platform: "win32", username: "ida", run }), "Ida");
  assert.deepEqual(calls, ["id -F", "getent passwd ida"]);
  const failing = async () => { throw new Error("timed out"); };
  assert.equal(await osDisplayName({ platform: "linux", username: "ida", run: failing }), "Ida");
  assert.equal(await osDisplayName({ platform: "darwin", username: "", run: async () => "" }), "Owner");
  // A login name that is not a plain account name is never passed to getent.
  let ran = false;
  assert.equal(await osDisplayName({ platform: "linux", username: "-x", run: async () => { ran = true; return ""; } }), "-x");
  assert.equal(ran, false);
});
