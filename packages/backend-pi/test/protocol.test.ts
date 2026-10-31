import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import { effectiveAttachmentSupport } from "@polyth/contracts";
import { planAttachmentDelivery, projectAttachmentText } from "@polyth/harness-runtime";
import { createPiRuntime, PI_CAPABILITIES } from "../src/runtime.ts";
import type { PiRpc, PiRpcEvent, PiRpcState } from "../src/rpc.ts";

const fakePi = (initial: Partial<PiRpcState> = {}) => {
  const receipts: Record<string, string> = {};
  const eventListeners = new Set<(event: PiRpcEvent) => void>();
  const closeListeners = new Set<() => void>();
  const calls: Array<Record<string, unknown>> = [];
  let commands = [{ name: "review", description: "Review changes" }];
  let state: PiRpcState = {
    sessionFile: "/tmp/pi-initial.jsonl",
    sessionId: "initial",
    isStreaming: false,
    ...initial,
  };

  const rpc: PiRpc = {
    authorityId: "pi-authority",
    generation: 3,
    receipts,
    releasedAuthorities: [],
    async request<T>(command: Record<string, unknown> & { type: string }): Promise<T> {
      calls.push(command);
      switch (command.type) {
        case "new_session":
          state = { ...state, sessionFile: "/tmp/pi-created.jsonl", sessionId: "created", sessionName: undefined };
          return { cancelled: false } as T;
        case "set_session_name":
          state = { ...state, sessionName: String(command.name ?? "") };
          return undefined as T;
        case "get_state":
          return { ...state } as T;
        case "switch_session":
          state = { ...state, sessionFile: String(command.sessionPath), sessionId: "switched" };
          return { cancelled: false } as T;
        case "get_available_models":
          return {
            models: [
              { provider: "anthropic", id: "claude-test", name: "Claude Test", contextWindow: 200_000, reasoning: true },
              { provider: "openai", id: "gpt-test", name: "GPT Test", contextWindow: 128_000, reasoning: true },
            ],
          } as T;
        case "get_available_thinking_levels":
          return { levels: ["off", "medium", "high"] } as T;
        case "get_commands":
          return { commands } as T;
        case "set_model":
          state = {
            ...state,
            model: { provider: String(command.provider ?? ""), id: String(command.modelId ?? "") },
          };
          return undefined as T;
        case "set_thinking_level":
        case "prompt":
        case "clear_queue":
        case "abort":
          return undefined as T;
        case "get_session_stats":
          return { contextUsage: { tokens: 1_000, contextWindow: 200_000, percent: 0.5 } } as T;
        default:
          throw Object.assign(new Error(`unexpected command ${command.type}`), { code: "runtime-rejected" });
      }
    },
    async receipt(operationId, nativeId) { receipts[operationId] = nativeId; },
    onEvent(callback) { eventListeners.add(callback); return { dispose: () => eventListeners.delete(callback) }; },
    onClose(callback) { closeListeners.add(callback); return { dispose: () => closeListeners.delete(callback) }; },
    async close() { for (const callback of closeListeners) callback(); },
  };

  return {
    rpc,
    calls,
    state: () => state,
    setCommands(next: typeof commands) { commands = next; },
    emit(event: PiRpcEvent) { for (const callback of eventListeners) callback(event); },
  };
};

const context = {
  spaceId: "space",
  projectId: "project",
  sessionId: "canonical",
  cwd: "/tmp",
} as const;

test("Pi creates a durable native session and resumes by exact sessionFile", async () => {
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);

  const created = await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Useful title", cwd: "/tmp" },
    "create-op",
  );
  assert.equal(created.kind, "confirmed");
  if (created.kind !== "confirmed") return;
  assert.equal(created.value.backendSessionId, "/tmp/pi-created.jsonl");
  assert.equal(created.receipt, "/tmp/pi-created.jsonl");
  assert.equal(fake.rpc.receipts["create-op"], "/tmp/pi-created.jsonl");
  assert.equal(fake.state().sessionName, "Useful title");

  const resumed = await runtime.ensureSession({
    projectId: "project",
    sessionId: "canonical",
    title: "Useful title",
    cwd: "/tmp",
    backendSessionId: "/tmp/pi-other.jsonl",
  });
  assert.equal(resumed, "/tmp/pi-other.jsonl");
  assert.ok(fake.calls.some((call) => call.type === "switch_session" && call.sessionPath === "/tmp/pi-other.jsonl"));

  await runtime.dispose();
});

