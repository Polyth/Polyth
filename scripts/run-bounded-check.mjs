#!/usr/bin/env node
// Local Linux verification wrapper. A test's concurrency flag bounds test
// scheduling; this cgroup bounds the entire process tree, including loaders.
// The command runs with a private TMPDIR (scripts/run-tmp.mjs) that is removed
// afterwards, so fixtures a check leaves behind never reach the shared /tmp.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRunTmp } from "./run-tmp.mjs";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (process.platform !== "linux" || separator < 0 || separator === args.length - 1) {
  process.stderr.write("Usage (Linux with a systemd user manager): node scripts/run-bounded-check.mjs [--seconds 45] [--memory-mib 768] [--cpu-percent 50] -- command [args…]\n");
  process.exit(2);
}
const limits = { seconds: 45, "memory-mib": 768, "cpu-percent": 50 };
const ranges = { seconds: [1, 1800], "memory-mib": [128, 4096], "cpu-percent": [10, 100] };
for (let index = 0; index < separator; index += 2) {
  const key = args[index]?.replace(/^--/, "");
  const value = Number(args[index + 1]);
  const range = ranges[key];
  if (!range || !Number.isSafeInteger(value) || value < range[0] || value > range[1] || index + 1 >= separator) {
    process.stderr.write(`Invalid resource limit: ${args[index]}\n`);
    process.exit(2);
  }
  limits[key] = value;
}
const unit = `polyth-check-${randomUUID()}`;
function run(program, argv, outputLimit = 200_000) {
  return new Promise((resolve) => {
    const child = spawn(program, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let size = 0;
    const forward = (chunk) => {
      if (size < outputLimit) process.stdout.write(chunk.subarray(0, outputLimit - size));
      size += chunk.length;
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (error) => { process.stderr.write(`${error.message}\n`); resolve(127); });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  // The exact unique unit is owned by this invocation. Its children remain
  // subject to RuntimeMaxSec even if this wrapper itself is interrupted.
  void run("systemctl", ["--user", "stop", `${unit}.service`], 4096);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const runTmp = createRunTmp();
const status = await run("systemd-run", [
  "--user", "--wait", `--unit=${unit}`,
  `--property=WorkingDirectory=${process.cwd()}`,
  `--property=MemoryMax=${limits["memory-mib"]}M`, "--property=MemorySwapMax=0",
  `--property=CPUQuota=${limits["cpu-percent"]}%`, "--property=TasksMax=64",
  `--property=RuntimeMaxSec=${limits.seconds}s`, "--property=TimeoutStopSec=2s",
  "--property=KillMode=control-group", "--property=LimitCORE=0",
  "--property=LogRateLimitIntervalSec=1s", "--property=LogRateLimitBurst=200",
  "--setenv=GOMAXPROCS=2", "--setenv=NODE_OPTIONS=--max-old-space-size=384",
  ...Object.entries(runTmp.env).map(([key, value]) => `--setenv=${key}=${value}`),
  "--", ...args.slice(separator + 1),
], 8192);
// `--wait` returns once the unit's whole control group has stopped, so no
// process of the check still uses the directory.
runTmp.cleanup();
await run("journalctl", ["--user", `--unit=${unit}.service`, "--no-pager", "--output=cat", "--lines=300"]);
if (status !== 0) await run("systemctl", ["--user", "reset-failed", `${unit}.service`], 2048);
process.exitCode = stopping ? 130 : status;
