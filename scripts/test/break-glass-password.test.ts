import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../../", import.meta.url).pathname);
const script = join(root, "scripts", "break-glass-password.ts");
const run = (args: string[], input?: string) => spawnSync(
  process.execPath,
  ["--experimental-strip-types", script, ...args],
  { cwd: root, encoding: "utf8", ...(input !== undefined ? { input } : {}) },
);

function sentinel(directory: string, id = "11111111-1111-1111-1111-111111111111"): void {
  mkdirSync(join(directory, "control-plane"), { recursive: true });
  writeFileSync(
    join(directory, "control-plane", "installation.json"),
    `${JSON.stringify({ version: 1, id })}\n`,
    { mode: 0o600 },
  );
}

test("break-glass help documents offline, installation confirmation, and non-argv password input", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--offline/);
  assert.match(result.stdout, /--installation INSTALLATION_ID/);
  assert.match(result.stdout, /hidden TTY input, or one line from stdin/);
  assert.doesNotMatch(result.stdout, /--password\b/);
});

test("inspect is read-only and does not initialize a missing data directory", t => {
  const parent = mkdtempSync(join(tmpdir(), "polyth-break-glass-inspect-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dataDir = join(parent, "missing");
  const result = run(["inspect", "--data-dir", dataDir]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(dataDir), false);
  assert.match(result.stderr, /installation-not-found/);
});

test("reset refuses missing offline acknowledgement and wrong installation before reading a secret", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-break-glass-guard-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  sentinel(dataDir);
  const base = [
    "reset", "--data-dir", dataDir,
    "--login", "owner",
    "--installation", "11111111-1111-1111-1111-111111111111",
    "--reason", "Owner lost all normal sign-in methods.",
  ];
  const offline = run(base);
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /offline-required/);

  const wrong = run([
    ...base.slice(0, base.indexOf("--installation") + 1),
    "22222222-2222-2222-2222-222222222222",
    "--reason", "Owner lost all normal sign-in methods.",
    "--offline",
  ]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /installation-confirmation-mismatch/);
});

test("password material passed in argv is rejected and never echoed", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-break-glass-argv-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  sentinel(dataDir);
  const secret = "never-print-this-password";
  const result = run([
    "reset", "--data-dir", dataDir,
    "--login", "owner",
    "--installation", "11111111-1111-1111-1111-111111111111",
    "--reason", "Owner lost all normal sign-in methods.",
    "--offline",
    "--password", secret,
  ]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});
