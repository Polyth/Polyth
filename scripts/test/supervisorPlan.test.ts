import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyRestartPolicy,
  backoffDelay,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  classifyChange,
  DEFAULT_OPTIONS,
  mergeActions,
  parseSupervisorArgs,
  planForPaths,
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

test("--restart=always upgrades bundle-only work", () => {
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
  });
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
