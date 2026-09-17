#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args, options = {}) {
  console.log(`release-quality: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function lines(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

run(process.execPath, ["scripts/release-version.mjs"]);
run(npm, ["run", "build:web"]);

for (const project of [
  "packages/contracts",
  "packages/plugins",
  "packages/server",
  "packages/tunnel",
  "packages/terminal",
  "apps/mobile",
  "apps/desktop",
]) {
  run(npx, ["tsc", "--noEmit", "-p", project]);
}

const stable = lines(process.execPath, ["scripts/ci/select-tests.mjs", "ci"]);
run(process.execPath, ["--experimental-strip-types", "--test", ...stable]);

run("cargo", ["build", "-p", "polyth-link-core", "--bin", "polyth-link-ws-echo"]);
const link = lines(process.execPath, ["scripts/ci/select-tests.mjs", "polyth-link"]);
run(process.execPath, ["--experimental-strip-types", "--test", ...link]);