test("Pi does not publish a Polyth prompt fallback as a native session name", async () => {
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);

  await runtime.createSessionOperation!({
    projectId: "project",
    sessionId: "canonical",
    title: "fix pi harness session titles are not being gen…",
    titleSource: "polyth",
    cwd: "/tmp",
  }, "create-op");

  assert.equal(fake.state().sessionName, undefined);
  assert.ok(!fake.calls.some((call) => call.type === "set_session_name"));
  assert.equal((await runtime.sessions())[0]?.title, "");
  await runtime.dispose();
});

test("Pi does not re-publish a fallback name already stored in the native session", async () => {
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_, event) => events.push(event));
  const fallback = "fix pi harness session titles are not being gen…";

  await runtime.createSessionOperation!({
    projectId: "project",
    sessionId: "canonical",
    title: fallback,
    titleSource: "polyth",
    cwd: "/tmp",
  }, "create-op");
  // Simulate a native file polluted by an older runtime that wrote the
  // Polyth fallback with `set_session_name`.
  await fake.rpc.request({ type: "set_session_name", name: fallback });

  const resumed = await runtime.ensureSession({
    projectId: "project",
    sessionId: "canonical",
    title: fallback,
    titleSource: "polyth",
    cwd: "/tmp",
    backendSessionId: "/tmp/pi-created.jsonl",
  });
  assert.equal(resumed, "/tmp/pi-created.jsonl");
  assert.deepEqual(events.filter((event) => event.type === "session/title-generated"), []);
  assert.equal((await runtime.sessions())[0]?.title, "");
  await runtime.dispose();
});

test("Pi maps catalog, model selection, streaming text, tools and settled terminal evidence", async () => {
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_, event) => events.push(event));

  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
    "create-op",
  );

  const models = await runtime.models();
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    providerID: "anthropic",
    modelID: "claude-test",
    name: "Claude Test",
    connected: true,
    context: 200_000,
  });

  const commands = await runtime.commands!("canonical");
  assert.equal(commands[0]?.id, "native:pi:review");

  const admitted = await runtime.startTurnOperation!(
    {
      sessionId: "canonical",
      text: "hello",
      model: { providerID: "anthropic", modelID: "claude-test", variant: "high" },
    },
    "turn-op",
  );
  assert.equal(admitted.kind, "confirmed");
  assert.ok(fake.calls.some((call) => call.type === "set_model" && call.provider === "anthropic" && call.modelId === "claude-test"));
  assert.ok(fake.calls.some((call) => call.type === "set_thinking_level" && call.level === "high"));

  fake.emit({ type: "message_start", message: { role: "assistant", content: [] } });
  fake.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
  });
  fake.emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop" },
  });
  fake.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "pwd" } });
  fake.emit({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "/tmp" }] },
    isError: false,
  });
  fake.setCommands([{ name: "ship", description: "Ship changes" }]);
  fake.emit({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(events.some((event) => event.type === "turn/started" && event.turnId === "turn-op"));
  assert.deepEqual(events.find((event) => event.type === "turn/started")?.model, {
    providerID: "anthropic",
    modelID: "claude-test",
    variant: "high",
  });
  assert.ok(events.some((event) => event.type === "assistant/chunk" && event.text === "Hello"));
  assert.ok(events.some((event) => event.type === "assistant/message" && event.text === "Hello"));
  assert.ok(events.some((event) => event.type === "tool/started" && event.callId === "tool-1"));
  assert.ok(events.some((event) => event.type === "tool/result" && event.callId === "tool-1"));
  assert.ok(events.some((event) => event.type === "turn/stopped" && event.turnId === "turn-op" && event.reason === "completed"));
  assert.deepEqual(events.findLast((event) => event.type === "runtime/commands-changed"), {
    type: "runtime/commands-changed",
    commands: [{
      id: "native:pi:ship",
      name: "ship",
      description: "Ship changes",
      owner: "native",
      harnessId: "pi",
      invocation: "raw-native-input",
      availability: "session",
      acceptsArguments: true,
    }],
  });

  await runtime.dispose();
});

