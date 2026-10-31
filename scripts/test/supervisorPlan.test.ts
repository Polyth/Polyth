import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  applyRestartPolicy,
  backoffDelay,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  changedPaths,
  classifyChange,
  collectSweepSignatures,
  DEFAULT_OPTIONS,
  fsSignature,
  INITIAL_LIVENESS,
  isSweepDirectory,
  LIVENESS_PROBE_INTERVAL_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  livenessProbeHost,
  mergeActions,
  nextLiveness,
  parseSupervisorArgs,
  planForPaths,
  type ProbeOutcome,
} from "../supervisorPlan.ts";

test("server sources restart without a build", () => {
  assert.equal(classifyChange("packages/server/src/index.ts"), "restart");
  assert.equal(classifyChange("packages/git/src/serverEntry.ts"), "restart");
});

test("bundled sources build", () => {
  assert.equal(classifyChange("packages/git/widgets/index.tsx"), "build");
  assert.equal(classifyChange("packages/git/widgets/styles.css"), "build");
  assert.equal(classifyChange("apps/web/src/components/Timeline.tsx"), "build");
  assert.equal(classifyChange("apps/web/src/styles.css"), "build");
});

test("build inputs outside src still build", () => {
  assert.equal(classifyChange("apps/web/build.ts"), "build");
  assert.equal(classifyChange("apps/web/buildPackages.ts"), "build");
  assert.equal(classifyChange("apps/web/sw.js"), "build");
  assert.equal(classifyChange("apps/web/manifest.json"), "build");
});

test("manifests can move entry points, so they do both", () => {
  assert.equal(classifyChange("package.json"), "build+restart");
  assert.equal(classifyChange("packages/git/package.json"), "build+restart");
  assert.equal(classifyChange("apps/web/package.json"), "build+restart");
});

test("build output, dependencies and runtime state are ignored", () => {
  assert.equal(classifyChange("packages/git/dist/web/entry.js"), "ignore");
  assert.equal(classifyChange("apps/web/dist/main.js"), "ignore");
  assert.equal(classifyChange("node_modules/react/index.js"), "ignore");
  assert.equal(classifyChange("packages/git/node_modules/x/index.js"), "ignore");
  assert.equal(classifyChange("data/projects/a.db"), "ignore");
  assert.equal(classifyChange(".git/HEAD"), "ignore");
  assert.equal(classifyChange("_inbox/shot.png"), "ignore");
});

test("non-runtime files are ignored", () => {
  assert.equal(classifyChange("packages/git/test/git.test.ts"), "ignore");
  assert.equal(classifyChange("docs/dev/ui.md"), "ignore");
  assert.equal(classifyChange("README.md"), "ignore");
  assert.equal(classifyChange("apps/desktop/src/main.ts"), "ignore");
  assert.equal(classifyChange("apps/mobile/src/index.ts"), "ignore");
  assert.equal(classifyChange("packages/git"), "ignore");
  assert.equal(classifyChange(""), "ignore");
});

test("editor and atomic-write temporaries are ignored", () => {
  assert.equal(classifyChange("packages/git/src/.index.ts.swp"), "ignore");
  assert.equal(classifyChange("packages/git/src/index.ts~"), "ignore");
  assert.equal(classifyChange("packages/git/src/state.json.tmp-1234"), "ignore");
  assert.equal(classifyChange("big.bin.polyth-tmp.$$"), "ignore");
});

test("merging a batch takes the union of the work", () => {
  assert.equal(mergeActions("ignore", "build"), "build");
  assert.equal(mergeActions("build", "restart"), "build+restart");
  assert.equal(mergeActions("build+restart", "ignore"), "build+restart");
  assert.equal(mergeActions("ignore", "ignore"), "ignore");
  assert.equal(
    planForPaths(["docs/x.md", "packages/git/widgets/index.tsx", "packages/server/src/ws.ts"]),
    "build+restart",
  );
  assert.equal(planForPaths(["docs/x.md", "CHANGELOG.md"]), "ignore");
});

