import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTIGRAVITY_CAPABILITIES, agyLaunchArgs, agyUsage, createAgyDecoder, createAgyTurn, parseAgyModels } from "../src/protocol.ts";

const model = { providerID: "antigravity", modelID: "fixture-gemini", variant: "high" };
test("native NDJSON preserves fragmented Unicode, blank lines and final non-LF frames", () => {
  const frames: unknown[] = [];
  const decoder = createAgyDecoder((frame) => frames.push(frame));
  const bytes = Buffer.from('\n{"event":"future","text":"Привіт 🌍"}\r\n{"event":"last"}');
  for (const byte of bytes) decoder.write(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(frames, [{ event: "future", text: "Привіт 🌍" }, { event: "last" }]);
});
test("NDJSON rejects malformed envelopes and oversized complete or partial frames", () => {
  for (const line of ['no-json\n', '[]\n', '{}\n', 'null\n']) assert.throws(() => createAgyDecoder(() => {}).write(line), { code: "protocol-error" });
  assert.throws(() => createAgyDecoder(() => {}, 24).write('x'.repeat(25)), /size limit/);
  assert.throws(() => createAgyDecoder(() => {}, 24).write('x'.repeat(25) + '\n'), /size limit/);
});
test("model catalog is dynamic, deduplicated and does not invent auth or prices", () => {
  const models = parseAgyModels('Models\nslug  Name\nfixture-gemini  Gemini Fixture\nfixture-other\tOther Fixture\nfixture-gemini  Updated Fixture\n');
  assert.equal(models.length, 2);
  assert.equal(models[0]?.name, "Updated Fixture");
  assert.deepEqual(models[0]?.variants, ["low", "medium", "high"]);
  assert.equal(models[0]?.connected, undefined);
  assert.equal(models[0]?.cost, undefined);
  assert.deepEqual(parseAgyModels("Sign in to continue"), []);
});
test("launch arguments pin explicit conversation/model/effort and never bypass permissions", () => {
  assert.deepEqual(agyLaunchArgs(model, "reviewer", "conversation-1"), ["--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "conversation-1", "--model", "fixture-gemini", "--effort", "high", "--agent", "reviewer"]);
  assert.equal(agyLaunchArgs().includes("--continue"), false);
  assert.equal(agyLaunchArgs().includes("--dangerously-skip-permissions"), false);
  assert.throws(() => agyLaunchArgs({ ...model, modelID: "--evil" }), /catalog/);
  assert.throws(() => agyLaunchArgs({ ...model, providerID: "other" }), /catalog/);
  assert.throws(() => agyLaunchArgs({ ...model, variant: "max" }), /effort/);
  assert.throws(() => agyLaunchArgs(undefined, "a;echo secret"), /agent/);
});
test("public text streams once; terminal response and repeated DONE do not duplicate it", () => {
  const turn = createAgyTurn("turn-1", model);
  const first = turn.step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello" });
  const last = turn.step({ step_index: 2, state: "DONE", step_type: "agent_response", text_delta: " world" });
  assert.equal(first[0]?.type, "assistant/chunk");
  assert.deepEqual(last, [{ type: "assistant/chunk", partId: "turn-1:step:2", text: " world" }, { type: "assistant/message", partId: "turn-1:step:2", text: "Hello world" }]);
  assert.deepEqual(turn.step({ step_index: 2, state: "DONE", step_type: "agent_response", text_delta: " world" }), []);
  assert.deepEqual(turn.finish({ status: "SUCCESS", response: "Hello world" }), [{ type: "turn/stopped", turnId: "turn-1", reason: "completed" }]);
  assert.deepEqual(turn.finish({ status: "SUCCESS", response: "Hello world" }), []);
});
test("hidden thought/checkpoint text never becomes public dialogue", () => {
  const turn = createAgyTurn("t", model);
  assert.deepEqual(turn.step({ step_index: 1, state: "DONE", step_type: "thinking", text_delta: "private thought" }), []);
  assert.deepEqual(turn.step({ step_index: 2, state: "DONE", step_type: "checkpoint", text_delta: "internal prompt" }), []);
  const events = turn.finish({ status: "SUCCESS", response: "Public answer" });
  assert.equal(events.filter((event) => event.type === "assistant/message").length, 1);
  assert.equal(JSON.stringify(events).includes("private thought"), false);
});
test("DONE-only tools retain failures and native permission denial", () => {
  const turn = createAgyTurn("t", model);
  const events = turn.step({ step_index: 3, state: "DONE", step_type: "tool", tool_info: { name: "run_command", parameters: { CommandLine: "echo hello" }, error: { type: "denied", message: "Permission denied" } } });
  assert.equal(events[0]?.type, "tool/started");
  assert.deepEqual(events[1], { type: "tool/error", callId: "t:step:3", tool: "run_command", error: "Permission denied" });
});
test("a native error state reports the denial instead of aborting the runtime", () => {
  const turn = createAgyTurn("t", model);
  const tool = { name: "run_command", parameters: { CommandLine: "ls -la /home/ubuntu/.gemini/antigravity-cli/" } };
  assert.deepEqual(turn.step({ step_index: 6, state: "ACTIVE", step_type: "tool", tool_info: tool }), [
    { type: "tool/started", callId: "t:step:6", tool: "run_command", input: tool.parameters },
  ]);
  assert.deepEqual(turn.step({ step_index: 6, state: "ERROR", step_type: "tool", tool_info: tool, error: "permission check failed for unsandboxed command" }), [
    { type: "tool/error", callId: "t:step:6", tool: "run_command", error: "permission check failed for unsandboxed command" },
  ]);
  assert.deepEqual(turn.step({ step_index: 6, state: "ERROR", step_type: "tool", tool_info: tool }), []);
  assert.deepEqual(turn.finish({ status: "SUCCESS", response: "That directory is outside the workspace." }), [
    { type: "assistant/message", partId: "t:result", text: "That directory is outside the workspace." },
    { type: "turn/stopped", turnId: "t", reason: "completed" },
  ]);
});
test("a failed tool step with no ACTIVE frame still surfaces its denial", () => {
  const turn = createAgyTurn("t", model);
  assert.deepEqual(turn.step({
    step_index: 2, state: "ERROR", step_type: "tool", tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "cat /etc/shadow" }, error: { type: "denied", message: "user denied permission" } },
  }), [
    { type: "tool/started", callId: "t:step:2", tool: "run_command", input: { CommandLine: "cat /etc/shadow" } },
    { type: "tool/error", callId: "t:step:2", tool: "run_command", error: "user denied permission" },
  ]);
});
test("transitional and unrecognized step states never abort the turn", () => {
  const turn = createAgyTurn("t", model);
  for (const state of ["PENDING", "QUEUED", "RUNNING", "WAITING", "GENERATING", "CLEARED", "UNSPECIFIED", "FUTURE_STATE"]) {
    assert.deepEqual(turn.step({ step_index: 1, state, step_type: "checkpoint" }), []);
  }
  assert.deepEqual(turn.step({ step_index: 1, step_type: "checkpoint" }), []);
  // An unrecognized state does not settle the step, so a later DONE still reports it.
  assert.deepEqual(turn.step({ step_index: 3, state: "WAITING", step_type: "tool", tool_name: "run_command" }).map((event) => event.type), ["tool/started"]);
  assert.deepEqual(turn.step({ step_index: 3, state: "DONE", step_type: "tool", tool_info: { name: "run_command", output: "ok" } }), [
    { type: "tool/result", callId: "t:step:3", tool: "run_command", output: "ok" },
  ]);
});
test("an interrupted text step finalizes the text it already streamed", () => {
  const turn = createAgyTurn("t", model);
  turn.step({ step_index: 4, state: "ACTIVE", step_type: "agent_response", text_delta: "Partial " });
  assert.deepEqual(turn.step({ step_index: 4, state: "INTERRUPTED", step_type: "agent_response" }), [
    { type: "assistant/message", partId: "t:step:4", text: "Partial " },
  ]);
});
test("a tool the native CLI never terminates is closed as an error at turn end", () => {
  const turn = createAgyTurn("t", model);
  turn.step({ step_index: 5, state: "ACTIVE", step_type: "tool", tool_name: "run_command" });
  const events = turn.finish({ status: "SUCCESS", response: "Done" });
  assert.deepEqual(events[0], { type: "tool/error", callId: "t:step:5", tool: "run_command", error: "Antigravity ended the turn without reporting a result for this tool call" });
  assert.deepEqual(events.at(-1), { type: "turn/stopped", turnId: "t", reason: "completed" });
});
test("subagent discovery does not claim completion or expose native log paths", () => {
  const turn = createAgyTurn("t", model);
  const events = turn.step({ step_index: 3, state: "DONE", step_type: "spawn", subagent_info: { subagents: [{ type_name: "reviewer", role: "Inspect tests", conversation_id: "child-1", log_uri: "/private/log", workspace_uris: ["/other-space"] }] } });
  assert.deepEqual(events, [{ type: "subagent/snapshot", revision: 1, agents: [{ sessionId: "child-1", label: "reviewer", status: "unknown", currentTask: "Inspect tests" }] }]);
});
test("a subagent step closes a tool proposal opened for the same invocation", () => {
  const turn = createAgyTurn("t", model);
  // Observed 1.2.7 wire shape: the tool proposal opens a call, then the spawn
  // acknowledgement arrives at the same index with `step_type: "subagent"`.
  assert.deepEqual(turn.step({
    step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent",
    tool_info: { name: "invoke_subagent", parameters: { Subagents: [{ TypeName: "self", Role: "Math Calculator" }] } },
  }), [
    { type: "tool/started", callId: "t:step:2", tool: "invoke_subagent", input: { Subagents: [{ TypeName: "self", Role: "Math Calculator" }] } },
  ]);
  assert.deepEqual(turn.step({
    step_index: 2, state: "DONE", step_type: "subagent", tool_name: "invoke_subagent",
    subagent_info: { subagents: [{ type_name: "self", role: "Math Calculator", conversation_id: "child-1" }] },
  }), [
    { type: "subagent/snapshot", revision: 1, agents: [{ sessionId: "child-1", label: "self", status: "unknown", currentTask: "Math Calculator" }] },
    { type: "tool/result", callId: "t:step:2", tool: "invoke_subagent", output: "" },
  ]);
  // The spawn settles the call, so turn end must not invent an unterminated tool error.
  assert.deepEqual(turn.finish({ status: "SUCCESS", response: "4" }), [
    { type: "assistant/message", partId: "t:result", text: "4" },
    { type: "turn/stopped", turnId: "t", reason: "completed" },
  ]);
});
test("a failed subagent step closes the open call as an error", () => {
  const turn = createAgyTurn("t", model);
  turn.step({ step_index: 7, state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent", tool_info: { name: "invoke_subagent", parameters: { Subagents: [{ TypeName: "self" }] } } });
  assert.deepEqual(turn.step({ step_index: 7, state: "HALTED", step_type: "subagent", tool_name: "invoke_subagent", error: "subagent halted" }), [
    { type: "tool/error", callId: "t:step:7", tool: "invoke_subagent", error: "subagent halted" },
  ]);
});
test("result statuses require a real terminal state; errors are not reported as success", () => {
  for (const status of ["WAITING", "RUNNING", "unexpected", undefined]) assert.throws(() => createAgyTurn("t", model).finish({ status }), /not terminal/);
  for (const status of ["ERROR", "INVALID"]) assert.equal(createAgyTurn("t", model).finish({ status }).at(-1)?.type, "turn/stopped");
  assert.deepEqual(createAgyTurn("t", model).finish({ status: "CANCELED" }), [{ type: "turn/stopped", turnId: "t", reason: "aborted" }]);
});
test("resumed usage fallback sums final steps once, including zero counters", () => {
  const turn = createAgyTurn("t", model);
  const row = { step_index: 1, state: "DONE", step_type: "checkpoint", usage: { input_tokens: 7, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 4 } };
  turn.step(row); turn.step(row);
  const event = turn.finish({ status: "SUCCESS" })[0];
  assert.deepEqual(event, { type: "usage/recorded", model, tokens: { input: 7, output: 0, reasoning: 0, cacheRead: 4 } });
  assert.equal(agyUsage({ input_tokens: -1, output_tokens: 2 }), undefined);
  assert.equal(agyUsage({ input_tokens: NaN, output_tokens: 2 }), undefined);
});
test("capabilities stay within stream protocol, not the wider Gemini model capabilities", () => {
  assert.equal(ANTIGRAVITY_CAPABILITIES.permissions, false);
  assert.equal(ANTIGRAVITY_CAPABILITIES.cost, false);
  assert.equal(ANTIGRAVITY_CAPABILITIES.attachments.modalities.image, "unsupported");
  assert.equal(ANTIGRAVITY_CAPABILITIES.fork, false);
});