test("Pi records each final assistant message's usage and cost for the admitted turn", async () => {
  assert.equal(PI_CAPABILITIES.usage, true);
  assert.equal(PI_CAPABILITIES.cost, true);
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_, event) => events.push(event));
  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
    "create-op",
  );

  // Output from a leg looping outside an admitted turn is not canonical usage.
  fake.emit({
    type: "message_end",
    message: { role: "assistant", content: [], usage: { input: 9, output: 9, cost: { total: 9 } } },
  });

  await runtime.startTurnOperation!(
    { sessionId: "canonical", text: "hello", model: { providerID: "anthropic", modelID: "claude-test" } },
    "turn-op",
  );
  // Cumulative streaming usage must not be recorded; only final messages are.
  fake.emit({
    type: "message_update",
    usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101 },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
  });
  fake.emit({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      content: [{ type: "text", text: "Hi" }],
      stopReason: "toolUse",
      usage: {
        input: 100, output: 20, reasoning: 5, cacheRead: 40, cacheWrite: 10, totalTokens: 170,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
    },
  });
  // A provider without usage reporting yields no sample at all.
  fake.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "toolUse" } });
  fake.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
      usage: { input: 130, output: 7, totalTokens: 137 },
    },
  });
  fake.emit({ type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const usage = events.filter((event) => event.type === "usage/recorded");
  assert.deepEqual(usage, [
    {
      type: "usage/recorded",
      model: { providerID: "anthropic", modelID: "claude-test" },
      tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10 },
      cost: 0.003,
      costSource: "derived",
      harnessId: "pi",
      quality: "exact",
      turnId: "turn-op",
    },
    {
      type: "usage/recorded",
      model: { providerID: "anthropic", modelID: "unknown" },
      tokens: { input: 130, output: 7 },
      harnessId: "pi",
      quality: "exact",
      turnId: "turn-op",
    },
  ]);
  // Usage belongs to the turn that is closing, so it precedes its terminal marker.
  const stopped = events.findIndex((event) => event.type === "turn/stopped");
  assert.ok(events.findLastIndex((event) => event.type === "usage/recorded") < stopped);

  await runtime.dispose();
});

test("Pi streams thinking deltas and finalizes thinking blocks as reasoning", async () => {
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_, event) => events.push(event));

  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
    "create-op",
  );
  await runtime.startTurnOperation!(
    {
      sessionId: "canonical",
      text: "think through this",
      model: { providerID: "anthropic", modelID: "claude-test" },
    },
    "thinking-turn",
  );

  fake.emit({ type: "message_start", message: { role: "assistant", content: [] } });
  fake.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "First " },
  });
  fake.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "thought" },
  });
  fake.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking", contentIndex: 2, thinking: "Second thought" },
  });
  fake.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Answer" },
        { type: "thinking", thinking: "First thought" },
        { type: "thinking", text: "Second thought" },
      ],
      stopReason: "stop",
    },
  });

  assert.deepEqual(events.filter((event) => event.type === "assistant/reasoning-chunk"), [
    { type: "assistant/reasoning-chunk", partId: "thinking-turn:0:1", text: "First " },
    { type: "assistant/reasoning-chunk", partId: "thinking-turn:0:1", text: "thought" },
    { type: "assistant/reasoning-chunk", partId: "thinking-turn:0:2", text: "Second thought" },
  ]);
  assert.deepEqual(events.filter((event) => event.type === "assistant/message" && event.reasoning !== undefined), [
    { type: "assistant/message", partId: "thinking-turn:0:1", text: "", reasoning: "First thought" },
    { type: "assistant/message", partId: "thinking-turn:0:2", text: "", reasoning: "Second thought" },
  ]);
  assert.ok(events.some((event) => event.type === "assistant/message" && event.text === "Answer"));

  await runtime.dispose();
});

