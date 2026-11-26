// Boot recovery resumes a turn a restart cut on its own harness's runtime, and
// harnesses are packages: the recovery must start only after the enabled
// packages have. Started before them (2026-11-26), every cut Claude Code turn
// failed with "Harness claude is not registered" and waited for someone to
// open the chat or for the tool watchdog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/indexCore.ts", import.meta.url), "utf8");

test("startup recovery of durable session work runs after the enabled packages start", () => {
  const recoveries = [...source.matchAll(/sessions\.recoverPendingWork\(\)/g)];
  assert.equal(recoveries.length, 1, "one startup owner schedules the recovery");
  const packagesStarted = source.indexOf("await packageLifecycle.startEnabled(packageRegistry)");
  assert.ok(packagesStarted > 0, "the server starts its enabled packages");
  assert.ok(recoveries[0]!.index! > packagesStarted, "recovery is scheduled after the packages (and their harnesses) started");
});
