import assert from "node:assert/strict";
import { test } from "node:test";
import { watchEventLoopStalls, type EventLoopStall } from "../src/eventLoopStall.ts";

const busyWait = (ms: number): void => {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* hold the event loop */ }
};
const tick = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

test("a blocked event loop is reported once it runs again", async () => {
  const stalls: EventLoopStall[] = [];
  const stop = watchEventLoopStalls({ sampleMs: 20, warnMs: 150, report: (stall) => stalls.push(stall) });
  try {
    await tick(50);
    assert.equal(stalls.length, 0, "an idle loop is quiet");
    busyWait(300);
    await tick(60);
    assert.equal(stalls.length, 1);
    assert.ok(stalls[0]!.blockedMs >= 150, `blocked ${stalls[0]!.blockedMs}ms`);
    assert.ok(stalls[0]!.blockedMs < 1_000);
  } finally {
    stop();
  }
});

test("the disposer stops sampling", async () => {
  const stalls: EventLoopStall[] = [];
  const stop = watchEventLoopStalls({ sampleMs: 20, warnMs: 50, report: (stall) => stalls.push(stall) });
  stop();
  busyWait(150);
  await tick(60);
  assert.equal(stalls.length, 0);
});
