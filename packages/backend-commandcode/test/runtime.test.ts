import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "../src/rpc.ts";
import { createCommandCodeRuntime } from "../src/runtime.ts";

const fakeRpc = (options: {
  unknownAdmission?: boolean;
  rejectFirstAdmissionWithoutReceipt?: boolean;
  rejectAdmissionAfterReceipt?: boolean;
  unknownSteerAfterReceipt?: boolean;
  rejectSteer?: boolean;
} = {}) => {
  const receipts: Record<string, string> = {};
  const events = new Set<(event: CommandCodeWorkerEvent) => void>();
  const closes = new Set<() => void>();
  let bindingPath = "";
  let startCalls = 0;
  const steerCalls: Array<{ operationId: string; text: string }> = [];
  const emit = (event: CommandCodeWorkerEvent) => { for (const callback of events) callback(event); };
  const rpc: CommandCodeRpc = {
    authorityId: "cc-authority",
    generation: 4,
    receipts,
    releasedAuthorities: [],
    async request<T>(command) {
      if (command.type === "start_turn") {
        startCalls += 1;
        bindingPath = String(command.bindingPath);
        const operationId = String(command.operationId);
        emit({ type: "turn-spawned", operationId });
        if (options.rejectFirstAdmissionWithoutReceipt && startCalls === 1) {
          throw Object.assign(new Error("workspace trust is required before admission"), { code: "runtime-rejected" });
        }
        const state = JSON.parse(await readFile(bindingPath, "utf8"));
        await writeFile(bindingPath, JSON.stringify({
          ...state,
          nativeSessionId: "cc-native",
          nativeBoundAt: Date.now(),
          acceptedOperations: [...new Set([...(state.acceptedOperations ?? []), operationId])],
          acceptedMutations: [
            ...(state.acceptedMutations ?? []),
            { operationId, mutationKind: "turn-submit" },
          ],
          updatedAt: Date.now(),
        }));
        if (options.rejectAdmissionAfterReceipt) {
          throw Object.assign(new Error("late rejection response"), { code: "runtime-rejected" });
        }
        if (options.unknownAdmission) {
          throw Object.assign(new Error("worker response was lost"), { code: "outcome-unknown" });
        }
        return { nativeSessionId: "cc-native" } as T;
      }
      if (command.type === "steer") {
        const operationId = String(command.operationId);
        const text = String(command.text);
        steerCalls.push({ operationId, text });
        if (options.rejectSteer) {
          throw Object.assign(new Error("native run already stopped"), { code: "runtime-rejected" });
        }
        const state = JSON.parse(await readFile(bindingPath, "utf8"));
        await writeFile(bindingPath, JSON.stringify({
          ...state,
          acceptedMutations: [
            ...(state.acceptedMutations ?? []),
            { operationId, mutationKind: "turn-steer" },
          ],
          updatedAt: Date.now(),
        }));
        if (options.unknownSteerAfterReceipt) {
          throw Object.assign(new Error("steering acknowledgement was lost"), { code: "outcome-unknown" });
        }
        return {} as T;
      }
      if (command.type === "abort" || command.type === "shutdown") return {} as T;
      throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    },
    async receipt(operationId, id) { receipts[operationId] = id; },
    onEvent(callback) { events.add(callback); return { dispose: () => events.delete(callback) }; },
    onClose(callback) { closes.add(callback); return { dispose: () => closes.delete(callback) }; },
    async close() { for (const callback of closes) callback(); },
  };
  return { rpc, emit, bindingPath: () => bindingPath, steerCalls };
};

const context = (cwd: string) => ({ spaceId: "space", projectId: "project", sessionId: "canonical", cwd });

async function createRuntime(dir: string, fake: ReturnType<typeof fakeRpc>) {
  const bindingFile = join(dir, "binding.json");
  const runtime = createCommandCodeRuntime({
    context: context(dir),
    rpc: fake.rpc,
    bindingFile,
    bridgePath: join(dir, "bridge.ts"),
    models: async () => [],
  });
  const created = await runtime.createSessionOperation!({ projectId: "project", sessionId: "canonical", title: "Useful title", cwd: dir }, "create-op");
  assert.equal(created.kind, "confirmed");
  if (created.kind !== "confirmed") throw new Error("session creation failed");
  return { runtime, bindingFile, created };
}

