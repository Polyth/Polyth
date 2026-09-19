import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import type { HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { createAntigravityRuntime } from "../src/runtime.ts";
import type { AntigravityTitleReader } from "../src/title.ts";

const model = { providerID: "antigravity", modelID: "fixture-gemini", variant: "high" };
const context = { spaceId: "space-a", projectId: "project-a", sessionId: "session-a", cwd: "/project", model };
const request = { ...context };
const flush = async () => { await tick(); await tick(); };
function fixture(t: TestContext, options: {
  receipts?: Record<string, string>;
  autoInit?: boolean;
  timeoutMs?: number;
  permissionMode?: string;
  autoApprove?: boolean;
  titleReader?: AntigravityTitleReader;
} = {}) {
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const inputs: Array<Record<string, unknown>> = [];
  const controls: Array<Record<string, unknown>> = [];
  const events: RuntimeEvent[] = [];
  const launches: string[][] = [];
  let autoApprove = options.autoApprove ?? false;
  let hookHandler: ((payload: unknown) => Promise<{ decision: "allow" | "deny"; reason?: string }>) | undefined;
  let nativeMode = "";
  let releaseFailure = false;
  let releases = 0;
  const authority: HarnessProcessAuthority = {
    authorityId: "authority-a", generation: 1, receipts: options.receipts ?? {}, releasedAuthorities: [], durable: true,
    spawn() {
      return proc as unknown as ChildProcess;
    },
    async receipt(id, value) { this.receipts[id] = value; },
    async close() {
      releases++;
      if (releaseFailure) throw new Error("no containment proof");
    },
  };
  const send = (frame: unknown) => proc.stdout.write(JSON.stringify(frame) + "\n");
  proc.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      if (!line) continue;
      const control = JSON.parse(line) as Record<string, unknown>;
      controls.push(control);
      if (control.event === "polyth_launch") {
        const args = control.args as string[];
        launches.push(args);
        nativeMode = String(control.mode);
        if (options.autoInit !== false) queueMicrotask(() => send({
          event: "init",
          conversation_id: "native-a",
          init: {
            cwd: context.cwd,
            model: model.modelID,
            permission_mode: options.permissionMode
              ?? (args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review"),
          },
        }));
      } else if (control.event === "polyth_user") {
        const args = control.args as string[];
        if (control.mode !== nativeMode) {
          launches.push(args);
          nativeMode = String(control.mode);
          queueMicrotask(() => send({
            event: "polyth_reinit",
            polyth_reinit: {
              event: "init",
              conversation_id: "native-a",
              init: {
                cwd: context.cwd,
                model: model.modelID,
                permission_mode: args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review",
              },
            },
          }));
        }
        inputs.push(control.input as Record<string, unknown>);
      }
    }
  });
  const runtime = createAntigravityRuntime({
    context,
    authority,
    command: "agy-fixture",
    workerPath: "/polyth/antigravity-worker.mjs",
    models: async () => [{ ...model, name: "Fixture Gemini", harnessId: "antigravity", variants: ["low", "medium", "high"] }],
    autoApprove: async () => autoApprove,
    ...(options.titleReader ? { titleReader: options.titleReader } : {}),
    permissionBridge: async (handle) => {
      hookHandler = handle;
      return { root: "/polyth-hooks", prepare: async () => {}, close: async () => {} };
    },
    timeoutMs: options.timeoutMs ?? 500,
  });
  runtime.onEvent((_id, event) => events.push(event));
  t.after(async () => { releaseFailure = false; await runtime.dispose(); });
  const inputStep = (index = 0) => send({ event: "step_update", step_update: { conversation_id: "native-a", step_index: index, state: "DONE", step_type: "user_input" } });
  const finish = (turns = 1, input = 100, output = 10) => send({ event: "result", result: { conversation_id: "native-a", status: "SUCCESS", response: "Answer", num_turns: turns, usage: { input_tokens: input, output_tokens: output, thinking_tokens: 0, cache_read_tokens: 0 } } });
  const start = (id = "turn-a", body = "Hello") => runtime.startTurnOperation!({ sessionId: context.sessionId, text: body, model }, id);
  const hook = (tool: string, args: Record<string, unknown>, stepIdx = 2) => {
    if (!hookHandler) throw new Error("permission bridge is not initialized");
    return hookHandler({ conversationId: "native-a", stepIdx, toolCall: { name: tool, args } });
  };
  return {
    runtime, authority, proc, inputs, controls, events, launches, send, inputStep, finish, start, hook,
    get releases() { return releases; },
    set releaseFailure(value: boolean) { releaseFailure = value; },
    set autoApprove(value: boolean) { autoApprove = value; },
  };
}

