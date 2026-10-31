import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_OPENCODE_RUNTIME_POLICY, type OpenCodeRuntimePolicyDto } from "@polyth/contracts";
import { createRuntimeIdleController } from "../src/runtimeIdle.ts";
import { createRuntimeWarmPolicy, openCodeIdleTtlMs } from "../src/runtimeWarmPolicy.ts";

const noTimer = () => ({ dispose() {} });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(policy: OpenCodeRuntimePolicyDto = { ...DEFAULT_OPENCODE_RUNTIME_POLICY }) {
  let now = 0;
  const policies = new Map<string, OpenCodeRuntimePolicyDto>([["a", policy]]);
  const evicted: string[] = [];
  let errors = 0;
  const manager = createRuntimeWarmPolicy({ readPolicy: (spaceId) => policies.get(spaceId), schedule: noTimer, onError: () => { errors += 1; } });
  const add = (key: string, spaceId = "a", canEvict: () => Promise<boolean> = async () => true) => {
    let busy = false;
    const controller = createRuntimeIdleController({
      now: () => now, schedule: noTimer, onActivity: manager.activity,
      withAdmissionBarrier: (action) => action(), canEvict: async () => !busy && !manager.isAcquiring(key) && await canEvict(),
      evict: async () => { evicted.push(key); },
    });
    const registration = manager.register(key, spaceId, controller, () => busy);
    return { controller, registration, busy: (value: boolean) => { busy = value; } };
  };
  return { manager, policies, evicted, add, time: (value: number) => { now = value; }, errors: () => errors };
}

test("Default, Keep warm and Off select their distinct idle deadlines", async () => {
  assert.equal(openCodeIdleTtlMs({ ...DEFAULT_OPENCODE_RUNTIME_POLICY }), 600_000);
  assert.equal(openCodeIdleTtlMs({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, mode: "keep-warm", idleTtlMinutes: 90 }), 5_400_000);
  const f = fixture({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, mode: "keep-warm", idleTtlMinutes: 90 });
  const { controller } = f.add("workspace");
  f.time(600_000);
  assert.equal(await controller.attemptEviction(), false);
  f.time(5_400_000);
  assert.equal(await controller.attemptEviction(), true);
  const off = fixture({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, mode: "off" });
  const ready = off.add("off-workspace");
  assert.equal(await ready.controller.attemptEviction(), true);
  f.manager.dispose(); off.manager.dispose();
});

test("workspace pressure evicts least recently used candidates separately in each Space", async () => {
  const f = fixture({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, maxWarmWorkspaces: 1 });
  f.policies.set("b", { ...DEFAULT_OPENCODE_RUNTIME_POLICY, maxWarmWorkspaces: 2 });
  const first = f.add("a-old");
  f.time(10); f.add("a-new");
  f.time(20); first.controller.touch();
  f.add("b-one", "b"); f.add("b-two", "b");
  await f.manager.sweep();
  assert.deepEqual(f.evicted, ["a-new"], "touching the older creation makes it the newest use");
  f.manager.dispose();
});

test("active calls, occupied sessions and uncertain safety stay outside the warm budget", async () => {
  const f = fixture({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, maxWarmWorkspaces: 1 });
  const occupied = f.add("bound"); occupied.busy(true);
  f.add("uncertain", "a", async () => false);
  const inUse = f.add("call");
  const done = deferred();
  const call = inUse.controller.use(() => done.promise);
  f.time(1); f.add("old-idle");
  f.time(2); f.add("new-idle");
  await f.manager.sweep();
  assert.deepEqual(f.evicted, ["old-idle"]);
  done.resolve(); await call;
  f.manager.dispose();
});

test("in-flight acquisition protects native startup and releases its hold on failure", async () => {
  const f = fixture({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, mode: "off" });
  const startup = f.add("startup");
  const ready = deferred();
  const error = new Error("factory failed");
  const acquired = f.manager.acquire("startup", async () => { await ready.promise; throw error; });
  const rejection = assert.rejects(acquired, (cause) => cause === error);
  await f.manager.sweep();
  assert.deepEqual(f.evicted, []);
  assert.equal(await startup.controller.attemptEviction(), false);
  ready.resolve(); await rejection;
  assert.equal(f.manager.isAcquiring("startup"), false);
  await f.manager.sweep();
  assert.deepEqual(f.evicted, ["startup"]);
  f.manager.dispose();
});

