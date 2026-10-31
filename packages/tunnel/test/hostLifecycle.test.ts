import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLinkHostLifecycle } from "../src/hostLifecycle.ts";
import type { LinkHostClient } from "../src/host.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function host(): LinkHostClient {
  return {
    available: true, binaryFound: true, processReady: true, platformSupported: true,
    request: async () => ({}), onEvent: () => () => {}, close: async () => {},
  };
}

test("concurrent recovery waits for release and full initialization of a single replacement", async () => {
  const old = host();
  const replacement = host();
  const released = deferred();
  const initialized = deferred();
  let starts = 0;
  const order: string[] = [];
  const lifecycle = createLinkHostLifecycle({
    start: async () => { order.push("start"); return ++starts === 1 ? old : replacement; },
    initialize: async (client) => {
      if (client === replacement) { order.push("initialize"); await initialized.promise; }
    },
    release: async (client) => {
      if (client === old) { order.push("release"); await released.promise; }
      await client.close();
    },
    changed() {}, failed(error) { assert.fail(String(error)); },
  });
  try {
    await lifecycle.enable();
    old.available = false;
    const first = lifecycle.ensure();
    const second = lifecycle.ensure();
    assert.equal(first, second);
    assert.equal(starts, 1);
    assert.equal(lifecycle.ready, false);
    released.resolve();
    await delay(0);
    assert.equal(starts, 2);
    assert.equal(lifecycle.ready, false);
    initialized.resolve();
    assert.equal(await first, replacement);
    assert.equal(lifecycle.ready, true);
    assert.deepEqual(order, ["start", "release", "start", "initialize"]);
  } finally { released.resolve(); initialized.resolve(); await lifecycle.disable(); }
});

test("unconfirmed release retains the old authority and forbids replacement", async () => {
  const old = host();
  let starts = 0;
  let releaseConfirmed = false;
  const failures: unknown[] = [];
  const lifecycle = createLinkHostLifecycle({
    start: async () => { starts++; return old; }, initialize: async () => {},
    release: async () => { if (!releaseConfirmed) throw new Error("release unconfirmed"); },
    changed() {}, failed: (error) => { failures.push(error); },
  });
  await lifecycle.enable();
  old.available = false;
  assert.equal(await lifecycle.ensure(), null);
  assert.equal(await lifecycle.ensure(), null);
  assert.equal(lifecycle.host, old);
  assert.equal(lifecycle.ready, false);
  assert.equal(starts, 1);
  assert.equal(failures.length, 1);
  releaseConfirmed = true;
  await lifecycle.disable();
});

test("failed startup recovers in the background and synchronizes before admission", async () => {
  const missing = { ...host(), available: false, lastErrorCode: "host-binary-missing" };
  const replacement = host();
  let starts = 0;
  let syncs = 0;
  const available = deferred();
  const lifecycle = createLinkHostLifecycle({
    checkIntervalMs: 5,
    start: async () => ++starts === 1 ? missing : replacement,
    initialize: async () => { syncs++; }, release: async (client) => client.close(),
    changed() { if (lifecycle.ready) available.resolve(); }, failed() {},
  });
  try {
    await lifecycle.enable();
    assert.equal(lifecycle.ready, false);
    await Promise.race([available.promise, delay(500).then(() => assert.fail("no background recovery"))]);
    assert.equal(lifecycle.ready, true);
    assert.equal(starts, 2);
    assert.equal(syncs, 1);
  } finally { await lifecycle.disable(); }
});

test("disable during startup closes the late child without admitting it", async () => {
  const started = deferred();
  const client = host();
  let closes = 0;
  let initialized = false;
  const lifecycle = createLinkHostLifecycle({
    start: async () => { await started.promise; return client; },
    initialize: async () => { initialized = true; },
    release: async () => { closes++; }, changed() {}, failed() {},
  });
  const enabling = lifecycle.enable();
  const disabling = lifecycle.disable();
  started.resolve();
  await Promise.all([enabling, disabling]);
  assert.equal(closes, 1);
  assert.equal(initialized, false);
  assert.equal(lifecycle.ready, false);
  assert.equal(lifecycle.host, null);
  assert.equal(await lifecycle.ensure(), null);
});

test("a failed health RPC replaces the host without replaying any mutation", async () => {
  const old = host();
  const replacement = host();
  let starts = 0;
  const methods: string[] = [];
  old.request = async (method) => { methods.push(method); old.available = false; throw new Error("unresponsive"); };
  const recovered = deferred();
  const lifecycle = createLinkHostLifecycle({
    checkIntervalMs: 5,
    start: async () => ++starts === 1 ? old : replacement,
    initialize: async () => {}, release: async (client) => client.close(),
    changed() { if (starts === 2 && lifecycle.ready) recovered.resolve(); }, failed() {},
  });
  try {
    await lifecycle.enable();
    await Promise.race([recovered.promise, delay(500).then(() => assert.fail("no health recovery"))]);
    assert.deepEqual(methods, ["identity.status"]);
    assert.equal(lifecycle.host, replacement);
  } finally { await lifecycle.disable(); }
});

test("an ordinary RPC error does not destroy a responding host", async () => {
  const client = host();
  let starts = 0;
  let releases = 0;
  const observed = deferred();
  client.request = async () => { throw Object.assign(new Error("RPC rejected"), { code: "invalid-input" }); };
  const lifecycle = createLinkHostLifecycle({
    checkIntervalMs: 5,
    start: async () => { starts++; return client; }, initialize: async () => {},
    release: async () => { releases++; }, changed() {}, failed() { observed.resolve(); },
  });
  try {
    await lifecycle.enable();
    await Promise.race([observed.promise, delay(500).then(() => assert.fail("health check missing"))]);
    assert.equal(starts, 1);
    assert.equal(releases, 0);
    assert.equal(lifecycle.ready, true);
  } finally { await lifecycle.disable(); }
});

test("a health response from a disabled generation cannot restart or update it", async () => {
  const client = host();
  const requested = deferred();
  let rejectHealth!: (error: Error) => void;
  client.request = () => new Promise((_, reject) => { rejectHealth = reject; requested.resolve(); });
  let starts = 0;
  let failures = 0;
  const lifecycle = createLinkHostLifecycle({
    checkIntervalMs: 5,
    start: async () => { starts++; return client; }, initialize: async () => {},
    release: async () => {}, changed() {}, failed() { failures++; },
  });
  await lifecycle.enable();
  await Promise.race([requested.promise, delay(500).then(() => assert.fail("health check missing"))]);
  await lifecycle.disable();
  rejectHealth(new Error("late health response"));
  await delay(10);
  assert.equal(starts, 1);
  assert.equal(failures, 0);
  assert.equal(lifecycle.host, null);
  assert.equal(lifecycle.ready, false);
});
