import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "@polyth/contracts";
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "../src/rpc.ts";
import { createCommandCodeRuntime } from "../src/runtime.ts";

const fakeRpc = () => {
  const events = new Set<(event: CommandCodeWorkerEvent) => void>();
  const closes = new Set<() => void>();
  const receipts: Record<string, string> = {};
  let bindingPath = "";
  const answerCalls: Array<{ operationId: string; requestId: string; answer: JsonObject }> = [];

  const rpc: CommandCodeRpc = {
    authorityId: "cc-question-failure-authority",
    generation: 1,
    receipts,
    releasedAuthorities: [],
    async request<T>(command) {
      if (command.type === "start_turn") {
        bindingPath = String(command.bindingPath);
        const operationId = String(command.operationId);
        const state = JSON.parse(await readFile(bindingPath, "utf8"));
        await writeFile(bindingPath, JSON.stringify({
          ...state,
          nativeSessionId: "cc-native",
          nativeBoundAt: Date.now(),
          acceptedOperations: [operationId],
          acceptedMutations: [{ operationId, mutationKind: "turn-submit" }],
          updatedAt: Date.now(),
        }));
        return { nativeSessionId: "cc-native" } as T;
      }
      if (command.type === "answer_question") {
        answerCalls.push({
          operationId: String(command.operationId),
          requestId: String(command.requestId),
          answer: command.answer as JsonObject,
        });
        // Mirrors the worker outcome when the Mod closes the control socket
        // because it could not durably persist the response receipt.
        throw Object.assign(new Error("question response outcome is unknown"), { code: "outcome-unknown" });
      }
      if (command.type === "abort" || command.type === "shutdown") return {} as T;
      throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    },
    async receipt(operationId, id) { receipts[operationId] = id; },
    onEvent(callback) { events.add(callback); return { dispose: () => events.delete(callback) }; },
    onClose(callback) { closes.add(callback); return { dispose: () => closes.delete(callback) }; },
    async close() { for (const callback of closes) callback(); },
  };

  return {
    rpc,
    answerCalls,
    emit(event: CommandCodeWorkerEvent) {
      for (const callback of events) callback(event);
    },
  };
};

test("unreceipted question response failure remains outcome-unknown and question stays pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-question-receipt-failure-"));
  const fake = fakeRpc();
  const bindingFile = join(dir, "binding.json");
  const runtime = createCommandCodeRuntime({
    context: { spaceId: "space", projectId: "project", sessionId: "canonical", cwd: dir },
    rpc: fake.rpc,
    bindingFile,
    bridgePath: join(dir, "bridge.ts"),
    models: async () => [],
  });

  try {
    const created = await runtime.createSessionOperation!(
      { projectId: "project", sessionId: "canonical", title: "Questions", cwd: dir },
      "create-question-session",
    );
    assert.equal(created.kind, "confirmed");
    if (created.kind !== "confirmed") return;

    const admitted = await runtime.startTurnOperation!(
      { sessionId: "canonical", text: "ask me first" },
      "question-turn",
    );
    assert.equal(admitted.kind, "confirmed");

    fake.emit({
      type: "commandcode-record",
      operationId: "question-turn",
      record: {
        type: "event",
        event: {
          type: "tool_queued",
          toolCallId: "ask-1",
          toolName: "ask_user_question",
          input: {
            questions: [{
              question: "Which framework?",
              header: "Framework",
              options: [{ label: "React" }, { label: "Vue" }],
              multiSelect: false,
            }],
          },
        },
      },
    });

    const outcome = await runtime.replyQuestionOperation!(
      "canonical",
      "ask-1",
      { answers: [["React"]] },
      "question-answer-no-receipt",
    );
    assert.equal(outcome.kind, "unknown");
    assert.equal(fake.answerCalls.length, 1);

    const binding = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.equal(binding.acceptedMutations.some((entry: { operationId: string }) =>
      entry.operationId === "question-answer-no-receipt"), false);

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
    assert.deepEqual(snapshot.questions.map((question) => question.requestId), ["ask-1"]);
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