test("policy changes during a safety proof invalidate eviction, including budget-only edits", async () => {
  const f = fixture({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, maxWarmWorkspaces: 1 });
  const entered = deferred(); const finish = deferred();
  f.add("old", "a", async () => { entered.resolve(); await finish.promise; return true; });
  f.time(1); f.add("new");
  const sweep = f.manager.sweep();
  await entered.promise;
  f.policies.set("a", { ...DEFAULT_OPENCODE_RUNTIME_POLICY, maxWarmWorkspaces: 2 });
  f.manager.refresh("a");
  finish.resolve(); await sweep;
  assert.deepEqual(f.evicted, []);
  f.manager.dispose();
});

test("a new acquisition racing an LRU proof invalidates it before native wiring", async () => {
  const f = fixture({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, maxWarmWorkspaces: 1 });
  const entered = deferred(); const finish = deferred(); const acquired = deferred();
  f.add("old", "a", async () => { entered.resolve(); await finish.promise; return true; });
  f.time(1); f.add("new");
  const sweep = f.manager.sweep(); await entered.promise;
  f.time(2);
  const pending = f.manager.acquire("old", () => acquired.promise);
  finish.resolve(); await sweep;
  assert.deepEqual(f.evicted, []);
  acquired.resolve(); await pending;
  await f.manager.sweep();
  assert.deepEqual(f.evicted, ["new"]);
  f.manager.dispose();
});

test("activity racing an LRU safety proof protects the now-used workspace", async () => {
  const f = fixture({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, maxWarmWorkspaces: 1 });
  const entered = deferred(); const finish = deferred();
  const old = f.add("old", "a", async () => { entered.resolve(); await finish.promise; return true; });
  f.time(1); f.add("new");
  const sweep = f.manager.sweep(); await entered.promise;
  f.time(2); old.controller.touch();
  finish.resolve(); await sweep;
  assert.deepEqual(f.evicted, []);
  await f.manager.sweep();
  assert.deepEqual(f.evicted, ["new"]);
  f.manager.dispose();
});

test("a retention change applies to existing runtimes without a process restart", async () => {
  const f = fixture(); const a = f.add("a"); const b = f.add("b", "b");
  f.time(500_000);
  f.policies.set("a", { ...DEFAULT_OPENCODE_RUNTIME_POLICY, mode: "off" });
  f.manager.refresh("a");
  assert.equal(await a.controller.attemptEviction(), true);
  assert.equal(await b.controller.attemptEviction(), false);
  f.manager.dispose();
});

test("budget pressure joining a timer check still proves safety without waiting for expiry", async () => {
  let proofs = 0; let evictions = 0;
  const controller = createRuntimeIdleController({ now: () => 0, schedule: noTimer, withAdmissionBarrier: (work) => work(), canEvict: async () => { proofs += 1; return true; }, evict: async () => { evictions += 1; } });
  const timerCheck = controller.attemptEviction();
  const pressure = controller.attemptEviction({ ignoreTtl: true, activityVersion: controller.snapshot().activityVersion });
  assert.equal(await timerCheck, false);
  assert.equal(await pressure, true);
  assert.equal(proofs, 1); assert.equal(evictions, 1);
});

test("failed release is reported and never retried as a successful eviction", async () => {
  let attempts = 0; let errors = 0;
  const manager = createRuntimeWarmPolicy({ readPolicy: () => ({ ...DEFAULT_OPENCODE_RUNTIME_POLICY, mode: "off" }), schedule: noTimer, onError: () => { errors += 1; } });
  const controller = createRuntimeIdleController({ schedule: noTimer, withAdmissionBarrier: (work) => work(), canEvict: async () => true, evict: async () => { attempts += 1; throw new Error("release proof missing"); } });
  manager.register("key", "a", controller, () => false);
  await manager.sweep();
  assert.equal(attempts, 1); assert.equal(errors, 1);
  assert.equal(controller.snapshot().stopped, false);
  manager.dispose(); controller.stop();
});

test("Off retries protected runtimes without a millisecond busy loop; dispose cancels work", async () => {
  const delays: number[] = [];
  let cancellations = 0;
  const controller = createRuntimeIdleController({ idleTtlMs: 0, schedule: (_action, delay) => { delays.push(delay); return { dispose: () => { cancellations += 1; } }; }, withAdmissionBarrier: (work) => work(), canEvict: async () => false, evict: async () => { throw new Error("must stay protected"); } });
  assert.equal(await controller.attemptEviction(), false);
  assert.equal(delays.at(-1), 30_000);
  controller.stop();
  assert.ok(cancellations > 0);
  assert.equal(await controller.attemptEviction(), false);
  const f = fixture(); f.add("idle"); f.manager.dispose();
  await f.manager.sweep(); assert.deepEqual(f.evicted, []);
});
