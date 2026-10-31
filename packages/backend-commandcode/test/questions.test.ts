import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject, RuntimeEvent } from "@polyth/contracts";
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "../src/rpc.ts";
import { createCommandCodeRuntime } from "../src/runtime.ts";

const fakeRpc = (options: { unknownQuestionAfterReceipt?: boolean } = {}) => {
  const receipts: Record<string, string> = {};
  const events = new Set<(event: CommandCodeWorkerEvent) => void>();
  const closes = new Set<() => void>();
  const questionCalls: Array<{ operationId: string; requestId: string; answer: JsonObject }> = [];
  let bindingPath = "";

  const emit = (event: CommandCodeWorkerEvent) => {
    for (const callback of events) callback(event);
  };

  const appendMutation = async (
    operationId: string,
    mutationKind: "turn-submit" | "question-reply" | "question-reject",
    entityId?: string,
  ) => {
    const state = JSON.parse(await readFile(bindingPath, "utf8"));
    await writeFile(bindingPath, JSON.stringify({
      ...state,
      ...(mutationKind === "turn-submit"
        ? {
            nativeSessionId: "cc-native",
            nativeBoundAt: Date.now(),
            acceptedOperations: [...new Set([...(state.acceptedOperations ?? []), operationId])],
          }
        : {}),
      acceptedMutations: [
        ...(state.acceptedMutations ?? []),
        { operationId, mutationKind, ...(entityId ? { entityId } : {}) },
      ],
      updatedAt: Date.now(),
    }));
  };

  const rpc: CommandCodeRpc = {
    authorityId: "cc-question-authority",
    generation: 2,
    receipts,
    releasedAuthorities: [],
    async request<T>(command) {
      if (command.type === "start_turn") {
        bindingPath = String(command.bindingPath);
        const operationId = String(command.operationId);
        await appendMutation(operationId, "turn-submit");
        return { nativeSessionId: "cc-native" } as T;
      }
      if (command.type === "answer_question") {
        const operationId = String(command.operationId);
        const requestId = String(command.requestId);
        const answer = command.answer as JsonObject;
        const mutationKind = answer.action === "reject" ? "question-reject" : "question-reply";
        questionCalls.push({ operationId, requestId, answer });
        await appendMutation(operationId, mutationKind, requestId);
        if (options.unknownQuestionAfterReceipt) {
          throw Object.assign(new Error("question acknowledgement was lost"), { code: "outcome-unknown" });
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
  return { rpc, emit, questionCalls };
};

async function fixture(options: { unknownQuestionAfterReceipt?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-question-"));
  const fake = fakeRpc(options);
  const bindingFile = join(dir, "binding.json");
  const runtime = createCommandCodeRuntime({
    context: { spaceId: "space", projectId: "project", sessionId: "canonical", cwd: dir },
    rpc: fake.rpc,
    bindingFile,
    bridgePath: join(dir, "bridge.ts"),
    models: async () => [],
  });
  const created = await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Questions", cwd: dir },
    "create-question-session",
  );
  assert.equal(created.kind, "confirmed");
  if (created.kind !== "confirmed") throw new Error("question fixture session create failed");
  const admitted = await runtime.startTurnOperation!(
    { sessionId: "canonical", text: "ask me before choosing" },
    "question-turn",
  );
  assert.equal(admitted.kind, "confirmed");
  return { dir, fake, bindingFile, runtime, created };
}

const nativeQuestionRecord = {
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
};

test("native Command Code question stays pending until Polyth answers it", async () => {
  const { dir, fake, bindingFile, runtime, created } = await fixture();
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_sessionId, event) => events.push(event));
  try {
    fake.emit({ type: "commandcode-record", operationId: "question-turn", record: nativeQuestionRecord });
    assert.ok(events.some((event) => event.type === "question/asked" && event.requestId === "ask-1"));

    const endpoint = await runtime.endpoint!();
    const before = await runtime.reconcile!({
      canonicalSessionId: "canonical",
      backendSessionId: created.value.backendSessionId,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      location: endpoint.location,
      reconciliationOrdinal: 1,
    });
    assert.equal(before.questions.length, 1);
    assert.equal(before.questions[0]?.requestId, "ask-1");

    const answered = await runtime.replyQuestionOperation!(
      "canonical",
      "ask-1",
      { answers: [["React"]] },
      "question-answer-op",
    );
    assert.deepEqual(answered, { kind: "confirmed", value: {} });
    assert.deepEqual(fake.questionCalls, [{
      operationId: "question-answer-op",
      requestId: "ask-1",
      answer: { answers: [["React"]] },
    }]);

    const binding = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.ok(binding.acceptedMutations.some((entry: { operationId: string; mutationKind: string; entityId?: string }) =>
      entry.operationId === "question-answer-op"
      && entry.mutationKind === "question-reply"
      && entry.entityId === "ask-1"));

    const after = await runtime.reconcile!({
      canonicalSessionId: "canonical",
      backendSessionId: created.value.backendSessionId,
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
      continuity: endpoint.continuity,
      location: endpoint.location,
      reconciliationOrdinal: 2,
    });
    assert.deepEqual(after.questions, []);
    assert.ok(after.acceptedOperations.some((entry) =>
      entry.operationId === "question-answer-op" && entry.mutationKind === "question-reply"));
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lost question acknowledgement recovers confirmed from the durable Mod receipt", async () => {
  const { dir, fake, runtime } = await fixture({ unknownQuestionAfterReceipt: true });
  try {
    fake.emit({ type: "commandcode-record", operationId: "question-turn", record: nativeQuestionRecord });
    const outcome = await runtime.replyQuestionOperation!(
      "canonical",
      "ask-1",
      { answers: [["Vue"]] },
      "question-lost-ack",
    );
    assert.deepEqual(outcome, { kind: "confirmed", value: {} });
    assert.equal(fake.questionCalls.length, 1);
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("question rejection is delivered explicitly instead of auto-selecting an option", async () => {
  const { dir, fake, runtime, bindingFile } = await fixture();
  try {
    fake.emit({ type: "commandcode-record", operationId: "question-turn", record: nativeQuestionRecord });
    const outcome = await runtime.replyQuestionOperation!(
      "canonical",
      "ask-1",
      { action: "reject" },
      "question-reject-op",
    );
    assert.deepEqual(outcome, { kind: "confirmed", value: {} });
    assert.deepEqual(fake.questionCalls[0], {
      operationId: "question-reject-op",
      requestId: "ask-1",
      answer: { action: "reject" },
    });
    const binding = JSON.parse(await readFile(bindingFile, "utf8"));
    assert.ok(binding.acceptedMutations.some((entry: { operationId: string; mutationKind: string; entityId?: string }) =>
      entry.operationId === "question-reject-op"
      && entry.mutationKind === "question-reject"
      && entry.entityId === "ask-1"));
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale Command Code question returns generic not-found for automatic expiry", async () => {
  const { dir, fake, runtime } = await fixture();
  try {
    fake.emit({ type: "commandcode-record", operationId: "question-turn", record: nativeQuestionRecord });
    fake.emit({ type: "turn-exit", operationId: "question-turn", code: 1, signal: null, stderr: "failed" });
    const outcome = await runtime.replyQuestionOperation!(
      "canonical",
      "ask-1",
      { answers: [["React"]] },
      "stale-question-answer",
    );
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") assert.equal(outcome.code, "not-found");
  } finally {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