test("Pi finalizes streamed thinking when message_end has no thinking block", async () => {
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_, event) => events.push(event));

  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
    "create-op",
  );
  await runtime.startTurnOperation!(
    {
      sessionId: "canonical",
      text: "think through this",
      model: { providerID: "anthropic", modelID: "claude-test" },
    },
    "streamed-thinking-turn",
  );

  fake.emit({ type: "message_start", message: { role: "assistant", content: [] } });
  fake.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 3, delta: "Streamed only" },
  });
  fake.emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop" },
  });

  assert.deepEqual(events.filter((event) => event.type === "assistant/message" && event.reasoning !== undefined), [
    { type: "assistant/message", partId: "streamed-thinking-turn:0:3", text: "", reasoning: "Streamed only" },
  ]);

  await runtime.dispose();
});

test("Pi resets thinking level to off when a turn switches to Auto", async () => {
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);

  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
    "create-op",
  );

  const high = await runtime.startTurnOperation!(
    {
      sessionId: "canonical",
      text: "use extended reasoning",
      model: { providerID: "anthropic", modelID: "claude-test", variant: "high" },
    },
    "high-turn",
  );
  assert.equal(high.kind, "confirmed");
  fake.emit({ type: "agent_settled" });

  const automatic = await runtime.startTurnOperation!(
    {
      sessionId: "canonical",
      text: "use automatic reasoning",
      model: { providerID: "anthropic", modelID: "claude-test" },
    },
    "auto-turn",
  );
  assert.equal(automatic.kind, "confirmed");
  assert.deepEqual(
    fake.calls.filter((call) => call.type === "set_thinking_level"),
    [
      { type: "set_thinking_level", level: "high" },
      { type: "set_thinking_level", level: "off" },
    ],
  );

  await runtime.dispose();
});

test("Pi publishes the native model on turn/started when the turn inherits it", async () => {
  const fake = fakePi({ model: { provider: "anthropic", id: "claude-test", name: "Claude Test" } });
  const runtime = createPiRuntime(context, fake.rpc);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_, event) => events.push(event));

  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
    "create-op",
  );

  const admitted = await runtime.startTurnOperation!(
    { sessionId: "canonical", text: "inherit the native model" },
    "native-turn",
  );
  assert.equal(admitted.kind, "confirmed");
  assert.ok(!fake.calls.some((call) => call.type === "set_model"));
  assert.deepEqual(events.find((event) => event.type === "turn/started")?.model, {
    providerID: "anthropic",
    modelID: "claude-test",
  });

  await runtime.dispose();
});

test("Pi classifies confirmed provider capacity payloads as retryable stops", async () => {
  for (const { error, code, scope } of [
    {
      error: '429: {"message":"Upstream model provider is temporarily unavailable. Please try again in a moment.","type":"rate_limit_error"}',
      code: "rate-limited",
      scope: "rate",
    },
    { error: '{"message":"request rate_limit_error","type":"rate_limit_error"}', code: "rate-limited", scope: "rate" },
    { error: "provider response: too many requests", code: "rate-limited", scope: "rate" },
    {
      error: "upstream_error: TPM (Tokens Per Minute) limit of the model deepseek-v4-1-flash is exceeded. Please try again later Request id: 021792132004199265c448ee6909a398288d07ae906a66ba4d6b9",
      code: "rate-limited",
      scope: "rate",
    },
    { error: "Requests per minute limit reached for this model", code: "rate-limited", scope: "rate" },
    { error: "RESOURCE_EXHAUSTED: request throttled", code: "rate-limited", scope: "rate" },
    // A bare quota in a rolling window (per day, per minute) still waits it out.
    { error: "429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_requests_per_day", code: "rate-limited", scope: "rate" },
    { error: "provider response: overloaded", code: "overloaded", scope: "overloaded" },
    { error: "HTTP 503 Service Unavailable", code: "overloaded", scope: "overloaded" },
  ] as const) {
    const fake = fakePi();
    const runtime = createPiRuntime(context, fake.rpc);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_, event) => events.push(event));

    await runtime.createSessionOperation!(
      { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
      "create-op",
    );
    const admitted = await runtime.startTurnOperation!(
      {
        sessionId: "canonical",
        text: "retry me",
        model: { providerID: "commandcode", modelID: "deepseek/deepseek-v4.1-flash" },
      },
      "turn-op",
    );
    assert.equal(admitted.kind, "confirmed");

    fake.emit({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: error },
    });
    fake.emit({ type: "agent_settled" });

    assert.deepEqual(events.findLast((event) => event.type === "turn/stopped"), {
      type: "turn/stopped",
      turnId: "turn-op",
      reason: "error",
      error,
      code,
      retry: { scope, provider: "commandcode", retryable: true },
    });
    await runtime.dispose();
  }
});

