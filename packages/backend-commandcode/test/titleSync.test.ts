import assert from "node:assert/strict";
import test from "node:test";
import type { CommandCodeRpc } from "../src/rpc.ts";
import { createCommandCodeTitleSync } from "../src/titleSync.ts";
import { COMMANDCODE_WORKER_SOURCE } from "../src/workerSource.ts";

test("canonical title wrapper injects the latest Polyth title into exact native resume", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const base: CommandCodeRpc = {
    authorityId: "authority",
    generation: 3,
    receipts: {},
    releasedAuthorities: [],
    async request<T>(command) {
      requests.push(command);
      return {} as T;
    },
    async receipt() {},
    onEvent() { return { dispose() {} }; },
    onClose() { return { dispose() {} }; },
    async close() {},
  };
  const sync = createCommandCodeTitleSync(base);

  sync.capture("Initial title");
  await sync.rpc.request({
    type: "start_turn",
    operationId: "turn-1",
    nativeSessionId: "native-session",
    title: "stale binding title",
  });
  assert.equal(requests[0]?.title, "Initial title");
  assert.equal(requests[0]?.nativeSessionId, "native-session");

  sync.capture("  Manually renamed in Polyth  ");
  await sync.rpc.request({
    type: "start_turn",
    operationId: "turn-2",
    nativeSessionId: "native-session",
    title: "old native title",
  });
  assert.equal(requests[1]?.title, "Manually renamed in Polyth");
  assert.equal(sync.current(), "Manually renamed in Polyth");
});

test("non-start RPC messages are never decorated with session titles", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const base: CommandCodeRpc = {
    authorityId: "authority",
    generation: 1,
    receipts: {},
    releasedAuthorities: [],
    async request<T>(command) { requests.push(command); return {} as T; },
    async receipt() {},
    onEvent() { return { dispose() {} }; },
    onClose() { return { dispose() {} }; },
    async close() {},
  };
  const sync = createCommandCodeTitleSync(base);
  sync.capture("Secret-free canonical title");
  await sync.rpc.request({ type: "steer", operationId: "steer-1", text: "focus" });
  assert.equal("title" in requests[0]!, false);
});

test("generated worker passes canonical title to the transient Mod on resume too", () => {
  assert.match(COMMANDCODE_WORKER_SOURCE, /POLYTH_COMMANDCODE_TITLE:\s*message\.title\s*\|\|\s*""/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /message\.nativeSessionId\s*\?\s*""\s*:\s*\(message\.title/);
});
