#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const TYPECHECK_PROJECTS = [
  "packages/contracts",
  "packages/plugins",
  "packages/server",
  "packages/control-plane",
  "packages/identity",
  "packages/tenancy",
  "packages/secure-safe",
  "packages/pairing-qr",
  "packages/tunnel",
  "packages/terminal",
  "packages/markets",
  "apps/mobile",
];

function fail(command, result) {
  const suffix = result.error ? `: ${result.error.message}` : "";
  console.error(`release-quality: failed: ${command}${suffix}`);
  process.exit(typeof result.status === "number" && result.status > 0 ? result.status : 1);
}

function run(command, args, options = {}) {
  const display = [command, ...args].join(" ");
  console.log(`\n==> ${display}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error || result.status !== 0) fail(display, result);
}

function capture(command, args) {
  const display = [command, ...args].join(" ");
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(display, result);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

run(process.execPath, ["scripts/release-version.mjs"]);
run(npm, ["run", "build:web"]);

for (const project of TYPECHECK_PROJECTS) {
  run(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "-p",
    project,
  ]);
}

const stable = capture(process.execPath, ["scripts/ci/select-tests.mjs", "ci"]);
if (stable.length === 0) {
  console.error("release-quality: no tests selected");
  process.exit(1);
}
run(process.execPath, ["scripts/ci/run-tests.mjs", "ci"]);

run("cargo", ["build", "-p", "polyth-link-core", "--bin", "polyth-link-ws-echo"]);
const link = capture(process.execPath, ["scripts/ci/select-tests.mjs", "polyth-link"]);
run(process.execPath, ["scripts/ci/run-tests.mjs", "polyth-link"]);
console.log(`\nrelease-quality: passed (${TYPECHECK_PROJECTS.length} typecheck projects, ${stable.length + link.length} test files)`);
