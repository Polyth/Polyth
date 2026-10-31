import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createTransportRecovery } from "../src/transportRecovery.ts";
import { createOpenCodeTransport, OpenCodeTransportError } from "../src/transport.ts";
import { createBorrowedExternalEndpointLease, createOpenCodeRuntimeLifecycle } from "../src/index.ts";
import { createFakeOpenCode, httpFaults } from "./fakeOpenCode.ts";

test("concurrent REST failures share one verification/recovery and a bounded cooldown", async () => {
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => { unblock = resolve; });
  let probes = 0;
  let restarts = 0;
  let clock = 0;
  const recovery = createTransportRecovery({
    current: () => true, now: () => clock,
    async verify() { probes++; await barrier; return false; },
    async recover() { restarts++; },
  });
  for (let i = 0; i < 100; i++) recovery.failed();
  assert.equal(probes, 1);
  assert.equal(recovery.state(), "verifying");
  unblock();
  await recovery.settled();
  assert.equal(restarts, 1);
  assert.equal(recovery.state(), "blocked");
  recovery.failed();
  assert.equal(restarts, 1);
  for (let i = 0; i < 5; i++) { clock += 5_000; recovery.failed(); await recovery.settled(); }
  assert.equal(restarts, 3);
  recovery.dispose();
  clock += 5_000;
  recovery.failed();
  assert.equal(restarts, 3);
});

test("healthy probe retains degraded operation state; parser errors do not restart", async () => {
  for (const verify of [async () => true, async () => { throw new SyntaxError("malformed"); }]) {
    let restarts = 0;
    const recovery = createTransportRecovery({ current: () => true, verify, async recover() { restarts++; } });
    recovery.failed();
    await recovery.settled();
    assert.equal(restarts, 0);
    assert.notEqual(recovery.state(), "none");
    recovery.succeeded("unrelated-health");
    assert.notEqual(recovery.state(), "none", "an unrelated successful endpoint cannot heal the failed operation");
  }
});

test("SSE handshake and partial frames are bounded; comments are activity without events", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/headers") return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    if (req.url === "/partial") res.write('data: {"unfinished":');
    else if (req.url === "/large") res.write("data: " + "x".repeat(200));
    else res.write(": heartbeat\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const transport = createOpenCodeTransport({ baseUrl: `http://127.0.0.1:${address.port}`, sseHandshakeMs: 50, sseFrameMs: 50, sseMaxFrameBytes: 100 });
  try {
    for (const path of ["/headers", "/partial", "/large"]) {
      let opened = false;
      await assert.rejects(transport.stream({ path, signal: AbortSignal.timeout(2_000), onOpen() { opened = true; }, onEvent() { assert.fail("partial data emitted"); } }),
        (error: unknown) => error instanceof OpenCodeTransportError || (error as { code?: string }).code === "invalid-response");
      assert.equal(opened, path !== "/headers");
    }
    const stop = new AbortController();
    let activity = 0;
    let opened = 0;
    await assert.rejects(transport.stream({ path: "/comments", signal: stop.signal, onOpen() { opened++; }, onActivity() { activity++; stop.abort(); }, onEvent() { assert.fail("comment emitted"); } }), { name: "AbortError" });
    assert.equal(opened, 1);
    assert.equal(activity, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SSE alive / REST broken triggers one physical-lifecycle verification without replay", async () => {
  const fake = await createFakeOpenCode();
  const lease = await createBorrowedExternalEndpointLease({ url: fake.baseUrl, location: { directory: "/test" } });
  const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy", transport: { queryAttempts: 1 } });
  const stop = new AbortController();
  const stream = lifecycle.streamEvents({ signal: stop.signal, onEvent() {} }).catch(() => {});
  try {
    await fake.waitForSseConnections();
    const before = fake.requestCount("GET", "/global/health");
    fake.scriptHttp({ method: "GET", path: "/provider", steps: [httpFaults.connectionReset()] });
    await Promise.allSettled(Array.from({ length: 8 }, () => lifecycle.usingProtocol((protocol) => protocol.models())));
    await lifecycle.recoverySettled?.();
    assert.equal(fake.requestCount("GET", "/global/health"), before + 1);
    assert.equal(lifecycle.recoveryState?.(), "degraded");
    assert.equal(fake.requestCount("GET", "/provider"), 8);
  } finally { stop.abort(); await stream; await lifecycle.dispose(); await fake.close(); }
});
