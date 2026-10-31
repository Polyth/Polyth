import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { HarnessCapabilityApplicationReceipt, RuntimeCommandDescriptor, RuntimeEvent } from "@polyth/contracts";
import { setCapabilityReceiptSink } from "@polyth/harness-runtime";
import type { HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { isNativeDelegationTool, NATIVE_DELEGATION_DENY_REASON, type AgyHookDecision, type AgyHookHandler, type AgyInvocationResult, type AgyStopResult } from "../src/permissions.ts";
import { antigravityOverlays } from "../src/provisioner.ts";
import { createAntigravityRuntime } from "../src/runtime.ts";
import type { AntigravityTitleReader } from "../src/title.ts";

const model = { providerID: "antigravity", modelID: "fixture-gemini", variant: "high" };
const context = { spaceId: "space-a", projectId: "project-a", sessionId: "session-a", cwd: "/project", model };
const request = { ...context };
const flush = async () => { await tick(); await tick(); };
/** Attachment staging does real file I/O before the prompt is written. */
const until = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 400 && !ready(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ready(), "condition was not reached");
};
function fixture(t: TestContext, options: {
  receipts?: Record<string, string>;
  autoInit?: boolean;
  timeoutMs?: number;
  permissionMode?: string;
  bypass?: boolean;
  /** false: the worker never proves the native release, so abort must fall
   * back to destroying the whole owned process tree. */
  stopProof?: boolean;
  /** true: the runtime context states no model, so a create with no requested
   * model must report the CLI's own resolved selection. */
  withoutContextModel?: boolean;
  titleReader?: AntigravityTitleReader;
  /** A real workspace directory, for attachment staging. */
  cwd?: string;
  commands?: () => Promise<RuntimeCommandDescriptor[]>;
} = {}) {
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const inputs: Array<Record<string, unknown>> = [];
  const controls: Array<Record<string, unknown>> = [];
  const events: RuntimeEvent[] = [];
  const launches: string[][] = [];
  const cwd = options.cwd ?? context.cwd;
  const hookRoot = mkdtempSync(join(tmpdir(), "polyth-agy-runtime-"));
  t.after(() => rmSync(hookRoot, { recursive: true, force: true }));
  let bypass = options.bypass ?? false;
  let hookHandler: AgyHookHandler | undefined;
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
            cwd,
            model: model.modelID,
            permission_mode: options.permissionMode
              ?? (args.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review"),
          },
        }));
      } else if (control.event === "polyth_stop") {
        // The owned worker proves the native tree released and stays alive.
        if (options.stopProof === false) continue;
        nativeMode = "";
        queueMicrotask(() => send({ event: "polyth_released" }));
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
                cwd,
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
  const runtimeContext = { ...context, cwd, ...(options.withoutContextModel ? { model: undefined } : {}) };
  const runtime = createAntigravityRuntime({
    context: runtimeContext,
    authority,
    command: "agy-fixture",
    workerPath: "/polyth/antigravity-worker.mjs",
    models: async () => [{ ...model, name: "Fixture Gemini", harnessId: "antigravity", variants: ["low", "medium", "high"], defaultVariant: "high" }],
    nativePermissionBypass: async () => bypass,
    ...(options.titleReader ? { titleReader: options.titleReader } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    permissionBridge: async (handle) => {
      hookHandler = handle;
      return { root: hookRoot, prepare: async () => {}, close: async () => {} };
    },
    timeoutMs: options.timeoutMs ?? 500,
  });
  runtime.onEvent((_id, event) => events.push(event));
  t.after(async () => { releaseFailure = false; await runtime.dispose(); });
  const inputStep = (index = 0) => send({ event: "step_update", step_update: { conversation_id: "native-a", step_index: index, state: "DONE", step_type: "user_input" } });
  const finish = (turns = 1, input = 100, output = 10) => send({ event: "result", result: { conversation_id: "native-a", status: "SUCCESS", response: "Answer", num_turns: turns, usage: { input_tokens: input, output_tokens: output, thinking_tokens: 0, cache_read_tokens: 0 } } });
  const start = (id = "turn-a", body = "Hello", extra: Record<string, unknown> = {}) =>
    runtime.startTurnOperation!({ sessionId: context.sessionId, text: body, model, ...extra }, id);
  const handler = () => {
    if (!hookHandler) throw new Error("permission bridge is not initialized");
    return hookHandler;
  };
  const hook = (tool: string, args: Record<string, unknown>, stepIdx = 2) =>
    handler()({ conversationId: "native-a", stepIdx, toolCall: { name: tool, args } }, "PreToolUse") as Promise<AgyHookDecision>;
  const invocation = (conversationId = "native-a") =>
    handler()({ conversationId, invocationNum: 1, initialNumSteps: 1 }, "PreInvocation") as Promise<AgyInvocationResult>;
  const stopHook = (terminationReason = "model_stop") =>
    handler()({ conversationId: "native-a", executionNum: 1, terminationReason, fullyIdle: true }, "Stop") as Promise<AgyStopResult>;
  return {
    runtime, authority, proc, inputs, controls, events, launches, send, inputStep, finish, start, hook, invocation, stopHook,
    cwd, hookRoot,
    get releases() { return releases; },
    set releaseFailure(value: boolean) { releaseFailure = value; },
    set bypass(value: boolean) { bypass = value; },
  };
}
const workspace = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-agy-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const withCwd = (cwd: string) => ({ ...request, cwd });

test("native create is lazy, records exact ID and doesn't submit a paid prompt", async (t) => {
  const f = fixture(t);
  assert.equal(f.launches.length, 0);
  const created = await f.runtime.createSessionOperation!(request, "create-a");
  assert.deepEqual(created, {
    kind: "confirmed",
    // The requested selection IS the launch selection; the record must say so.
    value: { backendSessionId: "native-a", launch: { model } },
    receipt: "native-a",
  });
  assert.equal(f.authority.receipts["create:create-a"], "native-a");
  assert.equal(f.inputs.length, 0);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]?.includes("--dangerously-skip-permissions"), false);
  assert.equal(f.launches[0]?.includes("--sandbox"), false);
});

