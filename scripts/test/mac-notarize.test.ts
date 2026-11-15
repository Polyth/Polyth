import assert from "node:assert/strict";
import test from "node:test";
import { awaitNotarization, POLL_DELAYS_SECONDS } from "../ci/mac-notarize.mjs";

const quiet = () => {};

test("a poll that cannot reach Apple is retried instead of failing the build", async () => {
  const statuses = [null, undefined, null, "In Progress", "Accepted"];
  let polls = 0;
  const slept: number[] = [];
  const outcome = await awaitNotarization("sub-1", {
    info: () => ({ status: statuses[Math.min(polls++, statuses.length - 1)] ?? null }),
    dumpLog: () => { throw new Error("the notary log must not be requested for a network failure"); },
    sleepFn: async (ms: number) => { slept.push(ms); },
    log: quiet,
  });
  assert.equal(outcome, "Accepted");
  assert.equal(polls, statuses.length);
  assert.equal(slept.length, statuses.length - 1);
});

test("an explicit rejection fails at once and keeps Apple's log", async () => {
  const dumped: string[] = [];
  const outcome = await awaitNotarization("sub-2", {
    info: () => ({ status: "Invalid" }),
    dumpLog: (id: string) => { dumped.push(id); },
    sleepFn: async () => { throw new Error("a rejection must not wait"); },
    log: quiet,
  });
  assert.equal(outcome, "Invalid");
  assert.deepEqual(dumped, ["sub-2"]);
});

test("an unreachable notary for the whole budget is reported as unknown", async () => {
  let polls = 0;
  const outcome = await awaitNotarization("sub-3", {
    info: () => { polls += 1; return { status: null }; },
    dumpLog: () => {},
    sleepFn: async () => {},
    log: quiet,
  });
  assert.equal(outcome, "Unknown");
  assert.equal(polls, POLL_DELAYS_SECONDS.length + 1);
  assert.ok(POLL_DELAYS_SECONDS.length >= 6, "the budget has to outlast an Apple review");
});
