import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import { COMMANDCODE_BRIDGE_SOURCE } from "../src/bridgeSource.ts";
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "../src/rpc.ts";
import { createCommandCodeRuntime } from "../src/runtime.ts";
import { COMMANDCODE_WORKER_SOURCE } from "../src/workerSource.ts";

const context = (cwd: string) => ({
  spaceId: "space",
  projectId: "project",
  sessionId: "canonical",
  cwd,
});

const fakeRpc = (options: {
  compactAckLost?: boolean;
  emitNativeCompaction?: boolean;
} = {}) => {
  const receipts: Record<string, string> = {};
  const events = new Set<(event: CommandCodeWorkerEvent) => void>();
  const closes = new Set<() => void>();
  const emit = (event: CommandCodeWorkerEvent) => {
    for (const callback of events) callback(event);
  };

  const rpc: CommandCodeRpc = {
    authorityId: "cc-authority",
    generation: 7,
    receipts,
    releasedAuthorities: [],
    async request<T>(command) {
      if (command.type === "start_turn") {
        const operationId = String(command.operationId);
        const bindingPath = String(command.bindingPath);
        const state = JSON.parse(await readFile(bindingPath, "utf8")) as Record<string, unknown>;
        const accepted = Array.isArray(state.acceptedMutations) ? [...state.acceptedMutations] : [];
        const compact = command.controlAction === "compact";
        accepted.push({
          operationId,
          mutationKind: compact ? "session-compact" : "turn-submit",
        });
        await writeFile(bindingPath, JSON.stringify({
          ...state,
          nativeSessionId: "cc-native",
          nativeBoundAt: Date.now(),
          acceptedMutations: accepted,
          updatedAt: Date.now(),
        }));

        emit({
          type: "turn-spawned",
          operationId,
          ...(compact ? { controlAction: "compact" } : {}),
        });
        if (compact && options.emitNativeCompaction) {
          emit({
            type: "commandcode-record",
            operationId,
            record: { type: "event", event: { type: "compaction_start" } },
          });
          emit({
            type: "commandcode-record",
            operationId,
            record: { type: "event", event: { type: "compaction_done", tokensSaved: 4096 } },
          });
        }
        if (compact && options.compactAckLost) {
          throw Object.assign(new Error("worker acknowledgement was lost"), { code: "outcome-unknown" });
        }
        return { nativeSessionId: "cc-native" } as T;
      }
      if (command.type === "abort" || command.type === "shutdown") return {} as T;
      throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    },
    async receipt(operationId, id) { receipts[operationId] = id; },
    onEvent(callback) { events.add(callback); return { dispose: () => events.delete(callback) }; },
    onClose(callback) { closes.add(callback); return { dispose: () => closes.delete(callback) }; },
    async close() { for (const callback of closes) callback(); },
  };

  return { rpc, emit };
};

async function preparedRuntime(dir: string, fake: ReturnType<typeof fakeRpc>) {
  const bindingFile = join(dir, "binding.json");
  const runtime = createCommandCodeRuntime({
    context: context(dir),
    rpc: fake.rpc,
    bindingFile,
    bridgePath: join(dir, "bridge.ts"),
    models: async () => [],
  });
  const created = await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Compact me", cwd: dir },
    "create-op",
  );
  assert.equal(created.kind, "confirmed");
  const admitted = await runtime.startTurnOperation!(
    { sessionId: "canonical", text: "establish the native session" },
    "turn-bind",
  );
  assert.equal(admitted.kind, "confirmed");
  fake.emit({ type: "turn-exit", operationId: "turn-bind", code: 0, signal: null, stderr: "" });
  return { runtime, bindingFile, created };
}

test("Command Code manual compaction is a durable native session mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-compact-"));
  const fake = fakeRpc({ emitNativeCompaction: true });
  const { runtime, bindingFile, created } = await preparedRuntime(dir, fake);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_sessionId, event) => events.push(event));
  try {
    const outcome = await runtime.compactOperation!("canonical", "compact-op");
    assert.equal(outcome.kind, "confirmed");

    const state = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.ok(state.acceptedMutations.some((entry: Record<string, unknown>) =>
      entry.operationId === "compact-op" && entry.mutationKind === "session-compact"));
    assert.equal(events.filter((event) => event.type === "session/compacted").length, 1);
    assert.ok(events.some((event) => event.type === "context/updated" && event.compaction?.active === true));
    assert.ok(events.some((event) => event.type === "context/updated" && event.compaction?.active === false));

    const endpoint = await runtime.endpoint!();
    const snapshot = await runtime.reconcile!({
      canonicalSessionId: "canonical",
      backendSessionId: created.kind === "confirmed" ? created.value.backendSessionId : "",
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      location: endpoint.location,
      reconciliationOrdinal: 1,
    });
    assert.ok(snapshot.acceptedOperations?.some((entry) =>
      entry.operationId === "compact-op" && entry.mutationKind === "session-compact"));
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lost compact acknowledgement recovers from the exact durable receipt without replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-compact-unknown-"));
  const fake = fakeRpc({ compactAckLost: true });
  const { runtime } = await preparedRuntime(dir, fake);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_sessionId, event) => events.push(event));
  try {
    const outcome = await runtime.compactOperation!("canonical", "compact-lost-ack");
    assert.equal(outcome.kind, "confirmed");
    assert.equal(events.filter((event) => event.type === "session/compacted").length, 1);
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("manual compact stays unavailable until an exact native session exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-compact-unbound-"));
  const fake = fakeRpc();
  const bindingFile = join(dir, "binding.json");
  const runtime = createCommandCodeRuntime({
    context: context(dir),
    rpc: fake.rpc,
    bindingFile,
    bridgePath: join(dir, "bridge.ts"),
    models: async () => [],
  });
  try {
    const created = await runtime.createSessionOperation!(
      { projectId: "project", sessionId: "canonical", title: "No native leg yet", cwd: dir },
      "create-op",
    );
    assert.equal(created.kind, "confirmed");
    const outcome = await runtime.compactOperation!("canonical", "compact-too-early");
    assert.equal(outcome.kind, "rejected");
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated Command Code control path is fail-closed before model inference", () => {
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /cmd\.sessions\.compact\(\)/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /mutationKind === "session-compact"|"session-compact"/);
  assert.match(COMMANDCODE_BRIDGE_SOURCE, /session-control input unexpectedly reached the model loop/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /POLYTH_COMMANDCODE_CONTROL_ACTION/);
  assert.match(COMMANDCODE_WORKER_SOURCE, /controlAction: "compact"|controlAction === "compact"/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /--yolo/);
  assert.doesNotMatch(COMMANDCODE_WORKER_SOURCE, /--trust/);
});
