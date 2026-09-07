import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PAYLOAD_BYTES,
  createMethodRegistry,
  createRateLimiter,
  parseEnvelope,
  requestEnvelope,
  responseError,
  responseOk,
  sandboxHandshakeReady,
  eventEnvelope,
  verifySandboxHello,
} from "../src/protocol.ts";
import { parseRemoteUiTree } from "../src/remoteUi.ts";
import { connectPolyth } from "../src/client.ts";
import { PROTOCOL_CHANNEL, PROTOCOL_VERSION } from "../src/protocol.ts";

test("protocol envelopes reject unknown channels, versions, and oversized payloads", () => {
  assert.equal(parseEnvelope({ channel: "nope", v: 1, kind: "request", id: "1", method: "x" }), null);
  assert.equal(parseEnvelope({ channel: PROTOCOL_CHANNEL, v: 99, kind: "request", id: "1", method: "x" }), null);
  const huge = requestEnvelope("1", "x", { blob: "a".repeat(MAX_PAYLOAD_BYTES) });
  assert.equal(parseEnvelope(huge), null);
  const ok = parseEnvelope(requestEnvelope("1", "ui.toast", { message: "hi" }));
  assert.equal(ok?.method, "ui.toast");
  const err = parseEnvelope(responseError("1", "CAPABILITY_DENIED", "nope"));
  assert.equal(err?.ok, false);
  assert.equal(err?.error?.code, "CAPABILITY_DENIED");
});

test("method registry enforces granted capabilities", async () => {
  const registry = createMethodRegistry([
    {
      method: "ui.toast",
      capability: "ui.toast",
      invoke: (_ctx, payload) => payload,
    },
  ]);
  await assert.rejects(
    () => registry.invoke("missing", {
      packageId: "p", runtimeInstanceId: "r", surfaceId: "s",
      capabilities: new Set(),
    }, {}),
    /unknown method/,
  );
  await assert.rejects(
    () => registry.invoke("ui.toast", {
      packageId: "p", runtimeInstanceId: "r", surfaceId: "s",
      capabilities: new Set(),
    }, {}),
    /not granted/,
  );
  const result = await registry.invoke("ui.toast", {
    packageId: "p", runtimeInstanceId: "r", surfaceId: "s",
    capabilities: new Set(["ui.toast"]),
  }, { message: "ok" });
  assert.deepEqual(result, { message: "ok" });
});

test("method registry distinguishes undeclared from denied capabilities", async () => {
  const registry = createMethodRegistry([
    {
      method: "ui.toast",
      capability: "ui.toast",
      invoke: () => ({ ok: true }),
    },
  ]);
  const base = {
    packageId: "p", runtimeInstanceId: "r", surfaceId: "s",
  };
  await assert.rejects(
    () => registry.invoke("ui.toast", { ...base, capabilities: new Set(), declared: new Set() }, {}),
    (error: Error & { code?: string }) => error.code === "CAPABILITY_UNDECLARED",
  );
  await assert.rejects(
    () => registry.invoke("ui.toast", {
      ...base, capabilities: new Set(), declared: new Set(["ui.toast"]),
    }, {}),
    (error: Error & { code?: string }) => error.code === "CAPABILITY_DENIED",
  );
});

test("sandbox hello rejects wrong source, nonce, and channel", () => {
  const source = { id: "iframe" };
  const hello = { channel: PROTOCOL_CHANNEL, kind: "hello", mountNonce: "abc" };
  assert.equal(verifySandboxHello({
    eventSource: source, expectedSource: source, data: hello, mountNonce: "abc",
  }), true);
  assert.equal(verifySandboxHello({
    eventSource: { id: "other" }, expectedSource: source, data: hello, mountNonce: "abc",
  }), false);
  assert.equal(verifySandboxHello({
    eventSource: source, expectedSource: source, data: hello, mountNonce: "nope",
  }), false);
  assert.equal(verifySandboxHello({
    eventSource: source, expectedSource: source,
    data: { ...hello, channel: "other" }, mountNonce: "abc",
  }), false);
});

test("client handshake times out and dispose rejects later RPC", async () => {
  const idle = new MessageChannel();
  idle.port2.start();
  await assert.rejects(
    () => connectPolyth({ port: idle.port2, requestTimeoutMs: 40 }),
    /did not answer/,
  );
  idle.port1.close();
  idle.port2.close();

  const { port1, port2 } = new MessageChannel();
  port1.start();
  port1.addEventListener("message", (event) => {
    const data = event.data as { kind?: string; id?: string; method?: string };
    if (data.kind === "request" && data.method === "runtime.hello" && data.id) {
      port1.postMessage(responseOk(data.id, sandboxHandshakeReady({
        packageId: "com-example-hello",
        packageVersion: "1.0.0",
        runtimeInstanceId: "rt-1",
        surfaceId: "main",
        capabilities: ["ui.toast"],
        theme: { mode: "dark" },
        locale: "en",
      })));
    }
  });
  const host = await connectPolyth({ port: port2, requestTimeoutMs: 200 });
  host.dispose();
  await assert.rejects(() => host.ui.toast({ message: "late" }), /disposed/);
});

