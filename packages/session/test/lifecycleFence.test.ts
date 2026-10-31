import test from "node:test";
import assert from "node:assert/strict";
import { createLifecycleFence } from "../src/lifecycleFence.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("readStable retries a response that overlaps a lifecycle mutation", async () => {
  const fence = createLifecycleFence();
  const stale = deferred<string>();
  const mutation = deferred<void>();
  let reads = 0;

  const result = fence.readStable(async () => {
    reads += 1;
    return reads === 1 ? stale.promise : "fresh";
  });

  const mutating = fence.mutate(() => mutation.promise);
  stale.resolve("stale");
  await Promise.resolve();
  assert.equal(reads, 1, "retry waits until the mutation settles");

  mutation.resolve();
  await mutating;
  assert.equal(await result, "fresh");
  assert.equal(reads, 2);
});

test("readStable does not start transport work while a mutation is active", async () => {
  const fence = createLifecycleFence();
  const mutation = deferred<void>();
  const mutating = fence.mutate(() => mutation.promise);
  let reads = 0;

  const result = fence.readStable(async () => {
    reads += 1;
    return "stable";
  });

  await Promise.resolve();
  assert.equal(reads, 0);
  mutation.resolve();
  await mutating;
  assert.equal(await result, "stable");
  assert.equal(reads, 1);
});

test("failed mutations invalidate overlapping reads and release the idle barrier", async () => {
  const fence = createLifecycleFence();
  const stale = deferred<string>();
  const failure = deferred<void>();
  let reads = 0;

  const result = fence.readStable(async () => {
    reads += 1;
    return reads === 1 ? stale.promise : "after-failure";
  });
  const mutating = fence.mutate(() => failure.promise);

  stale.resolve("stale");
  failure.reject(new Error("mutation failed"));
  await assert.rejects(mutating, /mutation failed/);
  assert.equal(await result, "after-failure");
  assert.equal(reads, 2);
});
