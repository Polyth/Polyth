import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRuntime, RuntimeEvent } from "@polyth/contracts";
import { createStore } from "@polyth/session";
import { oneShot } from "../src/oneshot.ts";

test("one-shot response loss retains one durable operation and never executes twice", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-oneshot-loss-")), "sessions.db"));
  let creates = 0;
  let compatibilityEnsures = 0;
  let submissions = 0;
  const runtime = {
    createSessionOperation: async () => {
      creates += 1;
      return {
        kind: "confirmed" as const,
        value: { backendSessionId: "backend-task" },
      };
    },
    ensureSession: async () => {
      compatibilityEnsures += 1;
      return "backend-task";
    },
    startTurnOperation: async (_input: unknown, operationId: string) => {
      submissions += 1;
      return {
        kind: "unknown" as const,
        operationId,
        message: "accepted response was lost",
      };
    },
    onEvent: () => ({ dispose() {} }),
  } as unknown as AgentRuntime;
  const options = {
    cwd: "/repos/demo",
    prompt: "run once",
    taskId: "stable-task",
  };

  await assert.rejects(() => oneShot(runtime, options, store), /accepted response was lost/);
  await assert.rejects(() => oneShot(runtime, options, store), /accepted response was lost/);

  assert.equal(creates, 1);
  assert.equal(compatibilityEnsures, 0, "confirmed create is not followed by an untracked ensure");
  assert.equal(submissions, 1);
  const operations = await store.operations("oneshot-stable-task");
  assert.deepEqual(
    operations.map((operation) => [operation.mutationKind, operation.state]),
    [["session-create", "confirmed"], ["turn-submit", "unknown"]],
  );
  await store.close();
});

// A runtime whose stream delivers the finished answer but never the idle
// notification, like OpenCode's V2 adapter; the session service compensates
// with a quiet-turn reconcile and one-shot must do the same.
function quietRuntime(states: Array<"running" | "idle" | "failed" | "interrupted">, emitStop = false) {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const ordinals: number[] = [];
  const turns: Array<{ sessionId: string; utility?: { purpose?: string } }> = [];
  const runtime = {
    createSessionOperation: async () => ({
      kind: "confirmed" as const,
      value: { backendSessionId: "backend-task" },
      receipt: "backend-task",
    }),
    endpoint: async () => ({
      authorityId: "authority", generation: 1, continuity: "owned", location: { directory: "/repos/demo" },
    }),
    reconcile: async (binding: { reconciliationOrdinal: number }) => {
      ordinals.push(binding.reconciliationOrdinal);
      // The first call opens the barrier; later calls carry terminal evidence.
      const value = ordinals.length === 1 ? "idle" : states[Math.min(ordinals.length - 2, states.length - 1)]!;
      return { state: { value } };
    },
    startTurnOperation: async (input: { sessionId: string; utility?: { purpose?: string } }, operationId: string) => {
      turns.push(input);
      const emit = (event: unknown) => { for (const listener of listeners) listener(input.sessionId, event as RuntimeEvent); };
      queueMicrotask(() => {
        emit({ type: "turn/started", turnId: "turn" });
        emit({ type: "assistant/message", partId: "reasoning", text: "", reasoning: "thinking" });
        emit({ type: "assistant/message", partId: "answer", text: "Fix login redirect" });
        if (emitStop) emit({ type: "turn/stopped", turnId: "turn", reason: "completed" });
      });
      return { kind: "confirmed" as const, operationId };
    },
    onEvent: (listener: (sessionId: string, event: RuntimeEvent) => void) => {
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    },
  } as unknown as AgentRuntime;
  return { runtime, ordinals, turns };
}

const quietStore = () => createStore(join(mkdtempSync(join(tmpdir(), "polyth-oneshot-quiet-")), "sessions.db"));

test("an answered turn that never reports idle settles once reconciliation proves it", async (t) => {
  const store = quietStore();
  t.after(() => store.close());
  const { runtime, ordinals, turns } = quietRuntime(["running", "idle"]);
  const started = Date.now();
  const text = await oneShot(runtime, { cwd: "/repos/demo", prompt: "title", taskId: "quiet", timeoutMs: 20_000 }, store);
  assert.equal(text, "Fix login redirect");
  assert.deepEqual(turns[0]?.utility, {}, "adapters must not decorate a utility turn");
  assert.equal(ordinals.length, 3, "barrier, one running check, one idle check");
  assert.deepEqual([...ordinals].sort((a, b) => a - b), ordinals, "ordinals stay strictly increasing");
  assert.ok(Date.now() - started < 10_000, "settles after quiet intervals, not the timeout");
});

for (const [state, message] of [["failed", /failed/], ["interrupted", /aborted/]] as const) {
  test(`reconciliation reporting ${state} rejects without waiting for the timeout`, async (t) => {
    const store = quietStore();
    t.after(() => store.close());
    const { runtime } = quietRuntime([state]);
    const started = Date.now();
    await assert.rejects(
      () => oneShot(runtime, { cwd: "/repos/demo", prompt: "title", taskId: `quiet-${state}`, timeoutMs: 20_000 }, store),
      message,
    );
    assert.ok(Date.now() - started < 10_000);
  });
}

test("a runtime that reports turn stop never needs the quiet reconcile", async (t) => {
  const store = quietStore();
  t.after(() => store.close());
  const { runtime, ordinals } = quietRuntime(["idle"], true);
  const text = await oneShot(runtime, { cwd: "/repos/demo", prompt: "title", taskId: "quiet-stop", timeoutMs: 20_000 }, store);
  assert.equal(text, "Fix login redirect");
  assert.equal(ordinals.length, 1, "only the barrier reconcile ran");
});
