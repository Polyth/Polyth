#!/usr/bin/env node
// Runs the Node test runner inside a private temporary directory
// (scripts/run-tmp.mjs), removed afterwards, so fixtures that suites never
// remove do not accumulate in the shared /tmp. Arguments are passed through
// verbatim, so `npm test -- --test-name-pattern=...` and a single
// `node scripts/run-tests.mjs <file>` both work.
//
// It also stops a run that is exhausting the machine. A runaway suite can eat
// all memory before any per-process limit trips: V8's heap cap does not bound
// what the runner serialises between processes, and a failed assertion holding
// a happy-dom node once serialised its whole window (~40 GB on a 16 GB host),
// crashing the desktop app and every agent turn it ran. When free memory falls
// under the floor for two samples in a row, the whole test process tree is
// killed and the run fails. POLYTH_TEST_MIN_FREE_MB sets the floor; 0 disables.
import { spawn, spawnSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
import { createRunTmp } from "./run-tmp.mjs";

const MB = 1024 * 1024;
const runTmp = createRunTmp();
const env = { ...process.env, ...runTmp.env };
const windows = process.platform === "win32";
const child = spawn(
  process.execPath,
  ["--experimental-strip-types", "--test", ...process.argv.slice(2)],
  // Its own process group off Windows, so the guard can stop the test workers
  // too, not just the runner that spawned them.
  { stdio: "inherit", env, detached: !windows },
);

const cleanup = runTmp.cleanup;

const signalTree = (signal) => {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (windows) {
    if (signal === "SIGKILL") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill(signal);
    return;
  }
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => signalTree(signal));
}

/** The free-memory floor: 10% of RAM, at least 1 GB (a runaway was measured
 *  taking ~1 GB/s, so the floor must outlast a few samples), but never above
 *  half of what is free at the start, so a busy machine can still run tests. */
const memoryFloor = () => {
  const configured = process.env.POLYTH_TEST_MIN_FREE_MB;
  if (configured !== undefined && configured.trim() !== "") {
    const mb = Number(configured);
    return Number.isFinite(mb) && mb > 0 ? mb * MB : 0;
  }
  return Math.min(Math.max(1024 * MB, totalmem() * 0.1), freemem() / 2);
};

let memoryStop;
const floor = memoryFloor();
if (floor > 0) {
  let low = 0;
  const guard = setInterval(() => {
    const free = freemem();
    low = free < floor ? low + 1 : 0;
    if (low < 2) return;
    clearInterval(guard);
    memoryStop = `only ${Math.round(free / MB)} MB of memory left (floor ${Math.round(floor / MB)} MB)`;
    console.error(`\n[run-tests] stopped: ${memoryStop}. A suite is running away with memory; run the files one at a time to find it. POLYTH_TEST_MIN_FREE_MB sets the floor (0 disables).`);
    signalTree("SIGKILL");
  }, 250);
  guard.unref();
}

child.on("exit", (code, signal) => {
  cleanup();
  if (memoryStop) process.exit(1);
  if (signal) {
    // Re-raise without the forwarding handler, which would swallow it and
    // let the wrapper exit 0.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  cleanup();
  console.error(`[run-tests] failed to start the test runner: ${String(error)}`);
  process.exit(1);
});