test("native create is lazy, records exact ID and doesn't submit a paid prompt", async (t) => {
  const f = fixture(t);
  assert.equal(f.launches.length, 0);
  const created = await f.runtime.createSessionOperation!(request, "create-a");
  assert.deepEqual(created, { kind: "confirmed", value: { backendSessionId: "native-a" }, receipt: "native-a" });
  assert.equal(f.authority.receipts["create:create-a"], "native-a");
  assert.equal(f.inputs.length, 0);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]?.includes("--dangerously-skip-permissions"), false);
  assert.equal(f.launches[0]?.includes("--sandbox"), false);
});

test("native initialization must confirm approval-required mode when Auto-Approve is off", async (t) => {
  const f = fixture(t, { permissionMode: "always-proceed" });
  const created = await f.runtime.createSessionOperation!(request, "create-a");
  assert.equal(created.kind, "unknown");
  await flush();
  assert.equal(f.releases, 1);
});

test("Auto-Approve launches the native CLI with the literal dangerous flag and no sandbox", async (t) => {
  const f = fixture(t, { autoApprove: true });
  assert.equal((await f.runtime.createSessionOperation!(request, "create-a")).kind, "confirmed");
  assert.equal(f.launches[0]?.includes("--dangerously-skip-permissions"), true);
  assert.equal(f.launches[0]?.includes("--sandbox"), false);
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

test("manual mode routes a command through Polyth permission events and applies the reply", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const admission = f.start(); await flush(); f.inputStep(); await admission;
  const decision = f.hook("run_command", { CommandLine: "npm test", Cwd: context.cwd });
  await flush();
  const event = f.events.find((candidate) => candidate.type === "permission/requested");
  assert.equal(event?.type, "permission/requested");
  if (event?.type !== "permission/requested") throw new Error("permission event missing");
  assert.equal(event.permission, "bash");
  assert.deepEqual(event.patterns, ["npm test"]);
  const endpoint = await f.runtime.endpoint!();
  const snapshot = await f.runtime.reconcile!({
    ...endpoint,
    canonicalSessionId: context.sessionId,
    backendSessionId: "native-a",
  });
  assert.equal(snapshot.permissions[0]?.requestId, event.requestId);
  assert.equal((await f.runtime.replyPermissionOperation!(context.sessionId, event.requestId, "once", "permission-a")).kind, "confirmed");
  assert.deepEqual(await decision, { decision: "allow" });
  assert.equal((await f.runtime.replyPermissionOperation!(context.sessionId, event.requestId, "once", "permission-b")).kind, "rejected");
  f.finish(); await flush();
});

test("changing Auto-Approve replaces only the idle native leg and changes the exact launch flag", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  f.autoApprove = true;
  const first = f.start(); await flush(); f.inputStep(); await first;
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1]?.includes("--dangerously-skip-permissions"), true);
  assert.deepEqual(await f.hook("run_command", { CommandLine: "npm test" }), { decision: "allow" });
  assert.equal(f.events.some((event) => event.type === "permission/requested"), false);
  f.finish(); await flush();

  f.autoApprove = false;
  const second = f.start("turn-b", "Review again"); await flush(); f.inputStep(3); await second;
  assert.equal(f.launches.length, 3);
  assert.equal(f.launches[2]?.includes("--dangerously-skip-permissions"), false);
  assert.equal(f.launches.every((args) => !args.includes("--sandbox")), true);
  f.finish(2); await flush();
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

test("surfaces the CLI's generated conversation title from its annotation store", async (t) => {
  const f = fixture(t, { titleReader: { read: async (id) => id === "native-a" ? "Fix Runtime Epoch Error" : undefined } });
  await f.runtime.createSessionOperation!(request, "create-a");
  await flush();
  assert.deepEqual(
    f.events.filter((event) => event.type === "session/title-generated"),
    [{ type: "session/title-generated", title: "Fix Runtime Epoch Error" }],
  );
  assert.equal((await f.runtime.sessions()).find((item) => item.id === "native-a")?.title, "Fix Runtime Epoch Error");
});

