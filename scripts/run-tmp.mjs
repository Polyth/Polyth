// Private per-run temporary directory shared by the test and check wrappers.
//
// Hundreds of suites create fixtures with `mkdtemp(join(tmpdir(), ...))` and
// many never remove them, so every run used to leave thousands of directories
// (and the odd multi-gigabyte database copy) in the shared /tmp. A wrapper
// points TMPDIR at its own run directory and removes it afterwards, so cleanup
// is a single `rm` whatever the suites do.
//
// A wrapper that is killed cannot remove its directory, so each run directory
// records the wrapper's pid and the next run sweeps the ones whose owner is
// gone. The sweep only touches this user's `polyth-test-run-*` directories.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RUN_TMP_PREFIX = "polyth-test-run-";
export const RUN_TMP_OWNER_FILE = ".polyth-run-owner";
/** A dead owner's directory is left alone this long after its last change: a
 *  bounded-check unit outlives a killed wrapper by at most its RuntimeMaxSec
 *  (30 min), and its directory must not vanish under it. */
export const ORPHAN_GRACE_MS = 35 * 60_000;
/** Run directories from before owner files existed. */
export const UNOWNED_GRACE_MS = 24 * 60 * 60_000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Removes run directories whose wrapper is gone. Returns the removed names. */
export function sweepStaleRunTmp({ base = tmpdir(), now = Date.now(), alive = processAlive } = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const removed = [];
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUN_TMP_PREFIX)) continue;
    const dir = join(base, entry.name);
    try {
      const stat = statSync(dir);
      if (uid !== undefined && stat.uid !== uid) continue;
      const age = now - stat.mtimeMs;
      let owner;
      try {
        owner = Number.parseInt(readFileSync(join(dir, RUN_TMP_OWNER_FILE), "utf8"), 10);
      } catch {
        owner = undefined;
      }
      const stale = Number.isSafeInteger(owner) && owner > 0
        ? !alive(owner) && age > ORPHAN_GRACE_MS
        : age > UNOWNED_GRACE_MS;
      if (!stale) continue;
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      removed.push(entry.name);
    } catch {
      // Another run may be removing the same directory; the next sweep retries.
    }
  }
  return removed;
}

/** Creates this run's directory after sweeping stale ones. `env` points every
 *  temp variable at it; `cleanup` is idempotent. */
export function createRunTmp({ base = tmpdir() } = {}) {
  sweepStaleRunTmp({ base });
  const root = mkdtempSync(join(base, RUN_TMP_PREFIX));
  writeFileSync(join(root, RUN_TMP_OWNER_FILE), `${process.pid}\n`);
  let cleaned = false;
  return {
    root,
    env: { TMPDIR: root, TMP: root, TEMP: root },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
