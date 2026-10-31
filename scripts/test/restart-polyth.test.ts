import assert from "node:assert/strict";
import { test } from "node:test";
import { assetUrls, DEFAULT_OPTIONS, parseDeploymentEnv, parseRestartArgs, waitUntil } from "../restart-polyth.ts";

test("defaults wait for idle agents, boot-test the tree and never force", () => {
  const parsed = parseRestartArgs([]);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.options, DEFAULT_OPTIONS);
  assert.equal(DEFAULT_OPTIONS.force, false);
  assert.equal(DEFAULT_OPTIONS.skipCanary, false);
  assert.equal(DEFAULT_OPTIONS.worker, false);
});

test("flags are parsed", () => {
  const parsed = parseRestartArgs(["--force", "--full", "--skip-canary", "--max-wait=90", "--worker"]);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.options, {
    worker: true,
    full: true,
    force: true,
    skipCanary: true,
    maxWaitMs: 90_000,
  });
});

test("unknown flags and bad values fail loudly instead of restarting", () => {
  for (const argv of [["--frobnicate"], ["--max-wait"], ["--max-wait=0"], ["--max-wait=soon"]]) {
    assert.equal(parseRestartArgs(argv).ok, false, argv.join(" "));
  }
});

/** A clock that only moves when the loop sleeps. */
const fakeClock = () => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    elapsed: () => time,
  };
};

test("waitUntil returns the first value", async () => {
  const clock = fakeClock();
  let calls = 0;
  const value = await waitUntil(async () => (++calls === 3 ? "up" : undefined), {
    timeoutMs: 60_000,
    intervalMs: 1_000,
    ...clock,
  });
  assert.equal(value, "up");
  assert.equal(clock.elapsed(), 2_000);
});

test("waitUntil gives up at the deadline", async () => {
  const clock = fakeClock();
  const value = await waitUntil(async () => undefined, { timeoutMs: 5_000, intervalMs: 1_000, ...clock });
  assert.equal(value, undefined);
  assert.equal(clock.elapsed(), 5_000);
});

test("waitUntil with stable restarts the streak on a miss", async () => {
  const clock = fakeClock();
  // idle, busy, idle, idle: only the last two count as stable.
  const answers = [true, undefined, true, true];
  let calls = 0;
  const value = await waitUntil(async () => answers[calls++], {
    timeoutMs: 60_000,
    intervalMs: 1_000,
    stable: 2,
    ...clock,
  });
  assert.equal(value, true);
  assert.equal(calls, 4);
});

test("assetUrls lists the page, entry, marker and every package module and style", () => {
  assert.deepEqual(
    assetUrls({
      packages: [
        { id: "git", module: "/packages/git/entry.js", styles: ["/packages/git/entry.css?b=x"] },
        { id: "files", module: "/packages/files/entry.js", styles: [] },
        { id: "broken", module: 7, styles: "nope" },
      ],
    }),
    [
      "/",
      "/main.js",
      "/build-id.json",
      "/packages/git/entry.js",
      "/packages/git/entry.css?b=x",
      "/packages/files/entry.js",
    ],
  );
  assert.deepEqual(assetUrls(null), ["/", "/main.js", "/build-id.json"]);
  assert.deepEqual(assetUrls({ packages: "x" }), ["/", "/main.js", "/build-id.json"]);
});

test("deployment file lines become unit settings; comments and unknown keys are ignored", () => {
  assert.deepEqual(parseDeploymentEnv([
    "# published behind a TLS proxy",
    "",
    "HOST=0.0.0.0",
    "export POLYTH_PUBLIC_ORIGIN=\"https://polyth.example.com\"",
    "POLYTH_TRUSTED_PROXIES='10.0.0.5, 10.0.0.6'",
    "PATH=/tmp/evil",
    "not a setting",
  ].join("\n")), {
    HOST: "0.0.0.0",
    POLYTH_PUBLIC_ORIGIN: "https://polyth.example.com",
    POLYTH_TRUSTED_PROXIES: "10.0.0.5, 10.0.0.6",
  });
  assert.deepEqual(parseDeploymentEnv(""), {});
});