test("restart policies control change-triggered restarts", () => {
  assert.equal(applyRestartPolicy("restart", "never"), "ignore");
  assert.equal(applyRestartPolicy("build+restart", "never"), "build");
  assert.equal(applyRestartPolicy("build", "auto"), "build");
  assert.equal(applyRestartPolicy("build", "always"), "build+restart");
  assert.equal(applyRestartPolicy("restart", "always"), "restart");
  assert.equal(applyRestartPolicy("ignore", "always"), "ignore");
});

test("backoff grows and is capped", () => {
  assert.equal(backoffDelay(1), BACKOFF_BASE_MS);
  assert.equal(backoffDelay(2), BACKOFF_BASE_MS * 2);
  assert.equal(backoffDelay(3), BACKOFF_BASE_MS * 4);
  assert.equal(backoffDelay(1000), BACKOFF_MAX_MS);
  for (let attempt = 2; attempt < 20; attempt += 1) {
    assert.ok(backoffDelay(attempt) >= backoffDelay(attempt - 1));
    assert.ok(backoffDelay(attempt) <= BACKOFF_MAX_MS);
  }
});

test("arguments default to a read-only filesystem watch", () => {
  const parsed = parseSupervisorArgs([]);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.options, DEFAULT_OPTIONS);
  assert.equal(parsed.options.pull, false);
  assert.equal(parsed.help, false);
});

test("default shutdown grace covers HTTP drain and authority receipt cleanup", () => {
  assert.ok(DEFAULT_OPTIONS.graceMs >= 13_000);
});

test("arguments are parsed and validated", () => {
  const parsed = parseSupervisorArgs([
    "--watch=both",
    "--restart=always",
    "--git-interval=30",
    "--grace=1500",
    "--max-crashes=2",
    "--no-initial-build",
    "--pull",
  ]);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.options, {
    watch: "both",
    gitIntervalMs: 30_000,
    pull: true,
    restart: "always",
    graceMs: 1_500,
    initialBuild: false,
    maxCrashes: 2,
    livenessMs: 60_000,
  });
});

test("the liveness window is configurable and can be turned off", () => {
  const custom = parseSupervisorArgs(["--liveness=120"]);
  assert.ok(custom.ok);
  assert.equal(custom.options.livenessMs, 120_000);
  const off = parseSupervisorArgs(["--liveness=off"]);
  assert.ok(off.ok);
  assert.equal(off.options.livenessMs, null);
  for (const raw of ["0", "abc", "", "5"]) {
    assert.equal(parseSupervisorArgs([`--liveness=${raw}`]).ok, false, `--liveness=${raw} should be rejected`);
  }
});

// ---- liveness watchdog -------------------------------------------------------
// A wedged server keeps its PID and listener; only probes can tell.

function runProbes(outcomes: readonly ProbeOutcome[], windowMs = 60_000) {
  let state = INITIAL_LIVENESS;
  let wedgedAt: number | null = null;
  outcomes.forEach((outcome, index) => {
    const verdict = nextLiveness(state, outcome, index * LIVENESS_PROBE_INTERVAL_MS, windowMs);
    state = verdict.state;
    if (verdict.wedged && wedgedAt === null) wedgedAt = index;
  });
  return { state, wedgedAt };
}

test("a server that never answered is never killed as wedged", () => {
  const booting = runProbes(Array<ProbeOutcome>(100).fill("timeout"));
  assert.equal(booting.wedgedAt, null, "slow boot work must not trip the watchdog");
  assert.equal(booting.state.armed, false);
});

test("timeouts spanning the window after a response mean wedged", () => {
  const { wedgedAt } = runProbes(["response", ...Array<ProbeOutcome>(30).fill("timeout")]);
  // First timeout at 5s; the window measures to the end of the timed-out probe.
  assert.equal(wedgedAt, 12);
  const timeouts = 12;
  assert.ok((timeouts - 1) * LIVENESS_PROBE_INTERVAL_MS + LIVENESS_PROBE_TIMEOUT_MS >= 60_000);
});

