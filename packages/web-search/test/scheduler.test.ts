import assert from "node:assert/strict";
import test from "node:test";
import { createSearchScheduler } from "../src/scheduler.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("scheduler bounds concurrency per key and preserves completion order", async () => {
  const scheduler = createSearchScheduler({ maximumConcurrent: 1, minimumIntervalMs: 0 });
  const first = deferred<string>();
  let active = 0;
  let peak = 0;
  const task = (value: string) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    if (value === "first") await first.promise;
    active -= 1;
    return value;
  };
  const one = scheduler.run("space", task("first"));
  const two = scheduler.run("space", task("second"));
  await Promise.resolve();
  assert.equal(peak, 1);
  first.resolve("first");
  assert.deepEqual(await Promise.all([one, two]), ["first", "second"]);
  assert.equal(peak, 1);
});

test("scheduler removes an aborted queued request and close rejects remaining work", async () => {
  const scheduler = createSearchScheduler({ maximumConcurrent: 1, minimumIntervalMs: 0 });
  const first = deferred<string>();
  const running = scheduler.run("space", () => first.promise);
  const abort = new AbortController();
  const queued = scheduler.run("space", async () => "queued", abort.signal);
  abort.abort();
  await assert.rejects(queued, (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "aborted");
    return true;
  });
  const afterAbort = scheduler.run("space", async () => "after");
  scheduler.close();
  await assert.rejects(afterAbort, (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "unavailable");
    return true;
  });
  first.resolve("done");
  assert.equal(await running, "done");
  await assert.rejects(scheduler.run("space", async () => "later"), /shutting down/);
});
