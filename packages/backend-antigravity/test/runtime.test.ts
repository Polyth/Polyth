import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { createAntigravityRuntime } from "../src/runtime.ts";

const model = { providerID: "antigravity", modelID: "fixture-gemini", variant: "high" };
const context = { spaceId: "space-a", projectId: "project-a", sessionId: "session-a", cwd: "/project", model };
const request = { ...context };
const flush = async () => { await tick(); await tick(); };
function fixture(t: TestContext, options: { receipts?: Record<string, string>; autoInit?: boolean; timeoutMs?: number } = {}) {
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const inputs: Array<Record<string, unknown>> = [];
  const events: RuntimeEvent[] = [];
  const launches: string[][] = [];
  let releaseFailure = false;
  let releases = 0;
  const authority: HarnessProcessAuthority = {
    authorityId: "authority-a", generation: 1, receipts: options.receipts ?? {}, releasedAuthorities: [], durable: true,
    spawn(_command, args) {
      launches.push(args);
      if (options.autoInit !== false) queueMicrotask(() => send({ event: "init", conversation_id: "native-a", init: { cwd: context.cwd, model: model.modelID } }));
      return proc as unknown as ChildProcess;
    },
    async receipt(id, value) { this.receipts[id] = value; },
    async close() {
      releases++;
      if (releaseFailure) throw new Error("no containment proof");
    },
  };
  proc.stdin.on("data", (chunk: Buffer) => { for (const line of chunk.toString().trim().split("\n")) if (line) inputs.push(JSON.parse(line)); });
  const send = (frame: unknown) => proc.stdout.write(JSON.stringify(frame) + "\n");
  const runtime = createAntigravityRuntime({ context, authority, command: "agy-fixture", models: async () => [{ ...model, name: "Fixture Gemini", harnessId: "antigravity", variants: ["low", "medium", "high"] }], timeoutMs: options.timeoutMs ?? 500 });
  runtime.onEvent((_id, event) => events.push(event));
  t.after(async () => { releaseFailure = false; await runtime.dispose(); });
  const inputStep = (index = 0) => send({ event: "step_update", step_update: { conversation_id: "native-a", step_index: index, state: "DONE", step_type: "user_input" } });
  const finish = (turns = 1, input = 100, output = 10) => send({ event: "result", result: { conversation_id: "native-a", status: "SUCCESS", response: "Answer", num_turns: turns, usage: { input_tokens: input, output_tokens: output, thinking_tokens: 0, cache_read_tokens: 0 } } });
  const start = (id = "turn-a", body = "Hello") => runtime.startTurnOperation!({ sessionId: context.sessionId, text: body, model }, id);
  return { runtime, authority, proc, inputs, events, launches, send, inputStep, finish, start, get releases() { return releases; }, set releaseFailure(value: boolean) { releaseFailure = value; } };
}

test("native create is lazy, records exact ID and doesn't submit a paid prompt", async (t) => {
  const f = fixture(t);
  assert.equal(f.launches.length, 0);
  const created = await f.runtime.createSessionOperation!(request, "create-a");
  assert.deepEqual(created, { kind: "confirmed", value: { backendSessionId: "native-a" }, receipt: "native-a" });
  assert.equal(f.authority.receipts["create:create-a"], "native-a");
  assert.equal(f.inputs.length, 0);
  assert.equal(f.launches.length, 1);
});

test("admission waits for native evidence, only sends the new prompt and never replays an ID", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start();
  await flush();
  assert.deepEqual(f.inputs, [{ event: "user", message: { content: "Hello" } }]);
  assert.equal(f.authority.receipts["sent:turn-a"], "native-a");
  assert.equal(f.authority.receipts["turn:turn-a"], undefined);
  assert.equal((await f.start("turn-b")).kind, "rejected");
  f.inputStep();
  assert.equal((await pending).kind, "confirmed");
  assert.equal((await f.start()).kind, "confirmed");
  assert.equal(f.inputs.length, 1);
  f.finish(); await flush();
  const second = f.start("turn-b", "Next question");
  await flush(); f.inputStep(3);
  assert.equal((await second).kind, "confirmed");
  assert.deepEqual(f.inputs[1], { event: "user", message: { content: "Next question" } });
  f.finish(2, 140, 16); await flush();
  assert.deepEqual(f.events.filter((event) => event.type === "usage/recorded").map((event) => event.tokens), [
    { input: 100, output: 10, reasoning: 0, cacheRead: 0 },
    { input: 40, output: 6, reasoning: 0, cacheRead: 0 },
  ]);
});