test("a stall that recovers inside the window resets the clock", () => {
  const recovering = [
    "response",
    ...Array<ProbeOutcome>(8).fill("timeout"),
    "response",
    ...Array<ProbeOutcome>(8).fill("timeout"),
    "response",
  ] satisfies ProbeOutcome[];
  const { wedgedAt, state } = runProbes(recovering);
  assert.equal(wedgedAt, null);
  assert.equal(state.unresponsiveSince, null);
});

test("a closed listener is a shutdown or restart, never a hang", () => {
  // A graceful drain closes the listener while agent turns finish; refused
  // connections must not accumulate toward a kill.
  const draining = runProbes(["response", ...Array<ProbeOutcome>(100).fill("unreachable")]);
  assert.equal(draining.wedgedAt, null);
  const mixed = runProbes([
    "response",
    ...Array<ProbeOutcome>(8).fill("timeout"),
    "unreachable",
    ...Array<ProbeOutcome>(8).fill("timeout"),
  ]);
  assert.equal(mixed.wedgedAt, null, "an unreachable probe breaks the timeout run");
});

test("the probe targets loopback unless the server binds a specific host", () => {
  assert.equal(livenessProbeHost(undefined), "127.0.0.1");
  assert.equal(livenessProbeHost("0.0.0.0"), "127.0.0.1");
  assert.equal(livenessProbeHost("::"), "127.0.0.1");
  assert.equal(livenessProbeHost("100.64.0.7"), "100.64.0.7");
  assert.equal(livenessProbeHost("[::1]"), "::1");
});

test("the supervisor runs the liveness watchdog and kills only the wedged server PID", async () => {
  const supervisor = await readFile(new URL("../supervisor.ts", import.meta.url), "utf8");
  assert.match(supervisor, /startLivenessWatchdog\(\);/);
  assert.match(supervisor, /path: "\/api\/health"/);
  assert.match(supervisor, /process\.kill\(target\.pid, "SIGKILL"\)/);
  // Planned stops and supervisor shutdown never race the watchdog.
  assert.match(supervisor, /probing \|\| shuttingDown \|\| stopping/);
});

test("bad arguments fail loudly", () => {
  const cases = [
    "--watch=maybe",
    "--restart=sometimes",
    "--git-interval=0",
    "--grace=abc",
    "--max-crashes=-1",
    "--turbo",
  ];
  for (const argument of cases) {
    const parsed = parseSupervisorArgs([argument]);
    assert.equal(parsed.ok, false, `${argument} should be rejected`);
  }
});

test("pulling requires git watching", () => {
  assert.equal(parseSupervisorArgs(["--pull"]).ok, false);
  assert.equal(parseSupervisorArgs(["--watch=git", "--pull"]).ok, true);
  assert.equal(parseSupervisorArgs(["--watch=both", "--pull"]).ok, true);
});

test("help is reported without failing", () => {
  const parsed = parseSupervisorArgs(["--help"]);
  assert.ok(parsed.ok);
  assert.equal(parsed.help, true);
});


test("watch builds disable automatic build freshness unless explicitly overridden", async () => {
  const supervisor = await readFile(new URL("../supervisor.ts", import.meta.url), "utf8");
  assert.match(
    supervisor,
    /POLYTH_WEB_BUILD_FRESHNESS:\s*process\.env\.POLYTH_WEB_BUILD_FRESHNESS\s*\?\?\s*"0"/,
  );
});

// ---- reconciliation sweep --------------------------------------------------
// The fs watcher is the low-latency trigger; the sweep is what makes a dropped
// inotify event recoverable instead of a silently ignored change.

