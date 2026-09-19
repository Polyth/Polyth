import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { connectChatWorkspaceDeviceRuntime } from "../src/deviceRuntimeClient.ts";
import { CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION, type ChatWorkspaceDeviceEvent } from "../src/deviceRuntimeProtocol.ts";

test("desktop runtime client performs hello, command ack and explicit event flow", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  let helloSeen = false;
  const eventSeen: { event?: ChatWorkspaceDeviceEvent } = {};
  const ack = new Promise<Record<string, unknown>>((resolve) => {
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message.type === "hello") {
          helloSeen = true;
          socket.send(JSON.stringify({ type: "ready", protocolVersion: CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION }));
          socket.send(JSON.stringify({
            type: "command",
            command: {
              kind: "tab.activate",
              requestId: "request-1",
              projectId: "project-1",
              tabId: "tab-1",
            },
          }));
          return;
        }
        if (message.type === "ack") resolve(message.ack as Record<string, unknown>);
        if (message.type === "event") eventSeen.event = message.event as ChatWorkspaceDeviceEvent;
      });
    });
  });

  const runtime = {
    async execute(command: { requestId: string }) {
      return { requestId: command.requestId, ok: true };
    },
    async close() {},
  } as Parameters<typeof connectChatWorkspaceDeviceRuntime>[0]["runtime"];

  const client = connectChatWorkspaceDeviceRuntime({
    wsUrl: `ws://127.0.0.1:${address.port}`,
    hello: {
      protocolVersion: CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION,
      deviceId: "client-local-label",
      deviceName: "Desktop",
      platform: "darwin",
      arch: "arm64",
      capabilities: {
        localChromium: true,
        localRendering: true,
        persistentProfiles: true,
        explicitResponseHandoff: true,
      },
    },
    runtime,
    heartbeatMs: 60_000,
  });

  await client.ready;
  const receivedAck = await ack;
  assert.equal(helloSeen, true);
  assert.equal(receivedAck.requestId, "request-1");
  assert.equal(receivedAck.ok, true);

  client.sendEvent({
    kind: "tab.closed",
    projectId: "project-1",
    tabId: "tab-1",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(eventSeen.event?.kind, "tab.closed");

  await client.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
