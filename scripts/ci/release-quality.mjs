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

// Keep the required merge/release gate deterministic. The repository contains
// broader environment-heavy suites that are intentionally not treated as a
// blocking baseline until they are independently made green.
const QUALITY_TEST_FILES = [
  "scripts/test/release-version.test.ts",
  "scripts/test/releaseQuality.test.ts",
  "scripts/test/release-quality-gates.test.ts",
  "apps/desktop/test/configuration.test.ts",
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

run(process.execPath, [
  "--experimental-strip-types",
  "--test",
  "--test-force-exit",
  ...QUALITY_TEST_FILES,
]);

// Signed/mobile release paths rely on the Link core helper existing even though
// the full Rust suite is owned by the dedicated CI Rust job.
run("cargo", ["build", "-p", "polyth-link-core", "--bin", "polyth-link-ws-echo"]);

console.log(`\nrelease-quality: passed (${TYPECHECK_PROJECTS.length} typecheck projects, ${QUALITY_TEST_FILES.length} contract test files)`);