test("late old result and steps cannot finalize or contaminate the next turn", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const first = f.start(); await flush(); f.inputStep(); await first;
  f.finish(); await flush();
  const second = f.start("turn-b"); await flush();
  f.finish(); f.inputStep(); await flush();
  assert.equal(f.events.filter((event) => event.type === "turn/stopped").length, 1);
  assert.equal(f.authority.receipts["turn:turn-b"], undefined);
  f.inputStep(3); assert.equal((await second).kind, "confirmed");
  f.finish(2); await flush();
  assert.equal(f.events.filter((event) => event.type === "turn/stopped").length, 2);
});

test("resume uses recorded exact ID, rejects foreign sessions and unknown prompt replays", async (t) => {
  const f = fixture(t, { receipts: { "create:create-a": "native-a", "sent:uncertain": "native-a" } });
  await assert.rejects(f.runtime.ensureSession({ ...request, backendSessionId: "foreign-native" }), { code: "unknown-session" });
  assert.equal(f.launches.length, 0);
  assert.equal(await f.runtime.ensureSession({ ...request, backendSessionId: "native-a" }), "native-a");
  // Resume appears before the model flags, never ambient --continue.
  assert.equal(f.launches[0]?.[f.launches[0]!.indexOf("--conversation") + 1], "native-a");
  assert.equal(f.launches[0]?.includes("--continue"), false);
  assert.equal((await f.start("uncertain")).kind, "unknown");
  assert.equal(f.inputs.length, 0);
});

test("first resumed turn uses observed step usage, not historical cumulative counters", async (t) => {
  const f = fixture(t, { receipts: { "create:create-a": "native-a" } });
  await f.runtime.ensureSession({ ...request, backendSessionId: "native-a" });
  const pending = f.start(); await flush(); f.inputStep(40); await pending;
  f.send({ event: "step_update", step_update: { conversation_id: "native-a", step_index: 41, state: "DONE", step_type: "checkpoint", usage: { input_tokens: 7, output_tokens: 2 } } });
  f.finish(10, 9999, 999); await flush();
  assert.deepEqual(f.events.filter((event) => event.type === "usage/recorded")[0]?.tokens, { input: 7, output: 2, reasoning: 0, cacheRead: 0 });
});

test("malformed native output fences the process and returns unknown instead of replay", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush();
  f.proc.stdout.write("not-json\n");
  assert.equal((await pending).kind, "unknown");
  await flush();
  assert.ok(f.releases > 0);
  assert.equal((await f.start()).kind, "unknown");
  assert.equal(f.inputs.length, 1);
  assert.equal(f.events.some((event) => event.type === "turn/stopped" && event.reason === "completed"), false);
});

test("EOF without result never succeeds even if the process exits normally", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush();
  f.proc.emit("close", 0, null);
  assert.equal((await pending).kind, "unknown"); await flush();
  assert.equal(f.events.some((event) => event.type === "turn/stopped" && event.reason === "completed"), false);
  assert.ok(f.releases > 0);
});

test("foreign conversation frame fails closed before publishing its content", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush();
  f.send({ event: "step_update", step_update: { conversation_id: "other-space", step_index: 0, state: "DONE", step_type: "agent_response", text_delta: "Foreign content" } });
  assert.equal((await pending).kind, "unknown"); await flush();
  assert.equal(JSON.stringify(f.events).includes("Foreign content"), false);
});

test("a native error step keeps the runtime connected and surfaces the denial", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  f.send({ event: "step_update", step_update: { conversation_id: "native-a", step_index: 5, state: "ERROR", step_type: "tool", tool_name: "run_command", error: "permission check failed for unsandboxed command" } });
  await flush();
  assert.deepEqual(f.events.filter((event) => event.type.startsWith("tool/")), [
    { type: "tool/started", callId: "turn-a:step:5", tool: "run_command", input: {} },
    { type: "tool/error", callId: "turn-a:step:5", tool: "run_command", error: "permission check failed for unsandboxed command" },
  ]);
  assert.equal(f.releases, 0);
  f.finish(2); await flush();
  assert.deepEqual(f.events.filter((event) => event.type === "turn/stopped").map((event) => event.reason), ["completed"]);
  assert.equal(f.launches.length, 1);
});
test("lost initialization is bounded and never submits a prompt", async (t) => {
  const f = fixture(t, { autoInit: false, timeoutMs: 20 });
  assert.equal((await f.runtime.createSessionOperation!(request, "create-a")).kind, "unknown");
  await flush();
  assert.equal(f.inputs.length, 0);
  assert.ok(f.releases > 0);
});