test("adopts a title the CLI writes later and refreshes it on resume", async (t) => {
  let title: string | undefined;
  const f = fixture(t, { titleReader: { read: async () => title } });
  await f.runtime.createSessionOperation!(request, "create-a");
  await flush();
  assert.equal(f.events.some((event) => event.type === "session/title-generated"), false);
  const pending = f.start(); await flush(); f.inputStep(); await pending; f.finish(); await flush();
  assert.equal(f.events.some((event) => event.type === "session/title-generated"), false);
  title = "Delayed Native Title";
  await f.runtime.ensureSession({ ...request, backendSessionId: "native-a" });
  await flush();
  assert.deepEqual(
    f.events.filter((event) => event.type === "session/title-generated"),
    [{ type: "session/title-generated", title: "Delayed Native Title" }],
  );
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

test("a native error step with a response keeps the runtime connected and surfaces the denial", async (t) => {
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
test("structured native quota errors reach the shared limit countdown path", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  f.send({ event: "polyth_native_error", polyth_native_error: {
    status: "RESOURCE_EXHAUSTED",
    http_status: 429,
    // AGY can mark the immediate request non-retryable after exhausting its
    // own attempts; the future reset still makes the Polyth turn resumable.
    retryable: false,
    message: "Individual quota reached.",
    reset_at: 1_800_009_000,
  } });
  f.send({ event: "result", result: {
    conversation_id: "native-a", status: "ERROR", response: "",
    error: "Agent execution terminated due to error.", num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 },
  } });
  await flush();
  const stop = f.events.findLast((event) => event.type === "turn/stopped");
  assert.deepEqual(stop, {
    type: "turn/stopped",
    turnId: "turn-a",
    reason: "error",
    error: "Individual quota reached.",
    code: "quota-exhausted",
    retry: {
      scope: "quota",
      provider: "google",
      resetAt: 1_800_009_000_000,
      retryable: true,
    },
  });
  const repeated = f.start("turn-b", "Try after reset");
  await flush();
  f.send({ event: "polyth_native_error", polyth_native_error: {
    status: "RESOURCE_EXHAUSTED", retryable: false,
    message: "Individual quota reached.", reset_at: 1_800_009_000,
  } });
  f.send({ event: "result", result: {
    conversation_id: "native-a", status: "ERROR", response: "",
    error: "Agent execution terminated due to error.", num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 },
  } });
  assert.equal((await repeated).kind, "confirmed");
  await flush();
  assert.deepEqual(
    f.events.filter((event) => event.type === "turn/stopped").map((event) => event.turnId),
    ["turn-a", "turn-b"],
  );
});
test("a soft-denied tool followed by an empty SUCCESS fails instead of stopping silently", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  f.send({ event: "step_update", step_update: {
    conversation_id: "native-a", step_index: 2, state: "ERROR", step_type: "tool", tool_name: "run_command",
    error: "permission check failed for unsandboxed command",
  } });
  f.send({ event: "result", result: {
    conversation_id: "native-a", status: "SUCCESS", response: "", num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0 },
  } });
  await flush();
  const stop = f.events.findLast((event) => event.type === "turn/stopped");
  assert.equal(stop?.reason, "error");
  assert.match(stop?.error ?? "", /instead of completing Polyth's approval flow/);
  assert.equal(f.releases, 0, "a soft denial is not a runtime disconnect");
});
test("a subagent invocation closes its tool proposal instead of a false unterminated error", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  // Observed wire shape: the tool proposal opens a call, then the spawn
  // acknowledgement arrives at the same index with `step_type: "subagent"`.
  f.send({ event: "step_update", step_update: {
    conversation_id: "native-a", step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent",
    tool_info: { name: "invoke_subagent", parameters: { Subagents: [{ TypeName: "self", Role: "Calculator" }] } },
  } });
  f.send({ event: "step_update", step_update: {
    conversation_id: "native-a", step_index: 2, state: "DONE", step_type: "subagent", tool_name: "invoke_subagent",
    subagent_info: { subagents: [{ type_name: "self", role: "Calculator", conversation_id: "child-1" }] },
  } });
  await flush();
  assert.deepEqual(f.events.filter((event) => event.type.startsWith("tool/")), [
    { type: "tool/started", callId: "turn-a:step:2", tool: "invoke_subagent", input: { Subagents: [{ TypeName: "self", Role: "Calculator" }] } },
    { type: "tool/result", callId: "turn-a:step:2", tool: "invoke_subagent", output: "", input: { Subagents: [{ TypeName: "self", Role: "Calculator" }] } },
  ]);
  f.finish(); await flush();
  assert.equal(f.events.some((event) => event.type === "tool/error"), false);
  assert.equal(f.releases, 0);
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
  await assert.rejects(f.runtime.replyPermission(context.sessionId, "p", "once"), { code: "not-found" });
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