test("a signature notices rewrites, replacements, truncation and metadata-preserving size changes", () => {
  const base = fsSignature({ mtimeMs: 1_000.7, ctimeMs: 1_001.2, size: 10, ino: 7 });
  assert.equal(base, "1000.7:1001.2:10:7");
  assert.notEqual(fsSignature({ mtimeMs: 1_000.7, size: 10 }), fsSignature({ mtimeMs: 1_000.7, size: 11 }));
  assert.notEqual(fsSignature({ mtimeMs: 1_000.7, size: 10 }), fsSignature({ mtimeMs: 2_000, size: 10 }));
  assert.notEqual(
    fsSignature({ mtimeMs: 1_000.7, ctimeMs: 1_001, size: 10, ino: 7 }),
    fsSignature({ mtimeMs: 1_000.7, ctimeMs: 1_002, size: 10, ino: 7 }),
    "same-size content writes advance ctime",
  );
  assert.notEqual(
    fsSignature({ mtimeMs: 1_000.7, ctimeMs: 1_001, size: 10, ino: 7 }),
    fsSignature({ mtimeMs: 1_000.7, ctimeMs: 1_001, size: 10, ino: 8 }),
    "atomic replacement changes inode even when timestamps and size match",
  );
});

test("the sweep diff reports added, removed and rewritten files, and nothing else", () => {
  const previous = new Map([
    ["apps/web/src/kept.ts", "1:1"],
    ["apps/web/src/rewritten.ts", "1:1"],
    ["apps/web/src/gone.ts", "1:1"],
  ]);
  const next = new Map([
    ["apps/web/src/kept.ts", "1:1"],
    ["apps/web/src/rewritten.ts", "2:5"],
    ["apps/web/src/added.ts", "3:3"],
  ]);
  assert.deepEqual(changedPaths(previous, next), [
    "apps/web/src/added.ts",
    "apps/web/src/gone.ts",
    "apps/web/src/rewritten.ts",
  ]);
  assert.deepEqual(changedPaths(next, next), [], "an unchanged tree never re-triggers work");
});

test("the sweep never descends into build output, dependencies or hidden state", () => {
  for (const name of ["node_modules", "dist", "release", "data", "artifacts", "logs", ".git", ".github"]) {
    assert.equal(isSweepDirectory(name), false, `${name} must stay out of the sweep`);
  }
  for (const name of ["src", "widgets", "packages", "components"]) {
    assert.equal(isSweepDirectory(name), true, `${name} must be swept`);
  }
});

test("the supervisor keeps a reconciliation sweep and re-arms a dead watcher", async () => {
  const supervisor = await readFile(new URL("../supervisor.ts", import.meta.url), "utf8");
  // The sweep starts with the watchers and reconciles the same roots.
  assert.match(supervisor, /startSweep\(\);/);
  assert.match(supervisor, /sweepTimer = setInterval\(sweepFilesystem, SWEEP_MS\)/);
  assert.match(supervisor, /for \(const \[path, signature\] of collectSignatures\(\)\) fsSignatures\.set\(path, signature\)/);
  // A watcher event keeps the sweep snapshot aligned, so one change is one build.
  assert.match(supervisor, /rememberSignature\(relativePath\);/);
  // A watcher that dies is dropped, re-armed, and covered by the sweep meanwhile.
  assert.match(supervisor, /watch error on .* — re-arming/);
  assert.match(supervisor, /setTimeout\(\(\) => watchDirectory\(directory, recursive\), WATCH_REARM_MS\)/);
  // A sweep-caught change is reported as such: a silent drop must be visible.
  assert.match(supervisor, /reconciled by sweep/);
});