test("cancel envelopes are not part of v1 protocol", () => {
  const envelope = parseEnvelope({
    channel: PROTOCOL_CHANNEL,
    v: PROTOCOL_VERSION,
    kind: "cancel",
    id: "p-1",
  });
  assert.equal(envelope, null);
});

test("rate limiter rejects floods", () => {
  const limiter = createRateLimiter(3, 10_000);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
});

test("remote UI bounds depth, nodes, and strings", () => {
  const tree = parseRemoteUiTree({
    type: "stack",
    children: [
      { type: "heading", text: "Hi", level: 1 },
      { type: "button", label: "Go", action: "go" },
    ],
  });
  assert.equal(tree.type, "stack");
  assert.equal(tree.children?.[1]?.action, "go");
  const deep = { type: "stack", children: [] as unknown[] };
  let cursor = deep;
  for (let i = 0; i < 20; i++) {
    const next = { type: "stack", children: [] as unknown[] };
    cursor.children = [next];
    cursor = next;
  }
  assert.throws(() => parseRemoteUiTree(deep), /depth/);
  assert.throws(() => parseRemoteUiTree({ type: "stack", children: Array.from({ length: 250 }, () => ({ type: "text", text: "x" })) }), /node/);
});

test("MessageChannel client handshake and capability RPC", async () => {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  port1.addEventListener("message", (event) => {
    const data = event.data as { kind?: string; id?: string; method?: string };
    if (data.kind === "request" && data.method === "runtime.hello" && data.id) {
      port1.postMessage(responseOk(data.id, sandboxHandshakeReady({
        packageId: "com-example-hello",
        packageVersion: "1.0.0",
        runtimeInstanceId: "rt-1",
        surfaceId: "main",
        capabilities: ["ui.toast"],
        theme: { mode: "dark" },
        locale: "en",
      })));
    }
    if (data.kind === "request" && data.method === "ui.toast" && data.id) {
      port1.postMessage(responseOk(data.id));
    }
  });
  const host = await connectPolyth({ port: port2 });
  assert.equal(host.hasCapability("ui.toast"), true);
  assert.equal(host.hasCapability("network.fetch"), false);
  await host.ui.toast({ kind: "info", message: "hi" });
  host.dispose();
});

test("sandbox handshake omits session, project, space, grant snapshots, and composerAction", () => {
  const ready = sandboxHandshakeReady({
    packageId: "com-example-hello",
    packageVersion: "1.0.0",
    runtimeInstanceId: "rt-1",
    surfaceId: "main",
    capabilities: ["ui.toast"],
    theme: { mode: "dark" },
    locale: "en",
  });
  assert.equal("session" in ready, false);
  assert.equal("project" in ready, false);
  assert.equal("spaceId" in ready, false);
  assert.equal("grantRevision" in ready, false);
  assert.equal("composerAction" in ready, false);
  assert.equal(ready.protocolVersion, PROTOCOL_VERSION);
});

test("dispose rejects in-flight requests without a public cancel protocol", async () => {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  const posted: Array<{ kind?: string; id?: string; method?: string }> = [];
  port1.addEventListener("message", (event) => {
    const data = event.data as { kind?: string; id?: string; method?: string };
    posted.push(data);
    if (data.kind === "request" && data.method === "runtime.hello" && data.id) {
      port1.postMessage(responseOk(data.id, sandboxHandshakeReady({
        packageId: "com-example-hello",
        packageVersion: "1.0.0",
        runtimeInstanceId: "rt-1",
        surfaceId: "main",
        capabilities: ["ui.toast"],
        theme: { mode: "dark" },
        locale: "en",
      })));
    }
  });
  const host = await connectPolyth({ port: port2, requestTimeoutMs: 500 });
  const hanging = host.ui.toast({ message: "hang" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  host.dispose();
  await assert.rejects(() => hanging, /disposed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(posted.some((item) => item.kind === "cancel"), false);
});

test("live composer.action events reach onComposerAction", async () => {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  port1.addEventListener("message", (event) => {
    const data = event.data as { kind?: string; id?: string; method?: string };
    if (data.kind === "request" && data.method === "runtime.hello" && data.id) {
      port1.postMessage(responseOk(data.id, sandboxHandshakeReady({
        packageId: "com-example-hello",
        packageVersion: "1.0.0",
        runtimeInstanceId: "rt-1",
        surfaceId: "main",
        capabilities: ["ui.toast"],
        theme: { mode: "dark" },
        locale: "en",
      })));
    }
  });
  const host = await connectPolyth({ port: port2 });
  const seen: string[] = [];
  const off = host.ui.onComposerAction((actionId) => seen.push(actionId));
  port1.postMessage(eventEnvelope("composer.action", { actionId: "attach-item" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["attach-item"]);
  off();
  host.dispose();
});
