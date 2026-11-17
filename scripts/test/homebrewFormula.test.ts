import assert from "node:assert/strict";
import test from "node:test";
import { homebrewFormula } from "../ci/homebrew-formula.mjs";
import { SERVER_TARGETS, serverArchiveName } from "../ci/update-feed.mjs";

const sums = SERVER_TARGETS
  .map((target, index) => `${String(index + 1).repeat(64)}  ${serverArchiveName("1.2.357", target)}`)
  .join("\n");

test("the formula installs the release archive of the machine's platform", () => {
  const formula = homebrewFormula({ version: "1.2.357", sums });
  assert.match(formula, /^class Polyth < Formula$/m);
  assert.match(formula, /^ {2}version "1\.2\.357"$/m);
  for (const [index, target] of SERVER_TARGETS.entries()) {
    const url = `https://github.com/Polyth/Polyth/releases/download/v1.2.357/polyth-server-1.2.357-${target}.tar.gz`;
    assert.ok(formula.includes(`url "${url}"\n      sha256 "${String(index + 1).repeat(64)}"`), `${target} has its URL and checksum`);
  }
  // on_macos/on_linux each hold an arm and an intel block, in that order.
  assert.match(formula, /on_macos do\n {4}on_arm do\n.*darwin-arm64[\s\S]*?on_intel do\n.*darwin-x64/);
  assert.match(formula, /on_linux do\n {4}on_arm do\n.*linux-arm64[\s\S]*?on_intel do\n.*linux-x64/);
  assert.match(formula, /depends_on "node"/);
  assert.match(formula, /run \[opt_bin\/"polyth", "server", "start"\]/, "brew services runs the server in the foreground");
  assert.match(formula, /libexec\.install Dir\["\*"\]/);
});

test("only complete stable releases become a formula", () => {
  assert.throws(() => homebrewFormula({ version: "1.2.357-nightly", sums }), /stable releases only/);
  const partial = sums.split("\n").slice(1).join("\n");
  assert.throws(() => homebrewFormula({ version: "1.2.357", sums: partial }), /has no polyth-server-1\.2\.357-darwin-arm64\.tar\.gz/);
  assert.match(homebrewFormula({ version: "1.2.357", sums, repository: "acme/polyth" }), /github\.com\/acme\/polyth\/releases/);
});