test("create publishes the selection the CLI resolved when Polyth stated none", async (t) => {
  const f = fixture(t, { withoutContextModel: true });
  const created = await f.runtime.createSessionOperation!({
    sessionId: context.sessionId,
    projectId: context.projectId,
    cwd: context.cwd,
  }, "create-a");
  assert.deepEqual(created, {
    kind: "confirmed",
    // No --model was passed, so the CLI's own choice is what this leg is
    // locked to. Polyth must record that instead of guessing a model.
    value: { backendSessionId: "native-a", launch: { model: { providerID: "antigravity", modelID: model.modelID } } },
    receipt: "native-a",
  });
  assert.equal(f.launches[0]?.includes("--model"), false);
});

test("create defaults variant from catalog when model specifies none and allows compatible turns", async (t) => {
  const f = fixture(t, { withoutContextModel: true });
  const created = await f.runtime.createSessionOperation!({
    sessionId: context.sessionId,
    projectId: context.projectId,
    cwd: context.cwd,
    model: { providerID: "antigravity", modelID: "fixture-gemini" },
  }, "create-default-effort");
  assert.equal(created.kind, "confirmed");
  assert.deepEqual(created.value?.launch?.model, {
    providerID: "antigravity",
    modelID: "fixture-gemini",
    variant: "high",
  });
  assert.ok(f.launches[0]?.includes("--effort"));
  assert.equal(f.launches[0]?.[f.launches[0].indexOf("--effort") + 1], "high");

  // A prompt turn stating only the base model ID without variant is accepted on this leg
  const admission = f.start("turn-compatible", "Hello", {
    model: { providerID: "antigravity", modelID: "fixture-gemini" },
  });
  await flush();
  f.inputStep();
  assert.equal((await admission).kind, "confirmed");
  f.finish();
  await flush();

  // But a prompt turn requesting a contradictory effort is rejected
  const contradictory = await f.runtime.startTurnOperation!({
    sessionId: context.sessionId,
    text: "Hello",
    model: { providerID: "antigravity", modelID: "fixture-gemini", variant: "low" },
  }, "turn-contradictory");
  assert.equal(contradictory.kind, "rejected");
  assert.equal(contradictory.code, "unsupported");
});

test("native initialization must confirm approval-required mode without the launch bypass", async (t) => {
  const f = fixture(t, { permissionMode: "always-proceed" });
  const created = await f.runtime.createSessionOperation!(request, "create-a");
  assert.equal(created.kind, "unknown");
  await flush();
  assert.equal(f.releases, 1);
});

test("native initialization must confirm the bypass mode when the launch bypass is set", async (t) => {
  const f = fixture(t, { bypass: true, permissionMode: "request-review" });
  const created = await f.runtime.createSessionOperation!(request, "create-a");
  assert.equal(created.kind, "unknown");
  await flush();
  assert.equal(f.releases, 1);
});