test("Pi classifies 402 and quota/funds exhaustion as quota-exhausted non-retryable stops", async () => {
  for (const error of [
    '402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}',
    "provider response: insufficient quota",
    "402 Payment Required",
    // Billing refusals sent as a 429 or beside rate wording never roll over.
    '429 You exceeded your current quota, please check your plan and billing details. {"type":"insufficient_quota","code":"insufficient_quota"}',
    "rate_limit_error: Your credit balance is too low to access the API",
  ]) {
    const fake = fakePi();
    const runtime = createPiRuntime(context, fake.rpc);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_, event) => events.push(event));

    await runtime.createSessionOperation!(
      { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
      "create-op",
    );
    const admitted = await runtime.startTurnOperation!(
      {
        sessionId: "canonical",
        text: "out of funds",
        model: { providerID: "commandcode", modelID: "deepseek/deepseek-v4.1-flash" },
      },
      "turn-op",
    );
    assert.equal(admitted.kind, "confirmed");

    fake.emit({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: error },
    });
    fake.emit({ type: "agent_settled" });

    assert.deepEqual(events.findLast((event) => event.type === "turn/stopped"), {
      type: "turn/stopped",
      turnId: "turn-op",
      reason: "error",
      error,
      code: "quota-exhausted",
      retry: { scope: "quota", provider: "commandcode", retryable: false },
    });
    await runtime.dispose();
  }
});

test("Pi leaves auth, configuration and model failures non-retryable", async () => {
  for (const error of [
    "authentication failed: upstream returned HTTP 503",
    "invalid configuration: provider is overloaded",
    "model unavailable: selected model returned HTTP 503",
  ]) {
    const fake = fakePi();
    const runtime = createPiRuntime(context, fake.rpc);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_, event) => events.push(event));
    await runtime.createSessionOperation!({ projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" }, "create-op");
    const admitted = await runtime.startTurnOperation!({
      sessionId: "canonical",
      text: "do not retry",
      model: { providerID: "commandcode", modelID: "deepseek/deepseek-v4.1-flash" },
    }, "turn-op");
    assert.equal(admitted.kind, "confirmed");
    fake.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: error } });
    fake.emit({ type: "agent_settled" });
    assert.deepEqual(events.findLast((event) => event.type === "turn/stopped"), {
      type: "turn/stopped",
      turnId: "turn-op",
      reason: "error",
      error,
    });
    await runtime.dispose();
  }
});

test("Pi delivers text-file attachments through Polyth's projection and keeps binary ones refused", async () => {
  // Pi RPC carries image blocks only. Declaring `file: "emulated"` lets the
  // server project plain-text files into the prompt (like Claude/Codex) instead
  // of refusing every file before admission.
  const support = effectiveAttachmentSupport(PI_CAPABILITIES, undefined, false, false);
  const textRef = { id: "a1", name: "notes.md", mime: "text/plain", size: 3, kind: "file" as const, path: "docs/notes.md" };
  assert.deepEqual(
    planAttachmentDelivery({ ref: textRef, support, harnessName: "Pi", supportDeclared: true }),
    { kind: "text-projection", modality: "file" },
  );
  const projected = projectAttachmentText({ path: "docs/notes.md", bytes: new TextEncoder().encode("hi\n") });
  assert.equal(projected.ok, true);
  const binary = projectAttachmentText({ path: "bin.dat", bytes: Uint8Array.from([1, 0, 2]) });
  assert.equal(binary.ok, false);
  if (!binary.ok) assert.equal(binary.code, "invalid-attachment");
  // Modalities Pi truly cannot carry stay refused at the shared decision point.
  const audioRef = { id: "a2", name: "clip.mp3", mime: "audio/mpeg", size: 3, kind: "file" as const, path: "clip.mp3" };
  const refused = planAttachmentDelivery({ ref: audioRef, support, harnessName: "Pi", supportDeclared: true });
  assert.equal(refused.kind, "unsupported");
});

