import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "../src/rpc.ts";
import { createCommandCodeRuntime } from "../src/runtime.ts";

const fakeRpc = () => {
  const receipts: Record<string, string> = {};
  const events = new Set<(event: CommandCodeWorkerEvent) => void>();
  const closes = new Set<() => void>();
  let bindingPath = "";
  const rpc: CommandCodeRpc = {
    authorityId: "cc-authority",
    generation: 4,
    receipts,
    releasedAuthorities: [],
    async request<T>(command) {
      if (command.type === "start_turn") {
        bindingPath = String(command.bindingPath);
        const state = JSON.parse(await readFile(bindingPath, "utf8"));
        await writeFile(bindingPath, JSON.stringify({ ...state, nativeSessionId: "cc-native", nativeBoundAt: Date.now() }));
        return { nativeSessionId: "cc-native" } as T;
      }
      if (command.type === "abort" || command.type === "shutdown") return {} as T;
      throw Object.assign(new Error("unsupported"), { code: "runtime-rejected" });
    },
    async receipt(operationId, id) { receipts[operationId] = id; },
    onEvent(callback) { events.add(callback); return { dispose: () => events.delete(callback) }; },
    onClose(callback) { closes.add(callback); return { dispose: () => closes.delete(callback) }; },
    async close() { for (const callback of closes) callback(); },
  };
  return {
    rpc,
    emit(event: CommandCodeWorkerEvent) { for (const callback of events) callback(event); },
    bindingPath: () => bindingPath,
  };
};

test("Command Code creates a durable adapter binding before the provider session exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-"));
  const bindingFile = join(dir, "binding.json");
  const fake = fakeRpc();
  const runtime = createCommandCodeRuntime({
    context: { spaceId: "space", projectId: "project", sessionId: "canonical", cwd: dir },
    rpc: fake.rpc,
    bindingFile,
    bridgePath: join(dir, "bridge.ts"),
    models: async () => [],
  });
  try {
    const created = await runtime.createSessionOperation!({ projectId: "project", sessionId: "canonical", title: "Useful title", cwd: dir }, "create-op");
    assert.equal(created.kind, "confirmed");
    if (created.kind !== "confirmed") return;
    assert.equal(created.receipt, created.value.backendSessionId);
    assert.equal(fake.rpc.receipts["create-op"], created.value.backendSessionId);
    const state = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.equal(state.nativeSessionId, undefined);
    assert.equal(state.title, "Useful title");

    const events: RuntimeEvent[] = [];
    runtime.onEvent((_sessionId, event) => events.push(event));
    const admitted = await runtime.startTurnOperation!({
      sessionId: "canonical",
      text: "hello",
      model: { providerID: "moonshotai", modelID: "moonshotai/Kimi-K3", variant: "high" },
    }, "turn-op");
    assert.equal(admitted.kind, "confirmed");
    const bound = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.equal(bound.nativeSessionId, "cc-native");

    fake.emit({ type: "commandcode-record", operationId: "turn-op", record: { type: "event", event: { type: "turn_start" } } });
    fake.emit({ type: "commandcode-record", operationId: "turn-op", record: { type: "event", event: { type: "text_delta", delta: "Hi" } } });
    fake.emit({ type: "commandcode-record", operationId: "turn-op", record: { type: "event", event: { type: "message_end", message: { content: [{ type: "text", text: "Hi" }] } } } });
    fake.emit({ type: "commandcode-record", operationId: "turn-op", record: { type: "result", subtype: "success", finalText: "Hi" } });
    fake.emit({ type: "turn-exit", operationId: "turn-op", code: 0, signal: null, stderr: "" });
    assert.ok(events.some((event) => event.type === "turn/started"));
    assert.ok(events.some((event) => event.type === "assistant/chunk" && event.text === "Hi"));
    assert.ok(events.some((event) => event.type === "assistant/message" && event.text === "Hi"));
    assert.ok(events.some((event) => event.type === "turn/stopped" && event.reason === "completed"));
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
