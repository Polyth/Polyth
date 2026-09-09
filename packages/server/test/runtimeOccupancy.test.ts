import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeyedRuntimeOwner } from "../src/runtimeOccupancy.ts";

const deferred = <T,>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const created = <T,>(value: T, onDispose: () => void | Promise<void> = () => undefined) => ({
  value,
  dispose: async () => { await onDispose(); },
});

test("occupancy tracks one binding and execution per session", async () => {
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  const entry = await owner.acquire("R", async () => created({ id: "R" }));
  assert.throws(
    () => entry.occupancy.beginExecution("session-a"),
    (error: Error & { code?: string }) => error.code === "unavailable",
  );
  entry.occupancy.acquireBinding("session-a");
  entry.occupancy.acquireBinding("session-b");
  entry.occupancy.acquireBinding("session-a");
  assert.equal(entry.occupancy.beginExecution("session-b"), true);
  assert.equal(entry.occupancy.beginExecution("session-b"), true);
  entry.occupancy.endExecution("session-b");
  assert.equal(entry.occupancy.snapshot().executions, 0);
  assert.equal(entry.occupancy.beginExecution("session-b"), true);
  entry.occupancy.releaseBinding("session-a");
  assert.deepEqual(entry.occupancy.snapshot(), { accepting: true, bindings: 1, executions: 1 });
  assert.throws(
    () => entry.occupancy.releaseBinding("session-b"),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  entry.occupancy.releaseBinding("session-b", { abandonExecution: true });
  assert.deepEqual(entry.occupancy.snapshot(), { accepting: true, bindings: 0, executions: 0 });
  entry.occupancy.acquireBinding("session-a");
  await owner.dispose("R", { force: true });
  assert.equal(entry.occupancy.beginExecution("session-a"), false);
  assert.throws(
    () => entry.occupancy.acquireBinding("session-b"),
    (error: Error & { code?: string }) => error.code === "unavailable",
  );
});

test("normal dispose refuses active bindings and executions", async () => {
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  let physical = 0;
  const entry = await owner.acquire("R", async () => created({ id: "only" }, () => { physical += 1; }));
  entry.occupancy.acquireBinding("session-a");
  await assert.rejects(
    () => owner.dispose("R"),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  entry.occupancy.beginExecution("session-a");
  await assert.rejects(
    () => owner.dispose("R"),
    (error: Error & { code?: string }) => error.code === "conflict",
  );
  entry.occupancy.endExecution("session-a");
  entry.occupancy.releaseBinding("session-a");
  await owner.dispose("R");
  assert.equal(physical, 1);
  assert.equal(owner.peek("R"), undefined);
});

test("transient executions hold a temporary binding until completion", async () => {
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  const entry = await owner.acquire("R", async () => created({ id: "R" }));
  assert.equal(entry.occupancy.beginTransientExecution("oneshot-task"), true);
  assert.deepEqual(entry.occupancy.snapshot(), { accepting: true, bindings: 1, executions: 1 });
  entry.occupancy.endTransientExecution("oneshot-task");
  assert.deepEqual(entry.occupancy.snapshot(), { accepting: true, bindings: 0, executions: 0 });
  await owner.dispose("R");
});

test("force bypasses occupancy only before the first teardown", async () => {
  let physical = 0;
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  const entry = await owner.acquire("R", async () => created({ id: "only" }, () => { physical += 1; }));
  entry.occupancy.acquireBinding("session-a");
  await Promise.all([
    owner.dispose("R", { force: true }),
    owner.dispose("R", { force: true }),
  ]);
  assert.equal(physical, 1);
});

test("releasing the last binding does not dispose the runtime", async () => {
  let physical = 0;
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  const entry = await owner.acquire("R", async () => created({ id: "R" }, () => { physical += 1; }));
  entry.occupancy.acquireBinding("session-a");
  entry.occupancy.acquireBinding("session-b");
  entry.occupancy.releaseBinding("session-a");
  entry.occupancy.releaseBinding("session-b");
  assert.equal(physical, 0);
  assert.equal(entry.occupancy.snapshot().accepting, true);
});

test("acquire while disposing waits for physical teardown before creating the next generation", async () => {
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  const allowDispose = deferred<void>();
  const secondFactory = deferred<void>();
  let factories = 0;
  let disposedFirst = false;

  const first = await owner.acquire("R", async () => created({ id: "R1" }, async () => {
    await allowDispose.promise;
    disposedFirst = true;
  }));
  const disposal = owner.dispose("R");
  let secondStarted = false;
  const second = owner.acquire("R", async () => {
    secondStarted = true;
    assert.equal(disposedFirst, true, "R2 must not start while R1 is still disposing");
    factories += 1;
    secondFactory.resolve();
    return created({ id: "R2" });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  allowDispose.resolve();
  await disposal;
  await secondFactory.promise;
  assert.equal((await second).value.id, "R2");
  assert.equal(first.value.id, "R1");
});

test("concurrent acquire of the same key creates one runtime", async () => {
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  let factories = 0;
  const gate = deferred<void>();
  const factory = async () => {
    factories += 1;
    await gate.promise;
    return created({ id: "only" });
  };
  const waiters = [owner.acquire("R", factory), owner.acquire("R", factory), owner.acquire("R", factory)];
  gate.resolve();
  const entries = await Promise.all(waiters);
  assert.equal(factories, 1);
  assert.equal(entries[0]!.value, entries[1]!.value);
});

test("failed creation fails every waiter and evicts the cache", async () => {
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  const started = deferred<void>();
  const finish = deferred<{ id: string }>();
  let factories = 0;
  const factory = async () => {
    factories += 1;
    started.resolve();
    return created(await finish.promise);
  };
  const first = owner.acquire("R", factory);
  await started.promise;
  const second = owner.acquire("R", factory);
  finish.reject(Object.assign(new Error("spawn failed"), { code: "unavailable" }));
  await assert.rejects(() => first, /spawn failed/);
  await assert.rejects(() => second, /spawn failed/);
  assert.equal(factories, 1);
  const recovered = await owner.acquire("R", async () => created({ id: "next" }));
  assert.equal(recovered.value.id, "next");
});

test("failed physical teardown permanently fences the key, including force", async () => {
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  let attempts = 0;
  await owner.acquire("R", async () => created({ id: "R1" }, () => {
    attempts += 1;
    throw Object.assign(new Error("teardown ambiguous"), { code: "unavailable" });
  }));
  await assert.rejects(() => owner.dispose("R"), /teardown ambiguous/);
  await assert.rejects(
    () => owner.dispose("R", { force: true }),
    (error: Error & { code?: string }) => error.code === "unavailable",
  );
  assert.equal(attempts, 1);
  let factories = 0;
  await assert.rejects(
    () => owner.acquire("R", async () => {
      factories += 1;
      return created({ id: "R2" });
    }),
    (error: Error & { code?: string }) => error.code === "unavailable",
  );
  assert.equal(factories, 0);
  assert.equal(owner.busy("R"), true);
});

test("disposeAll surfaces physical teardown failures", async () => {
  const owner = createKeyedRuntimeOwner<{ id: string }>();
  await owner.acquire("A", async () => created({ id: "A" }, () => {
    throw new Error("kill A failed");
  }));
  await owner.acquire("B", async () => created({ id: "B" }));
  await assert.rejects(() => owner.disposeAll({ force: true }), /kill A failed/);
});
