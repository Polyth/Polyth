import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "../src/rpc.ts";
import { createCommandCodeRuntime } from "../src/runtime.ts";

const harness = async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-termination-"));
  const receipts: Record<string, string> = {};
  const listeners = new Set<(event: CommandCodeWorkerEvent) => void>();
  const closeListeners = new Set<() => void>();
  let activeOperation = "";
  const emit = (event: CommandCodeWorkerEvent) => {
    for (const listener of listeners) listener(event);
  };
  const rpc: CommandCodeRpc = {
    authorityId: "termination-authority",
    generation: 1,
    receipts,
    releasedAuthorities: [],
    async request<T>(command) {
      if (command.type === "start_turn") {
        activeOperation = String(command.operationId);
        emit({ type: "turn-spawned", operationId: activeOperation });
        const bindingPath = String(command.bindingPath);
        const state = JSON.parse(await readFile(bindingPath, "utf8"));
        await writeFile(bindingPath, JSON.stringify({
          ...state,
          nativeSessionId: "cc-native",
          nativeBoundAt: Date.now(),
          acceptedOperations: [activeOperation],
          acceptedMutations: [{ operationId: activeOperation, mutationKind: "turn-submit" }],
          updatedAt: Date.now(),
        }));
        return { nativeSessionId: "cc-native" } as T;
      }
      if (command.type === "abort") {
        if (activeOperation) emit({
          type: "turn-exit",
          operationId: activeOperation,
          code: null,
          signal: "SIGTERM",
          stderr: "",
        });
        activeOperation = "";
        return {} as T;
      }
      if (command.type === "shutdown") return {} as T;
      throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    },
    async receipt(operationId, nativeId) { receipts[operationId] = nativeId; },
    onEvent(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    onClose(callback) { closeListeners.add(callback); return { dispose: () => closeListeners.delete(callback) }; },
    async close() { for (const callback of closeListeners) callback(); },
  };
  const bindingFile = join(dir, "binding.json");
  const runtime = createCommandCodeRuntime({
    context: { spaceId: "space", projectId: "project", sessionId: "canonical", cwd: dir },
    rpc,
    bindingFile,
    bridgePath: join(dir, "bridge.ts"),
    models: async () => [],
  });
  const created = await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Termination test", cwd: dir },
    "create",
  );
  assert.equal(created.kind, "confirmed");
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_sessionId, event) => events.push(event));
  return { dir, runtime, events, emit };
};

test("worker SIGTERM without an abort request is a terminal error", async () => {
  const fixture = await harness();
  try {
    const started = await fixture.runtime.startTurnOperation!(
      { sessionId: "canonical", text: "hello" },
      "turn-internal-kill",
    );
    assert.equal(started.kind, "confirmed");
    fixture.emit({
      type: "turn-exit",
      operationId: "turn-internal-kill",
      code: null,
      signal: "SIGTERM",
      stderr: "internal cleanup",
    });
    const stopped = fixture.events.find((event) => event.type === "turn/stopped");
    assert.deepEqual(stopped, {
      type: "turn/stopped",
      turnId: "turn-internal-kill",
      reason: "error",
      error: "Command Code exited with code unknown: internal cleanup",
      code: "unknown",
    });
  } finally {
    await fixture.runtime.dispose();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("explicit Polyth abort remains aborted when the owned child exits by SIGTERM", async () => {
  const fixture = await harness();
  try {
    const started = await fixture.runtime.startTurnOperation!(
      { sessionId: "canonical", text: "hello" },
      "turn-user-abort",
    );
    assert.equal(started.kind, "confirmed");
    await fixture.runtime.abort("canonical");
    const stopped = fixture.events.find((event) => event.type === "turn/stopped");
    assert.deepEqual(stopped, {
      type: "turn/stopped",
      turnId: "turn-user-abort",
      reason: "aborted",
    });
  } finally {
    await fixture.runtime.dispose();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
