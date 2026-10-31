import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpawnTelemetry } from "../src/spawnTelemetry.ts";

function clocks(start = 1000) {
  let mono = start;
  return { now: () => mono, wallNow: () => 1_700_000_000_000 + mono, advance: (ms: number) => { mono += ms; } };
}

test("records ordered stage timings against a fixed start", async () => {
  const c = clocks();
  const t = createSpawnTelemetry(c);
  t.begin("s1");
  await t.time("s1", "runtimeAcquireMs", async () => { c.advance(30); });
  await t.time("s1", "nativeSessionCreateMs", async () => { c.advance(20); });
  await t.time("s1", "turnAdmissionMs", async () => { c.advance(5); });
  c.advance(45);
  t.firstRuntimeEvent("s1");
  t.update("s1", { warmRuntimeHit: false, runtimeSpawnMs: 28, harnessId: "opencode" });
  assert.deepEqual(t.get("s1"), {
    startedAt: 1_700_000_001_000,
    runtimeAcquireMs: 30, nativeSessionCreateMs: 20, turnAdmissionMs: 5,
    firstRuntimeEventMs: 100, warmRuntimeHit: false, runtimeSpawnMs: 28, harnessId: "opencode",
  });
});

test("unmeasured stages stay unknown rather than zero", () => {
  const t = createSpawnTelemetry(clocks());
  t.begin("s");
  assert.deepEqual(Object.keys(t.get("s")!), ["startedAt"]);
});

test("failures record duration and preserve the original rejection and return value", async () => {
  const c = clocks();
  const t = createSpawnTelemetry(c);
  t.begin("s");
  const boom = new Error("native down");
  await assert.rejects(t.time("s", "nativeSessionCreateMs", async () => { c.advance(7); throw boom; }), (e) => e === boom);
  assert.equal(t.get("s")!.nativeSessionCreateMs, 7);
  assert.equal(await t.time("s", "runtimeAcquireMs", async () => "value"), "value");
  assert.equal(t.get("s")!.runtimeAcquireMs, 0);
  assert.equal(JSON.stringify(t.get("s")).includes("native down"), false);
});

test("only the first measurement of a stage is kept", async () => {
  const c = clocks();
  const t = createSpawnTelemetry(c);
  t.begin("s");
  await t.time("s", "turnAdmissionMs", async () => { c.advance(4); });
  await t.time("s", "turnAdmissionMs", async () => { c.advance(90); });
  assert.equal(t.get("s")!.turnAdmissionMs, 4);
});

test("first runtime event is stamped once and begin keeps the original start", () => {
  const c = clocks();
  const t = createSpawnTelemetry(c);
  const token = t.begin("s");
  c.advance(10);
  t.firstRuntimeEvent("s");
  c.advance(10);
  t.firstRuntimeEvent("s");
  assert.equal(t.begin("s"), token);
  assert.equal(t.get("s")!.firstRuntimeEventMs, 10);
  assert.equal(t.get("s")!.startedAt, 1_700_000_001_000);
});

test("durations are nonnegative even if the clock steps back", async () => {
  const c = clocks();
  const t = createSpawnTelemetry(c);
  t.begin("s");
  await t.time("s", "runtimeAcquireMs", async () => { c.advance(-50); });
  t.firstRuntimeEvent("s");
  assert.equal(t.get("s")!.runtimeAcquireMs, 0);
  assert.equal(t.get("s")!.firstRuntimeEventMs, 0);
});

test("get returns a detached copy", () => {
  const t = createSpawnTelemetry(clocks());
  t.begin("s");
  const snap = t.get("s")!;
  snap.startedAt = 1;
  snap.harnessId = "x";
  assert.equal(t.get("s")!.startedAt, 1_700_000_001_000);
  assert.equal(t.get("s")!.harnessId, undefined);
});

test("update ignores invalid metadata and bounds harness id", () => {
  const t = createSpawnTelemetry(clocks());
  t.begin("s");
  t.update("s", { runtimeSpawnMs: Number.NaN, harnessId: "", warmRuntimeHit: "yes" as unknown as boolean });
  assert.deepEqual(Object.keys(t.get("s")!), ["startedAt"]);
  t.update("s", { harnessId: "h".repeat(500), runtimeSpawnMs: -3 });
  assert.equal(t.get("s")!.harnessId!.length, 128);
  assert.equal(t.get("s")!.runtimeSpawnMs, 0);
});

test("capacity evicts the oldest sample", () => {
  const t = createSpawnTelemetry({ ...clocks(), limit: 2 });
  t.begin("a"); t.begin("b"); t.begin("c");
  assert.equal(t.size, 2);
  assert.equal(t.get("a"), undefined);
  assert.ok(t.get("b") && t.get("c"));
  assert.equal(createSpawnTelemetry({ ...clocks(), limit: 0 }).size, 0);
});

test("missing entries never throw or resurrect samples, and action still runs", async () => {
  const c = clocks();
  const t = createSpawnTelemetry(c);
  t.update("x", { harnessId: "h" });
  t.firstRuntimeEvent("x");
  t.forget("x");
  assert.equal(await t.time("x", "runtimeAcquireMs", async () => 5), 5);
  await assert.rejects(t.time("x", "runtimeAcquireMs", async () => { throw new Error("e"); }), /e/);
  assert.equal(t.get("x"), undefined);
  assert.equal(t.size, 0);
});

test("forget during an action drops the late phase; tokens fence a re-begun session", async () => {
  const c = clocks();
  const t = createSpawnTelemetry(c);
  const old = t.begin("s");
  await t.time("s", "nativeSessionCreateMs", async () => { t.forget("s"); c.advance(3); });
  assert.equal(t.get("s"), undefined);
  const fresh = t.begin("s");
  assert.notEqual(fresh, old);
  await t.time("s", "turnAdmissionMs", async () => { c.advance(2); }, old);
  t.update("s", { harnessId: "stale" }, old);
  t.firstRuntimeEvent("s", old);
  assert.deepEqual(Object.keys(t.get("s")!), ["startedAt"]);
  t.firstRuntimeEvent("s", fresh);
  assert.equal(t.get("s")!.firstRuntimeEventMs, 2);
});

test("throwing clocks never break recording", async () => {
  const t = createSpawnTelemetry({ now: () => { throw new Error("clock"); }, wallNow: () => 1 });
  t.begin("s");
  assert.equal(await t.time("s", "runtimeAcquireMs", async () => 1), 1);
  t.firstRuntimeEvent("s");
  assert.equal(t.get("s"), undefined);
});

test("clear drops all samples and makes outstanding tokens inert", async () => {
  const t = createSpawnTelemetry(clocks());
  const token = t.begin("a");
  t.begin("b");
  t.clear();
  assert.equal(t.size, 0);
  assert.equal(t.get("a"), undefined);
  await t.time("a", "runtimeAcquireMs", async () => 1, token);
  assert.equal(t.get("a"), undefined);
});