test("the launch bypass never answers a tool: gated tools still wait for Polyth's policy", async (t) => {
  const f = fixture(t, { bypass: true });
  assert.equal((await f.runtime.capabilities()).permissions, true,
    "gated tools raise canonical permission requests");
  assert.equal((await f.runtime.createSessionOperation!(request, "create-a")).kind, "confirmed");
  assert.equal(f.launches[0]?.includes("--dangerously-skip-permissions"), true);
  assert.equal(f.launches[0]?.includes("--sandbox"), false);
  assert.equal(f.controls[0]?.mode, "auto");
  const admission = f.start(); await flush(); f.inputStep(); await admission;
  assert.equal(f.controls.at(-1)?.mode, "auto");

  // A gated tool is neither allowed nor denied until Polyth replies; Polyth's
  // decision (Auto-Approve, its high-risk hold, or a person) becomes the hook's.
  let settled = false;
  const allowed = f.hook("run_command", { CommandLine: "npm test" }, 2).then((decision) => { settled = true; return decision; });
  const denied = f.hook("run_command", { CommandLine: "rm -rf ~" }, 3);
  await flush();
  assert.equal(settled, false, "the bypass must not short-circuit the bridge");
  const requests = f.events.filter((event): event is Extract<RuntimeEvent, { type: "permission/requested" }> =>
    event.type === "permission/requested");
  assert.deepEqual(requests.map((event) => event.patterns), [["npm test"], ["rm -rf ~"]]);
  assert.equal((await f.runtime.replyPermissionOperation!(context.sessionId, requests[0]!.requestId, "once", "permission-a")).kind, "confirmed");
  assert.equal((await f.runtime.replyPermissionOperation!(context.sessionId, requests[1]!.requestId, "reject", "permission-b")).kind, "confirmed");
  assert.deepEqual(await allowed, { decision: "allow" });
  assert.equal((await denied).decision, "deny");

  // Native delegation is still denied before any approval is considered.
  assert.deepEqual(await f.hook("invoke_subagent", { Subagents: [{ TypeName: "self" }] }), {
    decision: "deny",
    reason: NATIVE_DELEGATION_DENY_REASON,
  });
});

test("a turn that raced the disposable probe leg is admitted by its same-conversation replacement", async (t) => {
  // Regression: createSession accepts the probe init, so the runtime still
  // believes the native leg is live and does not expect a replacement. If the
  // worker's probe leg is already gone when the first turn arrives, the worker
  // relaunches the pinned conversation. Rejecting that reinit stranded the
  // session's first turn as outcome-unknown.
  const f = fixture(t, { bypass: true });
  assert.equal((await f.runtime.createSessionOperation!(request, "create-a")).kind, "confirmed");
  const admission = f.start();
  await flush();
  assert.equal(f.authority.receipts["sent:turn-a"], "native-a");
  f.send({
    event: "polyth_reinit",
    polyth_reinit: {
      event: "init",
      conversation_id: "native-a",
      init: { cwd: context.cwd, model: model.modelID, permission_mode: "always-proceed" },
    },
  });
  await flush();
  f.inputStep();
  assert.equal((await admission).kind, "confirmed");
  assert.equal(f.events.some((event) => event.type === "turn/started"), true);
  f.finish();
  await flush();
});

test("an unrequested replacement cannot widen the launch permission mode", async (t) => {
  const f = fixture(t, { bypass: false });
  assert.equal((await f.runtime.createSessionOperation!(request, "create-a")).kind, "confirmed");
  const admission = f.start();
  await flush();
  f.send({
    event: "polyth_reinit",
    polyth_reinit: {
      event: "init",
      conversation_id: "native-a",
      init: { cwd: context.cwd, model: model.modelID, permission_mode: "always-proceed" },
    },
  });
  await flush();
  assert.equal((await admission).kind, "unknown");
});

test("a replacement that pins a different conversation is still rejected", async (t) => {
  const f = fixture(t, { bypass: true });
  assert.equal((await f.runtime.createSessionOperation!(request, "create-a")).kind, "confirmed");
  const admission = f.start();
  await flush();
  f.send({
    event: "polyth_reinit",
    polyth_reinit: {
      event: "init",
      conversation_id: "native-b",
      init: { cwd: context.cwd, model: model.modelID, permission_mode: "always-proceed" },
    },
  });
  await flush();
  assert.equal((await admission).kind, "unknown");
});

