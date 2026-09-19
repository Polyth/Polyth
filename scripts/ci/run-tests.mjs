#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";

const mode = process.argv[2];
if (mode !== "ci" && mode !== "polyth-link") {
  console.error("usage: node scripts/ci/run-tests.mjs <ci|polyth-link>");
  process.exit(2);
}

const selected = spawnSync(process.execPath, ["scripts/ci/select-tests.mjs", mode], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
});
if (selected.error || selected.status !== 0) {
  if (selected.stdout) process.stdout.write(selected.stdout);
  if (selected.stderr) process.stderr.write(selected.stderr);
  process.exit(selected.status || 1);
}

const files = selected.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
if (files.length === 0) {
  console.error(`ci-tests: no tests selected for ${mode}`);
  process.exit(1);
}

const requestedConcurrency = Number.parseInt(process.env.CI_TEST_CONCURRENCY ?? "4", 10);
const concurrency = Number.isFinite(requestedConcurrency)
  ? Math.max(1, Math.min(requestedConcurrency, 8))
  : 4;
const requestedTimeout = Number.parseInt(process.env.CI_TEST_FILE_TIMEOUT_MS ?? "120000", 10);
const timeoutMs = Number.isFinite(requestedTimeout)
  ? Math.max(10_000, Math.min(requestedTimeout, 10 * 60_000))
  : 120_000;

let cursor = 0;
const failures = [];

function runFile(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(`\n==> test ${file}`);
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--test",
      "--test-force-exit",
      file,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`ci-tests: timeout after ${timeoutMs}ms: ${file}`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      failures.push({ file, reason: error.message });
      resolve();
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      if (timedOut || code !== 0) {
        failures.push({
          file,
          reason: timedOut ? "timeout" : `exit ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
        });
      } else {
        console.log(`ci-tests: passed ${file} (${elapsed}s)`);
      }
      resolve();
    });
  });
}

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= files.length) return;
    await runFile(files[index]);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));

if (failures.length > 0) {
  console.error(`\nci-tests: ${failures.length} failure(s) in ${mode}:`);
  for (const failure of failures) console.error(`- ${failure.file}: ${failure.reason}`);
  process.exit(1);
}

console.log(`\nci-tests: passed ${files.length} files for ${mode} with concurrency=${concurrency}`);
