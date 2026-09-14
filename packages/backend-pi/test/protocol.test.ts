import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import { createPiRuntime } from "../src/runtime.ts";
import type { PiRpc, PiRpcEvent, PiRpcState } from "../src/rpc.ts";

const fakePi = () => {
  const receipts: Record<string, string> = {};
  const eventListeners = new Set<(event: PiRpcEvent) => void>();
  const closeListeners = new Set<() => void>();
  const calls: Array<Record<string, unknown>> = [];
  let commands = [{ name: "review", description: "Review changes" }];
  let state: PiRpcState = {
    sessionFile: "/tmp/pi-initial.jsonl",
    sessionId: "initial",
    isStreaming: false,
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