test("Command Code creates a durable adapter binding before the provider session exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-"));
  const fake = fakeRpc();
  const { runtime, bindingFile, created } = await createRuntime(dir, fake);
  try {
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
    assert.deepEqual(bound.acceptedOperations, ["turn-op"]);
    assert.ok(bound.acceptedMutations.some((entry: { operationId: string; mutationKind: string }) =>
      entry.operationId === "turn-op" && entry.mutationKind === "turn-submit"));

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

test("spawn without the exact turn receipt can be proven rejected and does not leave the runtime fenced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-pre-admission-reject-"));
  const fake = fakeRpc({ rejectFirstAdmissionWithoutReceipt: true });
  const { runtime, bindingFile } = await createRuntime(dir, fake);
  try {
    const rejected = await runtime.startTurnOperation!(
      { sessionId: "canonical", text: "first" },
      "turn-not-admitted",
    );
    assert.deepEqual(rejected, {
      kind: "rejected",
      code: "runtime-rejected",
      message: "workspace trust is required before admission",
    });
    const beforeRetry = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.equal(beforeRetry.nativeSessionId, undefined);
    assert.deepEqual(beforeRetry.acceptedMutations, []);

    const retried = await runtime.startTurnOperation!(
      { sessionId: "canonical", text: "second" },
      "turn-admitted-after-rejection",
    );
    assert.equal(retried.kind, "confirmed");
    const afterRetry = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.ok(afterRetry.acceptedMutations.some((entry: { operationId: string; mutationKind: string }) =>
      entry.operationId === "turn-admitted-after-rejection" && entry.mutationKind === "turn-submit"));
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a durable exact turn receipt outranks a late runtime-rejected RPC response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-receipt-precedence-"));
  const fake = fakeRpc({ rejectAdmissionAfterReceipt: true });
  const { runtime, bindingFile } = await createRuntime(dir, fake);
  try {
    const outcome = await runtime.startTurnOperation!(
      { sessionId: "canonical", text: "may already be running" },
      "turn-receipt-precedence",
    );
    assert.equal(outcome.kind, "unknown");
    const state = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.ok(state.acceptedMutations.some((entry: { operationId: string; mutationKind: string }) =>
      entry.operationId === "turn-receipt-precedence" && entry.mutationKind === "turn-submit"));
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Command Code native steering is operation-aware and durably reconciled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-steer-"));
  const fake = fakeRpc();
  const { runtime, bindingFile, created } = await createRuntime(dir, fake);
  try {
    const capabilities = await runtime.capabilities();
    assert.equal(capabilities.steering, true);
    const admitted = await runtime.startTurnOperation!({ sessionId: "canonical", text: "start" }, "turn-steer-base");
    assert.equal(admitted.kind, "confirmed");

    const steered = await runtime.steerOperation!("canonical", "focus on tests", "steer-op");
    assert.deepEqual(steered, { kind: "confirmed", value: {} });
    assert.deepEqual(fake.steerCalls, [{ operationId: "steer-op", text: "focus on tests" }]);
    const state = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.ok(state.acceptedMutations.some((entry: { operationId: string; mutationKind: string }) =>
      entry.operationId === "steer-op" && entry.mutationKind === "turn-steer"));

    const endpoint = await runtime.endpoint!();
    const snapshot = await runtime.reconcile!({
      canonicalSessionId: "canonical",
      backendSessionId: created.value.backendSessionId,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      location: endpoint.location,
      reconciliationOrdinal: 1,
    });
    assert.ok(snapshot.acceptedOperations.some((entry) =>
      entry.operationId === "steer-op" && entry.mutationKind === "turn-steer"));

    fake.emit({ type: "turn-exit", operationId: "turn-steer-base", code: 0, signal: null, stderr: "" });
    const afterStop = await runtime.steerOperation!("canonical", "too late", "steer-late");
    assert.equal(afterStop.kind, "rejected");
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lost native steering acknowledgement recovers confirmed from the durable bridge receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-steer-receipt-"));
  const fake = fakeRpc({ unknownSteerAfterReceipt: true });
  const { runtime } = await createRuntime(dir, fake);
  try {
    const admitted = await runtime.startTurnOperation!({ sessionId: "canonical", text: "start" }, "turn-receipt-base");
    assert.equal(admitted.kind, "confirmed");
    const steered = await runtime.steerOperation!("canonical", "keep going", "steer-receipt");
    assert.deepEqual(steered, { kind: "confirmed", value: {} });
    assert.deepEqual(fake.steerCalls, [{ operationId: "steer-receipt", text: "keep going" }]);
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lost admission response stays fenced and reconciles from the durable native receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-unknown-"));
  const fake = fakeRpc({ unknownAdmission: true });
  const { runtime, bindingFile, created } = await createRuntime(dir, fake);
  try {
    const outcome = await runtime.startTurnOperation!({ sessionId: "canonical", text: "mutate files" }, "turn-unknown");
    assert.equal(outcome.kind, "unknown");
    const state = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.equal(state.nativeSessionId, "cc-native");
    assert.deepEqual(state.acceptedOperations, ["turn-unknown"]);

    const endpoint = await runtime.endpoint!();
    const running = await runtime.reconcile!({
      canonicalSessionId: "canonical",
      backendSessionId: created.value.backendSessionId,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      location: endpoint.location,
      reconciliationOrdinal: 1,
    });
    assert.equal(running.state.value, "running");
    assert.ok(running.acceptedOperations.some((entry) => entry.operationId === "turn-unknown"));

    fake.emit({ type: "turn-exit", operationId: "turn-unknown", code: 0, signal: null, stderr: "" });
    const idle = await runtime.reconcile!({
      canonicalSessionId: "canonical",
      backendSessionId: created.value.backendSessionId,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      location: endpoint.location,
      reconciliationOrdinal: 2,
    });
    assert.equal(idle.state.value, "idle");
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker protocol failure is terminal error, not a user abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-protocol-"));
  const fake = fakeRpc();
  const { runtime } = await createRuntime(dir, fake);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_sessionId, event) => events.push(event));
  try {
    const outcome = await runtime.startTurnOperation!({ sessionId: "canonical", text: "hello" }, "turn-protocol");
    assert.equal(outcome.kind, "confirmed");
    fake.emit({ type: "protocol-error", operationId: "turn-protocol", error: "malformed native frame" });
    fake.emit({ type: "turn-exit", operationId: "turn-protocol", code: null, signal: "SIGTERM", stderr: "" });
    assert.ok(events.some((event) => event.type === "turn/stopped" && event.reason === "error" && event.error === "malformed native frame"));
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
