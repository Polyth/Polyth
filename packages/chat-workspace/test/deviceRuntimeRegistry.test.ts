import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION,
  type ChatWorkspaceDeviceCommand,
  type ChatWorkspaceDeviceHello,
} from "../src/deviceRuntimeProtocol.ts";
import { createChatWorkspaceDeviceRuntimeRegistry } from "../src/deviceRuntimeRegistry.ts";

const hello = (deviceId = "desktop-1"): ChatWorkspaceDeviceHello => ({
  protocolVersion: CHAT_WORKSPACE_DEVICE_PROTOCOL_VERSION,
  deviceId,
  deviceName: "Desktop",
  platform: "darwin",
  arch: "arm64",
  capabilities: {
    localChromium: true,
    localRendering: true,
    persistentProfiles: true,
    explicitResponseHandoff: true,
  },
});

test("advertises fresh capable desktop runtimes", () => {
  let clock = 1_000;
  const registry = createChatWorkspaceDeviceRuntimeRegistry({ now: () => clock, staleAfterMs: 5_000 });
  registry.register(hello(), {
    async send(command) { return { requestId: command.requestId, ok: true }; },
  });
  assert.equal(registry.capabilities()[0]?.available, true);
  clock += 5_001;
  assert.equal(registry.capabilities()[0]?.available, false);
  registry.heartbeat("desktop-1");
  assert.equal(registry.capabilities()[0]?.available, true);
});

test("dispatch correlates acknowledgements and rejects mismatches", async () => {
  const registry = createChatWorkspaceDeviceRuntimeRegistry();
  const seen: { command?: ChatWorkspaceDeviceCommand } = {};
  registry.register(hello(), {
    async send(command) {
      seen.command = command;
      return { requestId: command.requestId, ok: true };
    },
  });
  const ack = await registry.dispatch("desktop-1", {
    kind: "tab.activate",
    projectId: "project-1",
    tabId: "tab-1",
  });
  assert.equal(ack.ok, true);
  assert.equal(seen.command?.kind, "tab.activate");

  await registry.disconnect("desktop-1");
  registry.register(hello(), {
    async send() { return { requestId: "wrong", ok: true }; },
  });
  await assert.rejects(
    registry.dispatch("desktop-1", {
      kind: "tab.activate",
      projectId: "project-1",
      tabId: "tab-1",
    }),
    /requestId mismatch/,
  );
});

test("replacement dispose cannot remove the new device generation", async () => {
  const registry = createChatWorkspaceDeviceRuntimeRegistry();
  let firstClosed = 0;
  const first = registry.register(hello(), {
    async send(command) { return { requestId: command.requestId, ok: true }; },
    close() { firstClosed += 1; },
  });
  registry.register(hello(), {
    async send(command) { return { requestId: command.requestId, ok: true }; },
  });
  assert.equal(firstClosed, 1);
  await first.dispose();
  assert.equal(registry.capabilities().length, 1);
});

test("an acknowledgement from a replaced worker generation is rejected", async () => {
  const registry = createChatWorkspaceDeviceRuntimeRegistry();
  let resolveOld!: (value: { requestId: string; ok: boolean }) => void;
  registry.register(hello(), {
    send() {
      return new Promise((resolve) => { resolveOld = resolve; });
    },
  });
  const pending = registry.dispatch("desktop-1", {
    kind: "tab.activate",
    projectId: "project-1",
    tabId: "tab-1",
  }, 5_000);
  await Promise.resolve();
  registry.register(hello(), {
    async send(command) { return { requestId: command.requestId, ok: true }; },
  });
  resolveOld({ requestId: "ignored-by-generation-fence", ok: true });
  await assert.rejects(pending, /was replaced|requestId mismatch/);
});

test("closeAll releases every registered desktop runtime", async () => {
  const registry = createChatWorkspaceDeviceRuntimeRegistry();
  let closed = 0;
  for (const id of ["desktop-1", "desktop-2"]) {
    registry.register(hello(id), {
      async send(command) { return { requestId: command.requestId, ok: true }; },
      close() { closed += 1; },
    });
  }
  await registry.closeAll();
  assert.equal(closed, 2);
  assert.equal(registry.capabilities().length, 0);
});

test("forbids browser-state material in device events", () => {
  const registry = createChatWorkspaceDeviceRuntimeRegistry();
  registry.register(hello(), {
    async send(command) { return { requestId: command.requestId, ok: true }; },
  });
  assert.throws(() => registry.event("desktop-1", {
    kind: "runtime.error",
    code: "x",
    message: "bad",
    cookies: "secret",
  } as never), /forbidden Chat Workspace device payload field/);
});