test("a sweep catches a change that no watcher event ever reported", () => {
  // A tiny fake tree: apps/web/src/{a.ts, nested/b.ts} plus build output and a
  // dependency directory that must stay invisible to the sweep.
  const files = new Map<string, { mtimeMs: number; size: number }>([
    ["/repo/apps/web/src/a.ts", { mtimeMs: 1_000, size: 10 }],
    ["/repo/apps/web/src/nested/b.ts", { mtimeMs: 1_000, size: 20 }],
    ["/repo/apps/web/src/dist/output.js", { mtimeMs: 1_000, size: 30 }],
    ["/repo/apps/web/src/node_modules/dep/index.js", { mtimeMs: 1_000, size: 40 }],
  ]);
  const listings = new Map<string, Array<{ name: string; kind: "file" | "directory" | "other" }>>([
    ["/repo/apps/web/src", [
      { name: "a.ts", kind: "file" },
      { name: "nested", kind: "directory" },
      { name: "dist", kind: "directory" },
      { name: "node_modules", kind: "directory" },
    ]],
    ["/repo/apps/web/src/nested", [{ name: "b.ts", kind: "file" }]],
    ["/repo/apps/web/src/dist", [{ name: "output.js", kind: "file" }]],
    ["/repo/apps/web/src/node_modules", [{ name: "dep", kind: "directory" }]],
    ["/repo/apps/web/src/node_modules/dep", [{ name: "index.js", kind: "file" }]],
  ]);
  const fs = {
    readdir: (directory: string) => listings.get(directory) ?? [],
    stat: (path: string) => files.get(path) ?? null,
    join: (directory: string, name: string) => (directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`),
    relative: (path: string) => (path.startsWith("/repo/") ? path.slice("/repo/".length) : null),
  };
  const roots = [{ path: "/repo/apps/web/src", recursive: true }];

  const before = collectSweepSignatures(fs, roots);
  assert.deepEqual([...before.keys()].sort(), ["apps/web/src/a.ts", "apps/web/src/nested/b.ts"],
    "build output and dependencies are not swept");

  // The kernel dropped the event: the file changed on disk, no watcher
  // callback ran, and the signature map was never updated.
  files.set("/repo/apps/web/src/nested/b.ts", { mtimeMs: 2_000, size: 24 });
  files.set("/repo/apps/web/src/added.ts", { mtimeMs: 2_000, size: 5 });
  listings.get("/repo/apps/web/src")!.push({ name: "added.ts", kind: "file" });

  const after = collectSweepSignatures(fs, roots);
  assert.deepEqual(changedPaths(before, after), ["apps/web/src/added.ts", "apps/web/src/nested/b.ts"]);
  assert.deepEqual(changedPaths(after, collectSweepSignatures(fs, roots)), [],
    "an unchanged sweep produces no work");

  // A watcher-reported change refreshes the entry, so the sweep stays quiet
  // for it while still catching everything the watcher missed.
  files.set("/repo/apps/web/src/a.ts", { mtimeMs: 2_000, size: 50 });
  const reconciled = collectSweepSignatures(fs, roots);
  assert.equal(changedPaths(before, reconciled).includes("apps/web/src/a.ts"), true,
    "an un-refreshed change is still caught by the sweep");
  before.set("apps/web/src/a.ts", fsSignature({ mtimeMs: 2_000, size: 50 }));
  assert.equal(changedPaths(before, reconciled).includes("apps/web/src/a.ts"), false,
    "the watcher's own refresh prevents a duplicate build");
});

test("the build watchdog detects a stall, not a slow build", async () => {
  const supervisor = await readFile(new URL("../supervisor.ts", import.meta.url), "utf8");
  // A long but progressing build (a large worktree) must not be reported as a
  // failure; only a build that stops emitting output is wedged.
  assert.match(supervisor, /const BUILD_STALL_MS = 120_000;/);
  assert.match(supervisor, /const BUILD_MAX_MS = 900_000;/);
  assert.match(supervisor, /armStallWatchdog\(\);/);
  assert.match(supervisor, /build produced no output for \$\{BUILD_STALL_MS\}ms — killed/);
  assert.doesNotMatch(supervisor, /BUILD_TIMEOUT_MS/, "a total-duration cap is the false-negative this replaces");
});
