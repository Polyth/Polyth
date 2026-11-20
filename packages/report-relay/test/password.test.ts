import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { hashPassword, parsePasswordLine, verifyPassword } from "../src/password.ts";

test("a hash record is the documented one-line scrypt format", () => {
  const line = hashPassword("tester-password-123");
  assert.match(line, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/);
  const record = parsePasswordLine(line);
  assert.ok(record);
  assert.equal(record.N, 16_384);
  assert.equal(record.r, 8);
  assert.equal(record.p, 1);
  assert.equal(record.salt.length, 16);
  assert.equal(record.hash.length, 32);
  assert.equal(verifyPassword(record, "tester-password-123"), true);
  assert.equal(verifyPassword(record, "tester-password-124"), false);
  assert.equal(verifyPassword(record, ""), false);
  const saltedFirst = parsePasswordLine(hashPassword("another"));
  const saltedSecond = parsePasswordLine(hashPassword("another"));
  assert.ok(saltedFirst && saltedSecond);
  assert.notDeepEqual(saltedFirst.salt, saltedSecond.salt, "each record gets a fresh salt");
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("malformed hash lines are refused rather than guessed at", () => {
  for (const line of [
    "",
    "plaintext",
    "scrypt$1$8$1$AAAA$AAAA",
    "scrypt$16384$8$1$AAAA",
    "scrypt$16385$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "scrypt$16384$8$1$not-base64$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$short",
  ]) assert.equal(parsePasswordLine(line), null, line);
});

test("hash-password reads stdin, prints the record and never echoes the password", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", cli, "hash-password"], {
    input: "from-stdin-password\n",
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const record = parsePasswordLine(child.stdout);
  assert.ok(record);
  assert.equal(verifyPassword(record, "from-stdin-password"), true);
  assert.ok(!child.stdout.includes("from-stdin-password"));
  assert.ok(!child.stderr.includes("from-stdin-password"));
});

test("an empty password is refused", () => {
  assert.throws(() => hashPassword(""), /password/);
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", cli, "hash-password"], { input: "\n", encoding: "utf8" });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, "");
});

test("the module and the CLI use the same record format", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(source, /hashPassword/);
  assert.match(source, /process\.argv\[2\] === "hash-password"/);
});
