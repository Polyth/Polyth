import test from "node:test";
import assert from "node:assert/strict";
import type {
  AgentRuntime,
  CreateSessionInput,
  JsonObject,
  RuntimeEvent,
} from "@polyth/contracts";
import {
  createMultirunService,
  type RunOneFn,
  type RunUpdate,
} from "../src/index.ts";
import { createMultirunRunOne } from "../src/runner.ts";

interface Harness {
  events: Array<{ sessionId: string; type: string; data: JsonObject }>;
  service: ReturnType<typeof createMultirunService>;
}

const flush = () => new Promise((r) => setImmediate(r));

function harness(runOne: RunOneFn): Harness {
  const events: Array<{ sessionId: string; type: string; data: JsonObject }> = [];
  const service = createMultirunService({
    append: async (sessionId, type, data) => {
      events.push({ sessionId, type, data });
    },
    runOne,
    now: () => 1000,
  });
  return { events, service };
}

const types = (h: Harness) => h.events.map((e) => e.type);

test("start rejects empty prompt or no runs", async () => {
  const h = harness(async () => {});
  await assert.rejects(() => h.service.start("s1", { text: "", runs: [{}] }));
  await assert.rejects(() => h.service.start("s1", { text: "hi", runs: [] }));
});

test("start emits multirun/started immediately with run ids", async () => {
  const h = harness(async (_ctx, onUpdate) => onUpdate({ status: "completed", output: "ok" }));
  const { id } = await h.service.start("s1", { text: "hello", runs: [{ model: { providerID: "a", modelID: "m1" } }, { model: { providerID: "b", modelID: "m2" } }] });
  const started = h.events.find((e) => e.type === "multirun/started");
  assert.ok(started);
  assert.equal(started!.data.multirunId, id);
  assert.equal((started!.data.runs as unknown[]).length, 2);
});

test("each run reaches completed and multirun/completed fires once all settle", async () => {
  const h = harness(async (_ctx, onUpdate) => {
    onUpdate({ output: "partial" });
    onUpdate({ status: "completed", output: "final answer", tokens: { input: 10, output: 20 }, cost: 0.01 });
  });
  const { id } = await h.service.start("s1", { text: "hello", runs: [{}, {}] });
  await flush();
  await flush();
  const state = h.service.get(id);
  assert.ok(state);
  assert.equal(state!.runs.length, 2);
  for (const r of state!.runs) {
    assert.equal(r.status, "completed");
    assert.equal(r.output, "final answer");
    assert.equal(r.cost, 0.01);
  }
  assert.equal(types(h).filter((t) => t === "multirun/completed").length, 1);
  assert.ok(types(h).includes("multirun/run-progress"));
});

test("a run that throws is marked failed but does not block sibling runs or completion", async () => {
  let calls = 0;
  const h = harness(async (ctx, onUpdate) => {
    calls++;
    if (ctx.runId && calls === 1) throw new Error("boom");
    onUpdate({ status: "completed", output: "fine" });
  });
  const { id } = await h.service.start("s1", { text: "hello", runs: [{}, {}] });
  await flush();
  await flush();
  const state = h.service.get(id)!;
  const statuses = state.runs.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["completed", "failed"]);
  assert.equal(types(h).filter((t) => t === "multirun/completed").length, 1);
});

test("pick emits multirun/picked and records pickedRunId", async () => {
  const h = harness(async (_ctx, onUpdate) => onUpdate({ status: "completed", output: "x" }));
  const { id } = await h.service.start("s1", { text: "hello", runs: [{}] });
  await flush();
  const runId = h.service.get(id)!.runs[0]!.id;
  await h.service.pick(id, runId);
  assert.equal(h.service.get(id)!.pickedRunId, runId);
  assert.ok(types(h).includes("multirun/picked"));
});

test("pick rejects unknown multirun or run id", async () => {
  const h = harness(async () => {});
  await assert.rejects(() => h.service.pick("nope", "r1"));
  const { id } = await h.service.start("s1", { text: "hello", runs: [{}] });
  await assert.rejects(() => h.service.pick(id, "not-a-run"));
});

test("snapshot maps to the wire DTO shape", async () => {
  const h = harness(async (_ctx, onUpdate) => onUpdate({ status: "completed", output: "x", tokens: { input: 1, output: 2 } }));
  const { id } = await h.service.start("s1", { text: "hello", runs: [{ model: { providerID: "p", modelID: "m" }, agent: "build" }] });
  await flush();
  const dto = h.service.snapshot(h.service.get(id)!);
  assert.equal(dto.id, id);
  assert.equal(dto.prompt, "hello");
  assert.equal(dto.runs.length, 1);
  assert.equal(dto.runs[0]!.status, "completed");
  assert.equal(dto.runs[0]!.agent, "build");
  assert.deepEqual(dto.runs[0]!.model, { providerID: "p", modelID: "m" });
});

test("runner creates and streams a throwaway session in the resolved cwd", async () => {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  let created: (CreateSessionInput & { sessionId: string; cwd: string }) | undefined;
  const runtime = {
    ensureSession: async (input: CreateSessionInput & { sessionId: string; cwd: string }) => {
      created = input;
      return "backend-session";
    },
    startTurn: async (input: { sessionId: string; text: string }) => {
      for (const listener of listeners) {
        listener(input.sessionId, { type: "assistant/chunk", partId: "part-1", text: "partial" });
        listener(input.sessionId, {
          type: "assistant/message",
          partId: "part-1",
          text: "final",
          tokens: { input: 2, output: 3 },
          cost: 0.01,
        });
        listener(input.sessionId, { type: "turn/stopped", reason: "completed" });
      }
    },
    onEvent: (listener: (sessionId: string, event: RuntimeEvent) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  } as unknown as AgentRuntime;
  const updates: RunUpdate[] = [];
  const runOne = createMultirunRunOne(async () => ({
    rt: runtime,
    cwd: "/repos/demo-worktrees/fix",
  }));

  await runOne({
    sessionId: "parent-session",
    multirunId: "multi-1",
    runId: "run-1",
    prompt: "Compare approaches",
  }, (patch) => updates.push(patch));

  assert.deepEqual(created, {
    sessionId: "multirun-run-1",
    cwd: "/repos/demo-worktrees/fix",
    projectId: "multirun",
    title: "polyth multirun",
  });
  assert.deepEqual(updates, [
    { output: "partial" },
    {
      output: "final",
      tokens: { input: 2, output: 3 },
      cost: 0.01,
    },
  ]);
  assert.equal(listeners.size, 0, "the runtime subscription is disposed");
});