test("Pi reports emulated title support and surfaces an explicit native session name", async () => {
  // Pi RPC can carry a client/extension-set display name, but the agent does
  // not generate a semantic title. Claiming native would make the canonical
  // layer wait for an event that never arrives.
  assert.equal(PI_CAPABILITIES.title, "emulated");

  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_, event) => events.push(event));

  fake.emit({ type: "session_info_changed", name: "  Fix mobile composer  " });
  fake.emit({ type: "session_info_changed", name: "   " });

  assert.deepEqual(events, [{ type: "session/title-generated", title: "Fix mobile composer" }]);
  await runtime.dispose();
});

test("Pi surfaces a stored native name on resume and reports it from the session list", async () => {
  const fake = fakePi();
  const first = createPiRuntime(context, fake.rpc);
  await first.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Generated session name", cwd: "/tmp" },
    "create-op",
  );
  assert.equal(
    (await first.sessions()).find((item) => item.id === "/tmp/pi-created.jsonl")?.title,
    "Generated session name",
  );
  await first.dispose();

  const resumed = createPiRuntime(context, fake.rpc);
  const events: RuntimeEvent[] = [];
  resumed.onEvent((_, event) => events.push(event));
  await resumed.ensureSession({
    projectId: "project",
    sessionId: "canonical",
    title: "New session",
    cwd: "/tmp",
    backendSessionId: "/tmp/pi-created.jsonl",
  });
  assert.deepEqual(events, [{ type: "session/title-generated", title: "Generated session name" }]);
  await resumed.dispose();
});

test("Pi abort is confirmed only after the native abort command returns", async () => {
  const fake = fakePi();
  const runtime = createPiRuntime(context, fake.rpc);
  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
    "create-op",
  );
  await runtime.startTurnOperation!({ sessionId: "canonical", text: "work" }, "turn-op");

  const aborted = await runtime.abortOperation!("canonical", "abort-op");
  assert.equal(aborted.kind, "confirmed");
  assert.ok(fake.calls.some((call) => call.type === "clear_queue"));
  assert.ok(fake.calls.some((call) => call.type === "abort"));

  fake.emit({ type: "agent_settled" });
  await runtime.dispose();
});

test("Pi treats a timed-out state probe as missing evidence, not a dead transport", async () => {
  // Pi answers get_state only after an in-flight abort has killed its tool. One
  // slow probe used to latch the runtime disconnected, so every later prompt
  // was refused as "requires recovery" on a perfectly live process.
  const fake = fakePi();
  const request = fake.rpc.request.bind(fake.rpc);
  let stateTimeouts = 0;
  fake.rpc.request = (async (command: Record<string, unknown> & { type: string }) => {
    if (command.type === "get_state" && stateTimeouts > 0) {
      stateTimeouts -= 1;
      throw Object.assign(new Error("Pi RPC request timed out"), { code: "runtime-timeout" });
    }
    return request(command);
  }) as PiRpc["request"];
  const runtime = createPiRuntime(context, fake.rpc);
  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
    "create-op",
  );
  stateTimeouts = 1;
  const binding = {
    canonicalSessionId: "canonical",
    backendSessionId: "/tmp/pi-created.jsonl",
    authorityId: "pi-authority",
    generation: 3,
    continuity: "generation-only" as const,
    location: { directory: "/tmp" },
  };

  assert.equal((await runtime.reconcile!(binding)).state.value, "unknown");
  assert.equal((await runtime.reconcile!(binding)).state.value, "idle");
  const admitted = await runtime.startTurnOperation!({ sessionId: "canonical", text: "continue" }, "turn-op");
  assert.equal(admitted.kind, "confirmed");
  await runtime.dispose();
});

