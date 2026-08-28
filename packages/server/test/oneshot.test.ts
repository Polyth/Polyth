import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRuntime } from "@polyth/contracts";
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