test("abort is confirmed only after process-tree release; lack of proof stays unknown", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  f.releaseFailure = true;
  assert.equal((await f.runtime.abortOperation!(context.sessionId, "abort-a")).kind, "unknown");
  assert.equal(f.events.some((event) => event.type === "turn/stopped" && event.reason === "aborted"), false);
  f.releaseFailure = false;
  assert.equal((await f.runtime.abortOperation!(context.sessionId, "abort-a")).kind, "confirmed");
  assert.equal(f.events.some((event) => event.type === "turn/stopped" && event.reason === "aborted"), true);
});

test("unsupported controls and attachments fail before input; no silent model change", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  for (const extra of [
    { model: { ...model, variant: "low" } },
    { command: { id: "native:model", owner: "native" as const, name: "model" } },
    { attachments: [{ id: "image", name: "image", mime: "image/png", size: 1, path: "/tmp/picture.png" }] },
  ]) {
    assert.equal((await f.runtime.startTurnOperation!({ sessionId: context.sessionId, text: "Hello", ...extra }, "rejected")).kind, "rejected");
  }
  assert.equal(f.inputs.length, 0);
  await assert.rejects(f.runtime.replyPermission(context.sessionId, "p", "once"), { code: "unsupported" });
});

test("observations and pull reconciliation share identities and enforce generation/Space fences", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const endpoint = await f.runtime.endpoint!();
  const binding = { ...endpoint, canonicalSessionId: context.sessionId, backendSessionId: "native-a", reconciliationOrdinal: 2 };
  await f.runtime.reconcile!(binding);
  const observed: string[] = [];
  f.runtime.onObservation!((_id, observation) => observed.push(observation.entityKey));
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  f.finish(); await flush();
  const snapshot = await f.runtime.reconcile!(binding);
  assert.ok(observed.length > 0);
  assert.deepEqual(snapshot.events.map((entry) => entry.entityKey), observed);
  const foreign = await f.runtime.reconcile!({ ...binding, generation: endpoint.generation + 1 });
  assert.equal(foreign.state.value, "unknown");
  assert.equal(foreign.events.length, 0);
  assert.equal((await f.runtime.releaseExecution!({ ...binding, canonicalSessionId: "another-session" }, "release-a")).kind, "rejected");
  assert.equal((await f.runtime.releaseExecution!(binding, "release-a")).kind, "confirmed");
});

test("concurrent creates cannot change receipt ownership while catalog discovery is pending", async (t) => {
  const f = fixture(t);
  const first = f.runtime.createSessionOperation!(request, "create-a");
  const second = await f.runtime.createSessionOperation!(request, "create-b");
  assert.equal(second.kind, "rejected");
  assert.equal((await first).kind, "confirmed");
  assert.equal(f.authority.receipts["create:create-a"], "native-a");
  assert.equal(f.authority.receipts["create:create-b"], undefined);
  assert.equal(f.launches.length, 1);
});

test("reconciliation retains native admission receipts across runtime recreation", async (t) => {
  const f = fixture(t, { receipts: { "create:create-a": "native-a", "turn:turn-old": "native-a" } });
  await f.runtime.ensureSession({ ...request, backendSessionId: "native-a" });
  const endpoint = await f.runtime.endpoint!();
  const snapshot = await f.runtime.reconcile!({ ...endpoint, canonicalSessionId: context.sessionId, backendSessionId: "native-a", reconciliationOrdinal: 1 });
  assert.equal(snapshot.acceptedOperations?.[0]?.operationId, "turn-old");
  await assert.rejects(f.runtime.ensureSession({ ...request, model: { ...model, variant: "low" }, backendSessionId: "native-a" }), { code: "unsupported" });
  assert.equal(f.inputs.length, 0);
});