test("Pi routes a shared runtime's events to the canonical session named by the operation", async () => {
  // Utility work (commit messages, auditors) runs on a workspace runtime with
  // no canonical session bound at creation. Events must follow the operation's
  // canonical session id or callers like oneShot only ever see a timeout.
  const fake = fakePi();
  const sharedContext = { spaceId: "space", projectId: "project", cwd: "/tmp" } as const;
  const runtime = createPiRuntime(sharedContext, fake.rpc);
  const seen: Array<{ sid: string; event: RuntimeEvent }> = [];
  runtime.onEvent((sid, event) => seen.push({ sid, event }));

  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "oneshot-42", title: "utility", cwd: "/tmp" },
    "create-op",
  );
  await runtime.reconcile!({
    canonicalSessionId: "oneshot-42",
    backendSessionId: "/tmp/pi-created.jsonl",
    authorityId: "pi-authority",
    generation: 3,
    continuity: "generation-only",
    location: { directory: "/tmp" },
  });
  const admitted = await runtime.startTurnOperation!({ sessionId: "oneshot-42", text: "hi" }, "turn-op");
  assert.equal(admitted.kind, "confirmed");

  fake.emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" },
  });
  fake.emit({ type: "agent_settled" });

  assert.ok(seen.length > 0, "the shared runtime emitted no events");
  assert.ok(seen.every((entry) => entry.sid === "oneshot-42"), "events were not attributed to the active canonical session");
  assert.ok(seen.some((entry) => entry.event.type === "turn/stopped" && entry.event.reason === "completed"));

  // A second utility session reusing the same workspace runtime must rebind the
  // event stream, not keep emitting for the first canonical session.
  seen.length = 0;
  await runtime.createSessionOperation!(
    { projectId: "project", sessionId: "oneshot-43", title: "utility 2", cwd: "/tmp" },
    "create-op-2",
  );
  await runtime.startTurnOperation!({ sessionId: "oneshot-43", text: "again" }, "turn-op-2");
  fake.emit({ type: "agent_settled" });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((entry) => entry.sid === "oneshot-43"), "the shared runtime did not rebind to the second canonical session");
  await runtime.dispose();
});

test("Pi classifies a refused provider request as a bounded auto-retry", async () => {
  // A provider 4xx "invalid request" is usually about this one call, so the
  // server may resend it a few times. Capacity signals keep their own retry
  // hints, and a payload that cannot fit (or an auth problem) must never enter
  // the auto-retry path — repeating the same bytes cannot fix either.
  const cases: Array<{
    error: string;
    retry?: { scope: string; provider?: string; retryable?: boolean };
    code?: string;
  }> = [
    {
      error: '400: {"message":"{\\"message\\":\\"invalid request error trace_id: abc\\"}"}',
      retry: { scope: "request", provider: "commandcode", retryable: true },
    },
    { error: "429 too many requests", code: "rate-limited", retry: { scope: "rate", provider: "commandcode", retryable: true } },
    { error: "503 service unavailable", code: "overloaded", retry: { scope: "overloaded", provider: "commandcode", retryable: true } },
    { error: "context_length_exceeded: prompt is too large" },
    { error: "401 unauthorized" },
  ];
  for (const testCase of cases) {
    const fake = fakePi();
    const runtime = createPiRuntime(context, fake.rpc);
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_, event) => events.push(event));
    await runtime.createSessionOperation!(
      { projectId: "project", sessionId: "canonical", title: "Pi", cwd: "/tmp" },
      "create-op",
    );
    await runtime.startTurnOperation!(
      {
        sessionId: "canonical",
        text: "hello",
        model: { providerID: "commandcode", modelID: "deepseek/deepseek-v4.1-flash" },
      },
      "turn-op",
    );
    fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "commandcode",
        content: [],
        stopReason: "error",
        errorMessage: testCase.error,
      },
    });
    fake.emit({ type: "agent_settled" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stopped = events.findLast((event) => event.type === "turn/stopped");
    assert.equal(stopped?.reason, "error", testCase.error);
    assert.deepEqual((stopped as { retry?: unknown } | undefined)?.retry, testCase.retry, testCase.error);
    assert.equal((stopped as { code?: string } | undefined)?.code, testCase.code, testCase.error);
    await runtime.dispose();
  }
});