test("every native spawn surface the CLI advertises is denied, not only invoke_subagent", async (t) => {
  // The harness advertises `subagents: false`, so any native surface that can
  // create or drive a non-canonical worker must be denied before any approval.
  // The names below are the agent containers CLI 1.2.11 listed in its own `init`
  // frame; the last two cover a future verb under the same naming.
  assert.equal(isNativeDelegationTool(" MANAGE_TASK "), true, "native names are compared case-insensitively");
  for (const tool of ["invoke_subagent", "define_subagent", "manage_subagents", "manage_task", "browser_subagent", "spawn_agent", "start_subagents"]) {
    const f = fixture(t, { bypass: true });
    try {
      await f.runtime.createSessionOperation!(request, "create-a");
      const admission = f.start(); await flush(); f.inputStep(); await admission;
      assert.equal(isNativeDelegationTool(tool), true, `${tool} must be recognized as native delegation`);
      assert.deepEqual(await f.hook(tool, { TargetName: "worker" }), {
        decision: "deny",
        reason: NATIVE_DELEGATION_DENY_REASON,
      }, `${tool} must be denied`);
    } finally { await f.runtime.dispose?.(); }
  }
});

test("the delegation deny does not swallow ordinary tools that merely mention agents", async (t) => {
  for (const tool of ["ask_question", "manage_inbox", "read_resource", "run_command", "agent_ask", "taskboard"]) {
    assert.equal(isNativeDelegationTool(tool), false, `${tool} must not be treated as native delegation`);
  }
  const f = fixture(t, { bypass: true });
  await f.runtime.createSessionOperation!(request, "create-a");
  const admission = f.start(); await flush(); f.inputStep(); await admission;
  // An ordinary tool is not denied as delegation; it goes to Polyth's policy.
  const decision = f.hook("manage_inbox", {});
  await flush();
  const requested = f.events.find((event): event is Extract<RuntimeEvent, { type: "permission/requested" }> =>
    event.type === "permission/requested" && event.permission === "manage_inbox");
  assert.ok(requested);
  assert.equal((await f.runtime.replyPermissionOperation!(context.sessionId, requested.requestId, "once", "permission-a")).kind, "confirmed");
  assert.deepEqual(await decision, { decision: "allow" });
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

test("harness system prompt is admitted on every turn and live revisions replace prior text", async (t) => {
  const capabilityIds = ["polyth.behavior", "harness-runtime.system-prompt.antigravity"];
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  const releaseReceipts = setCapabilityReceiptSink((receipt) => receipts.push(receipt));
  t.after(() => {
    releaseReceipts();
    antigravityOverlays.release(context);
  });
  antigravityOverlays.set(context, {
    prompt: {
      text: "Global behavior.\n\nAntigravity-only R1.",
      capabilityIds,
    },
    launchCapabilityIds: [],
  }, "antigravity", {
    desiredRevision: "agy-prompt-r1",
    capabilityIds,
  });

  const f = fixture(t);
  assert.equal((await f.runtime.createSessionOperation!(request, "create-a")).kind, "confirmed");
  assert.equal(receipts.length, 0, "prompt must not be acknowledged before a native turn admits it");

  const first = f.start("turn-a", "Hello");
  await flush();
  assert.deepEqual(f.inputs[0], {
    event: "user",
    message: { content: "Hello\n\nGlobal behavior.\n\nAntigravity-only R1." },
  });
  f.inputStep();
  assert.equal((await first).kind, "confirmed");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.desiredRevision, "agy-prompt-r1");
  assert.deepEqual(receipts[0]?.capabilityIds, capabilityIds);
  assert.equal(receipts[0]?.outcome, "unverifiable");
  assert.equal(receipts[0]?.evidence?.stage, "staged");
  f.finish();
  await flush();

  antigravityOverlays.set(context, {
    prompt: {
      text: "Global behavior.\n\nAntigravity-only R2.",
      capabilityIds,
    },
    launchCapabilityIds: [],
  }, "antigravity", {
    desiredRevision: "agy-prompt-r2",
    capabilityIds,
  });

  const second = f.start("turn-b", "Next");
  await flush();
  assert.deepEqual(f.inputs[1], {
    event: "user",
    message: { content: "Next\n\nGlobal behavior.\n\nAntigravity-only R2." },
  });
  assert.doesNotMatch(String((f.inputs[1]?.message as { content?: string } | undefined)?.content), /R1/);
  f.inputStep(3);
  assert.equal((await second).kind, "confirmed");
  assert.equal(receipts[1]?.desiredRevision, "agy-prompt-r2");
  f.finish(2);
  await flush();
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
  // Scalar metadata becomes preview rows, which a bash card shows as commands.
  assert.equal("metadata" in event, false);
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

test("changing the launch bypass replaces the idle native leg with the exact launch flag", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  f.bypass = true;
  const first = f.start(); await flush(); f.inputStep(); await first;
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1]?.includes("--dangerously-skip-permissions"), true);
  // Under the bypass a gated tool is still a canonical request, not an allow.
  const decision = f.hook("run_command", { CommandLine: "npm test" });
  await flush();
  const requested = f.events.find((event): event is Extract<RuntimeEvent, { type: "permission/requested" }> =>
    event.type === "permission/requested");
  assert.ok(requested);
  assert.equal((await f.runtime.replyPermissionOperation!(context.sessionId, requested.requestId, "once", "permission-a")).kind, "confirmed");
  assert.deepEqual(await decision, { decision: "allow" });
  f.finish(); await flush();

  f.bypass = false;
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
  assert.match(stop?.error ?? "", /auto-denied a tool because its headless mode cannot prompt for approval/);
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

test("a stopped turn keeps the owned runtime usable and relaunches the recorded conversation", async (t) => {
  const f = fixture(t, { bypass: true });
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  assert.equal((await f.runtime.abortOperation!(context.sessionId, "abort-a")).kind, "confirmed");
  assert.equal(f.controls.some((control) => control.event === "polyth_stop"), true);
  assert.equal(f.events.some((event) => event.type === "turn/stopped" && event.reason === "aborted"), true);
  // Stopping a turn must not destroy the owned process tree: nothing rebuilds
  // it, so the session would 503 on every later prompt.
  assert.equal(f.releases, 0);

  const resumed = f.start("turn-b", "Continue"); await flush(); f.inputStep(0); await resumed;
  assert.equal((await resumed).kind, "confirmed");
  assert.equal(f.launches.length, 2);
  assert.equal(f.launches[1]?.[f.launches[1]!.indexOf("--conversation") + 1], "native-a");
  assert.deepEqual(f.inputs.at(-1), { event: "user", message: { content: "Continue" } });
  f.finish(1); await flush();
  assert.equal(f.events.filter((event) => event.type === "turn/stopped" && event.reason === "completed").length, 1);
});

test("abort is confirmed only after process-tree release; lack of proof stays unknown", async (t) => {
  const f = fixture(t, { stopProof: false, timeoutMs: 50 });
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  f.releaseFailure = true;
  assert.equal((await f.runtime.abortOperation!(context.sessionId, "abort-a")).kind, "unknown");
  assert.equal(f.events.some((event) => event.type === "turn/stopped" && event.reason === "aborted"), false);
  f.releaseFailure = false;
  assert.equal((await f.runtime.abortOperation!(context.sessionId, "abort-a")).kind, "confirmed");
  assert.equal(f.events.some((event) => event.type === "turn/stopped" && event.reason === "aborted"), true);
});

test("refused controls and attachments fail before input; no silent model change", async (t) => {
  const cwd = workspace(t);
  const outside = workspace(t);
  await writeFile(join(outside, "secret.png"), "not yours");
  await mkdir(join(cwd, "_inbox"));
  await symlink(join(outside, "secret.png"), join(cwd, "_inbox", "linked.png"));
  await writeFile(join(cwd, "notes.txt"), "text");
  const f = fixture(t, { cwd });
  await f.runtime.createSessionOperation!(withCwd(cwd), "create-a");
  for (const [extra, code] of [
    [{ model: { ...model, variant: "low" } }, "unsupported"],
    // A traversal or a workspace symlink cannot smuggle an outside file in.
    [{ attachments: [{ id: "a", name: "secret.png", mime: "image/png", size: 1, path: "../" + outside.split("/").pop() + "/secret.png" }] }, "invalid-attachment"],
    [{ attachments: [{ id: "a", name: "linked.png", mime: "image/png", size: 1, path: "_inbox/linked.png" }] }, "invalid-attachment"],
    [{ attachments: [{ id: "a", name: "gone.png", mime: "image/png", size: 1, path: "_inbox/gone.png" }] }, "invalid-attachment"],
    // Text files arrive as Polyth's server-side projection, never as refs.
    [{ attachments: [{ id: "a", name: "notes.txt", mime: "text/plain", size: 4, path: "notes.txt" }] }, "unsupported"],
    [{ attachments: [{ id: "a", name: "link", mime: "text/uri-list", size: 1, kind: "url", url: "file:///etc/passwd" }] }, "invalid-attachment"],
    [{ command: { id: "native:antigravity:automation", owner: "native", name: "automation" },
      attachments: [{ id: "a", name: "link", mime: "text/uri-list", size: 1, kind: "url", url: "https://example.com" }] }, "unsupported"],
  ] as const) {
    const outcome = await f.runtime.startTurnOperation!({ sessionId: context.sessionId, text: "Hello", ...extra } as Parameters<NonNullable<typeof f.runtime.startTurnOperation>>[0], "rejected");
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") assert.equal(outcome.code, code);
  }
  assert.equal(f.inputs.length, 0);
  assert.equal(f.authority.receipts["sent:rejected"], undefined);
  await assert.rejects(f.runtime.replyPermission(context.sessionId, "p", "once"), { code: "not-found" });
});

test("images, PDFs, audio and links are staged privately and opened before the first model call", async (t) => {
  const cwd = workspace(t);
  await mkdir(join(cwd, "_inbox"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await Promise.all([
    writeFile(join(cwd, "_inbox", "photo shot.PNG"), png),
    writeFile(join(cwd, "_inbox", "spec.pdf"), "%PDF-1.7"),
    writeFile(join(cwd, "_inbox", "voice.wav"), "RIFF"),
  ]);
  const f = fixture(t, { cwd });
  await f.runtime.createSessionOperation!(withCwd(cwd), "create-a");
  const pending = f.start("turn-a", "What is on these?", { attachments: [
    { id: "i", name: "photo shot.PNG", mime: "image/png", size: png.length, path: "_inbox/photo shot.PNG" },
    { id: "p", name: "spec.pdf", mime: "application/pdf", size: 8, path: "_inbox/spec.pdf" },
    { id: "v", name: "voice.wav", mime: "audio/wav", size: 4, path: "_inbox/voice.wav" },
    { id: "u", name: "Docs", mime: "text/uri-list", size: 1, kind: "url", url: "https://example.com/docs" },
  ] });
  await until(() => f.inputs.length === 1);
  const content = String((f.inputs[0]?.message as { content?: string }).content);
  assert.match(content, /^What is on these\?\n\nAttachments from the user \(delivered by Polyth\):/);
  const staged = [...content.matchAll(/: (\/\S+\.(?:png|pdf|wav))$/gm)].map((match) => match[1]!);
  assert.equal(staged.length, 3);
  for (const path of staged) {
    assert.ok(path.startsWith(join(f.hookRoot, "attachments")), "staged copies live in the private --add-dir root");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readFile(staged[0]!), png);
  assert.match(staged[0]!, /\/1-photo-shot\.png$/);
  assert.match(content, /4\. link https:\/\/example\.com\/docs/);

  f.inputStep();
  assert.equal((await pending).kind, "confirmed");
  // Staged paths are listed in the prompt manifest and auto-approved;
  // PreInvocation does not inject tool calls which are rejected by the CLI.
  assert.deepEqual(await f.invocation(), {});
  assert.deepEqual(await f.invocation(), {});
  assert.deepEqual(await f.invocation("foreign-conversation"), {});
  // In review mode an injected open needs no second approval; anything else
  // outside the workspace still asks.
  assert.deepEqual(await f.hook("view_file", { AbsolutePath: staged[0] }), { decision: "allow" });
  assert.deepEqual(await f.hook("read_url_content", { Url: "https://example.com/docs" }), { decision: "allow" });
  const outside = f.hook("view_file", { AbsolutePath: "/etc/hosts" });
  await until(() => f.events.some((event) => event.type === "permission/requested"));
  f.finish(); await flush();
  assert.deepEqual(await outside, { decision: "deny", reason: "Antigravity ended the turn before approval completed" });
});

test("a browser capture is staged as an image next to the merged page context", async (t) => {
  const cwd = workspace(t);
  const capture = join(workspace(t), "capture.png");
  await writeFile(capture, "png");
  const f = fixture(t, { cwd });
  await f.runtime.createSessionOperation!(withCwd(cwd), "create-a");
  const pending = f.start("turn-a", "Fix this", { attachments: [{
    id: "b", name: "page", mime: "application/json", size: 1, kind: "browser-context",
    browserContext: {
      id: "ctx", type: "page", browserSessionId: "browser-a", projectId: context.projectId, frameRevision: 1,
      url: "https://app.test/", title: "App", viewport: { width: 800, height: 600 }, capturedAt: "2026-09-23T00:00:00Z",
      screenshot: { id: "s", mime: "image/png", size: 3, localPath: capture },
    },
  }] });
  await until(() => f.inputs.length === 1);
  const content = String((f.inputs[0]?.message as { content?: string }).content);
  assert.match(content, /https:\/\/app\.test\//);
  assert.match(content, /1\. image "browser capture" \(image\/png, 3 B\): \//);
  f.inputStep(); await pending;
  const steps = (await f.invocation()).injectSteps ?? [];
  assert.equal(steps.length, 0);
  f.finish(); await flush();
});

test("steering is injected before the next model call, and a late steer re-enters the loop once", async (t) => {
  const f = fixture(t);
  await f.runtime.createSessionOperation!(request, "create-a");
  assert.equal((await f.runtime.steerOperation!(context.sessionId, "too early", "steer-0")).kind, "rejected", "no running turn");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  // Until a PreInvocation proves the seam is live, Polyth queues instead.
  assert.equal((await f.runtime.steerOperation!(context.sessionId, "not yet", "steer-1")).kind, "rejected");
  assert.deepEqual(await f.invocation(), {});
  assert.equal((await f.runtime.steerOperation!(context.sessionId, "Use tabs", "steer-2", { ...model, variant: "low" })).kind, "rejected");
  assert.deepEqual(await f.runtime.steerOperation!(context.sessionId, " Use tabs ", "steer-2"), { kind: "confirmed", value: {} });
  assert.equal(f.authority.receipts["steer:steer-2"], "native-a");
  assert.deepEqual(await f.runtime.steerOperation!(context.sessionId, "Use tabs", "steer-2"), { kind: "confirmed", value: {} }, "idempotent receipt");
  assert.deepEqual(await f.invocation(), { injectSteps: [{ userMessage: "Use tabs" }] });
  assert.deepEqual(await f.invocation(), {});

  // Steering that arrives while the model finishes keeps the loop alive once.
  assert.equal((await f.runtime.steerOperation!(context.sessionId, "Also add tests", "steer-3")).kind, "confirmed");
  assert.deepEqual(await f.stopHook(), {
    decision: "continue",
    reason: "The user sent another message while you were finishing. It follows; address it before you end the turn.",
  });
  assert.deepEqual(await f.stopHook(), {}, "one re-entry per pending batch");
  assert.deepEqual(await f.invocation(), { injectSteps: [{ userMessage: "Also add tests" }] });
  assert.deepEqual(await f.stopHook(), {});
  // Injected user messages may advance the native turn counter.
  f.finish(3); await flush();
  assert.deepEqual(f.events.filter((event) => event.type === "turn/stopped").map((event) => event.reason), ["completed"]);
  assert.equal(f.releases, 0);
  const snapshot = await f.runtime.reconcile!({ ...(await f.runtime.endpoint!()), canonicalSessionId: context.sessionId, backendSessionId: "native-a" });
  assert.deepEqual(snapshot.acceptedOperations?.filter((item) => item.mutationKind === "turn-steer").map((item) => item.operationId), ["steer-2", "steer-3"]);
});

test("steering the CLI never received is carried into the next prompt, but a user stop discards it", async (t) => {
  const f = fixture(t, { bypass: true });
  await f.runtime.createSessionOperation!(request, "create-a");
  const first = f.start(); await flush(); f.inputStep(); await first;
  await f.invocation();
  assert.equal((await f.runtime.steerOperation!(context.sessionId, "Remember the changelog", "steer-a")).kind, "confirmed");
  // An error ends the loop for good; it is not re-entered.
  assert.deepEqual(await f.stopHook("error"), {});
  f.send({ event: "result", result: { conversation_id: "native-a", status: "ERROR", error: "model failed", num_turns: 1 } });
  await flush();
  const second = f.start("turn-b", "Next"); await flush();
  assert.deepEqual(f.inputs.at(-1), { event: "user", message: {
    content: "Messages the user sent while you were finishing the previous turn:\n- Remember the changelog\n\nNext",
  } });
  f.inputStep(3); await second;
  await f.invocation();
  assert.equal((await f.runtime.steerOperation!(context.sessionId, "Stop-bound steer", "steer-b")).kind, "confirmed");
  assert.equal((await f.runtime.abortOperation!(context.sessionId, "abort-b")).kind, "confirmed");
  const third = f.start("turn-c", "After stop"); await flush();
  assert.deepEqual(f.inputs.at(-1), { event: "user", message: { content: "After stop" } });
  f.inputStep(0); await third;
  f.finish(1); await flush();
});

test("a native question is asked through Polyth and the answer returns to the model", async (t) => {
  const f = fixture(t, { bypass: true });
  await f.runtime.createSessionOperation!(request, "create-a");
  const pending = f.start(); await flush(); f.inputStep(); await pending;
  const args = { questions: [
    { question: "Which database?", options: [{ id: "pg", text: "PostgreSQL" }, { id: "my", text: "MySQL" }] },
    { question: "Anything else?", options: [] },
  ] };
  // The launch bypass does not skip the question: headless mode would cancel it.
  const decision = f.hook("ask_question", args, 4);
  await flush();
  const asked = f.events.find((event) => event.type === "question/asked");
  assert.equal(asked?.type, "question/asked");
  if (asked?.type !== "question/asked") throw new Error("question event missing");
  assert.deepEqual(asked.questions, [
    { id: "q1", prompt: "Which database?", type: "single", options: [{ value: "pg", label: "PostgreSQL" }, { value: "my", label: "MySQL" }], allowOther: true, required: true },
    { id: "q2", prompt: "Anything else?", type: "text", required: true },
  ]);
  const snapshot = await f.runtime.reconcile!({ ...(await f.runtime.endpoint!()), canonicalSessionId: context.sessionId, backendSessionId: "native-a" });
  assert.deepEqual(snapshot.questions.map((item) => item.requestId), [asked.requestId]);
  assert.deepEqual(await f.runtime.replyQuestionOperation!(context.sessionId, asked.requestId, { answers: [["pg"], ["Use UTC"]] }, "reply-a"), { kind: "confirmed", value: {} });
  const answered = await decision;
  assert.equal(answered.decision, "deny");
  assert.match(answered.reason ?? "", /^Answered by the user in Polyth/);
  assert.match(answered.reason ?? "", /1\. Which database\?\n {3}Answer: PostgreSQL/);
  assert.match(answered.reason ?? "", /2\. Anything else\?\n {3}Answer: Use UTC/);
  assert.equal((await f.runtime.replyQuestionOperation!(context.sessionId, asked.requestId, { answers: [] }, "reply-b")).kind, "rejected");

  const dismissed = f.hook("ask_question", { questions: [{ question: "Proceed?" }] }, 5);
  await flush();
  const second = f.events.findLast((event) => event.type === "question/asked");
  if (second?.type !== "question/asked") throw new Error("second question missing");
  await f.runtime.replyQuestion(context.sessionId, second.requestId, { action: "reject" });
  assert.match((await dismissed).reason ?? "", /^Dismissed by the user in Polyth/);
  assert.deepEqual(await f.hook("ask_question", { nonsense: true }, 6), {
    decision: "deny", reason: "Polyth could not display this question; ask the user in plain text instead",
  });
  // A question still open when the turn ends is released, never left hanging.
  const orphan = f.hook("ask_question", { questions: [{ question: "Last one?" }] }, 7);
  await flush();
  f.finish(); await flush();
  assert.equal((await orphan).decision, "deny");
});

test("native skills are discovered once and a command is sent as the whole message", async (t) => {
  let calls = 0;
  const catalog: RuntimeCommandDescriptor[] = [{
    id: "native:antigravity:automation", name: "automation", owner: "native", harnessId: "antigravity",
    acceptsArguments: true, availability: "session", invocation: "raw-native-input",
  }];
  const f = fixture(t, { commands: async () => { calls++; return catalog; } });
  t.after(() => antigravityOverlays.release(context));
  antigravityOverlays.set(context, { prompt: { text: "Polyth behavior.", capabilityIds: ["polyth.behavior"] }, launchCapabilityIds: [] },
    "antigravity", { desiredRevision: "r1", capabilityIds: ["polyth.behavior"] });
  await f.runtime.createSessionOperation!(request, "create-a");
  await flush();
  assert.deepEqual(f.events.filter((event) => event.type === "runtime/commands-changed"), [{ type: "runtime/commands-changed", commands: catalog }]);
  assert.deepEqual(await f.runtime.commands!(context.sessionId), catalog);
  assert.equal(calls, 1);
  const pending = f.start("turn-a", "/automation every monday", { command: { id: "native:antigravity:automation", owner: "native", name: "automation", args: "every monday" } });
  await flush();
  // Only a leading slash command expands; Polyth appends nothing to it.
  assert.deepEqual(f.inputs[0], { event: "user", message: { content: "/automation every monday" } });
  f.inputStep(); assert.equal((await pending).kind, "confirmed");
  f.finish(); await flush();
  assert.equal(calls, 1, "a fresh catalog is not re-read after every turn");
});

test("a failed skills report backs off instead of respawning on every features request", async (t) => {
  let calls = 0;
  const f = fixture(t, { commands: async () => { calls++; throw new Error("not signed in"); } });
  await f.runtime.createSessionOperation!(request, "create-a");
  await flush();
  for (let index = 0; index < 5; index++) assert.deepEqual(await f.runtime.commands!(context.sessionId), []);
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.events.some((event) => event.type === "runtime/commands-changed"), false);
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
