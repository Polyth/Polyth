import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunTmp, ORPHAN_GRACE_MS, RUN_TMP_OWNER_FILE, RUN_TMP_PREFIX, sweepStaleRunTmp, UNOWNED_GRACE_MS } from "../run-tmp.mjs";

function runDir(base: string, name: string, { owner, ageMs }: { owner?: number; ageMs: number }): string {
  const dir = join(base, `${RUN_TMP_PREFIX}${name}`);
  mkdirSync(join(dir, "fixture"), { recursive: true });
  if (owner !== undefined) writeFileSync(join(dir, RUN_TMP_OWNER_FILE), `${owner}\n`);
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(dir, at, at);
  return dir;
}

test("sweep removes only run directories whose owner is gone and that are past the grace period", (t) => {
  const base = mkdtempSync(join(tmpdir(), "polyth-run-tmp-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
  const deadOld = runDir(base, "dead-old", { owner: deadPid, ageMs: ORPHAN_GRACE_MS + 60_000 });
  const deadFresh = runDir(base, "dead-fresh", { owner: deadPid, ageMs: 60_000 });
  const liveOld = runDir(base, "live-old", { owner: process.pid, ageMs: UNOWNED_GRACE_MS * 2 });
  const unownedOld = runDir(base, "unowned-old", { ageMs: UNOWNED_GRACE_MS + 60_000 });
  const unownedFresh = runDir(base, "unowned-fresh", { ageMs: ORPHAN_GRACE_MS * 2 });
  const unrelated = join(base, "polyth-opencode");
  mkdirSync(unrelated);
  utimesSync(unrelated, 0, 0);

  const removed = sweepStaleRunTmp({ base }).sort();

  assert.deepEqual(removed, [`${RUN_TMP_PREFIX}dead-old`, `${RUN_TMP_PREFIX}unowned-old`]);
  assert.equal(existsSync(deadOld), false);
  assert.equal(existsSync(unownedOld), false);
  for (const kept of [deadFresh, liveOld, unownedFresh, unrelated]) assert.equal(existsSync(kept), true, kept);
});

test("createRunTmp records its owner, points every temp variable at the run directory and cleans up once", (t) => {
  const base = mkdtempSync(join(tmpdir(), "polyth-run-tmp-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const run = createRunTmp({ base });
  assert.ok(run.root.startsWith(join(base, RUN_TMP_PREFIX)));
  assert.deepEqual(run.env, { TMPDIR: run.root, TMP: run.root, TEMP: run.root });
  // The live owner protects the directory from a concurrent run's sweep.
  utimesSync(run.root, 0, 0);
  assert.deepEqual(sweepStaleRunTmp({ base }), []);
  run.cleanup();
  run.cleanup();
  assert.equal(existsSync(run.root), false);
});

test("run-tests removes its private TMPDIR after the run", (t) => {
  const base = mkdtempSync(join(tmpdir(), "polyth-run-tmp-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const probe = join(base, "probe.test.mjs");
  writeFileSync(probe, [
    'import { mkdtempSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'import test from "node:test";',
    'test("leaks a fixture", () => {',
    '  writeFileSync(join(mkdtempSync(join(tmpdir(), "leak-")), "f"), "x");',
    '  writeFileSync(process.env.PROBE_OUT, tmpdir());',
    '});',
  ].join("\n"));
  const out = join(base, "tmpdir.txt");
  // Without NODE_TEST_CONTEXT (even empty) the nested runner runs its files
  // instead of deferring to this test's runner.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../run-tests.mjs"), probe], {
    env: { ...env, TMPDIR: base, PROBE_OUT: out },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const runRoot = readFileSync(out, "utf8");
  assert.ok(runRoot.startsWith(join(base, RUN_TMP_PREFIX)), runRoot);
  assert.equal(existsSync(runRoot), false);
  assert.deepEqual(readdirSync(base).filter((name) => name.startsWith(RUN_TMP_PREFIX)), []);
});
