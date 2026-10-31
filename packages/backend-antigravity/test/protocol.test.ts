import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTIGRAVITY_CAPABILITIES, agyLaunchArgs, agyUsage, createAgyDecoder, createAgyTurn, parseAgyModels, sameAgyModel } from "../src/protocol.ts";

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
  assert.equal(models[0]?.variants, undefined);
  assert.equal(models[0]?.connected, undefined);
  assert.equal(models[0]?.cost, undefined);
  assert.deepEqual(parseAgyModels("Sign in to continue"), []);
});
test("models with effort suffixes are deduplicated and grouped with thinking effort variants", () => {
  const models = parseAgyModels([
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n"));
  assert.deepEqual(models.map((row) => [row.modelID, row.name, row.variants, row.defaultVariant]), [
    ["gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"], "high"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", undefined, undefined],
    ["gpt-oss-120b", "GPT-OSS 120B", ["medium"], "medium"],
  ]);
});
test("launch arguments for deduplicated models pass the base model ID and chosen effort", () => {
  const base = { providerID: "antigravity", modelID: "gemini-3.8-flash" };
  assert.deepEqual(agyLaunchArgs({ ...base, variant: "high" }).slice(-4), ["--model", "gemini-3.8-flash", "--effort", "high"]);
  assert.deepEqual(agyLaunchArgs({ ...base, variant: "medium" }).slice(-4), ["--model", "gemini-3.8-flash", "--effort", "medium"]);
  assert.deepEqual(agyLaunchArgs({ ...base, variant: "low" }).slice(-4), ["--model", "gemini-3.8-flash", "--effort", "low"]);
  assert.deepEqual(agyLaunchArgs(base).slice(-2), ["--model", "gemini-3.8-flash"]);
});
test("launch arguments never send an effort the model ID already fixes or contradicts", () => {
  const suffixed = { providerID: "antigravity", modelID: "gemini-3.8-flash-high" };
  // The CLI answers `--model gemini-3.8-flash-high --effort low` with
  // "conflicts with --effort=low"; the ID's own effort needs no flag at all.
  assert.deepEqual(agyLaunchArgs({ ...suffixed, variant: "high" }).slice(-2), ["--model", "gemini-3.8-flash-high"]);
  assert.deepEqual(agyLaunchArgs(suffixed).slice(-2), ["--model", "gemini-3.8-flash-high"]);
  assert.throws(() => agyLaunchArgs({ ...suffixed, variant: "low" }), { code: "invalid-variant", message: /runs at high effort/ });
  // Picking the ID's own effort is the same launch, not a live model change.
  assert.equal(sameAgyModel({ ...suffixed, variant: "high" }, suffixed), true);
  assert.equal(sameAgyModel({ ...suffixed, variant: "low" }, suffixed), false);
  assert.equal(sameAgyModel(model, { ...model, variant: undefined }), false, "an unsuffixed ID keeps an explicit effort distinct");
  assert.equal(sameAgyModel({ providerID: "antigravity", modelID: "gemini-3.8-flash", variant: "high" }, suffixed), true);
});
test("launch arguments use the native headless bypass and keep the approval bridge", () => {
  assert.deepEqual(agyLaunchArgs(model, "reviewer", "conversation-1"), ["--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "conversation-1", "--model", "fixture-gemini", "--effort", "high", "--agent", "reviewer"]);
  assert.deepEqual(agyLaunchArgs(undefined, undefined, undefined, { bypass: true, hookRoot: "/polyth-hooks" }), [
    "--input-format", "stream-json", "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--add-dir", "/polyth-hooks",
  ]);
  assert.equal(agyLaunchArgs().includes("--sandbox"), false);
  assert.equal(agyLaunchArgs().includes("--continue"), false);
  assert.equal(agyLaunchArgs().includes("--dangerously-skip-permissions"), false);
  // Review mode stays the default: the flag is the only thing that auto-approves
  // headless tools, and the hook is still consulted while it is set.
  assert.equal(agyLaunchArgs(undefined, undefined, undefined, { hookRoot: "/polyth-hooks" }).includes("--dangerously-skip-permissions"), false);
  assert.equal(agyLaunchArgs(undefined, undefined, undefined, { bypass: true }).includes("--add-dir"), false);
  assert.throws(() => agyLaunchArgs({ ...model, modelID: "--evil" }), /catalog/);
  assert.throws(() => agyLaunchArgs({ ...model, providerID: "other" }), /catalog/);
  assert.throws(() => agyLaunchArgs({ ...model, variant: "max" }), /effort/);
  assert.throws(() => agyLaunchArgs(undefined, "a;echo secret"), /agent/);
});
test("Antigravity does not advertise native subagents", () => {
  assert.equal(ANTIGRAVITY_CAPABILITIES.subagents, false);
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
test("thinking stays separate from public dialogue and checkpoint text stays hidden", () => {
  const turn = createAgyTurn("t", model);
  const thinking = turn.step({ step_index: 1, state: "DONE", step_type: "thinking", text_delta: "private thought" });
  assert.deepEqual(thinking, [
    { type: "assistant/reasoning-chunk", partId: "t:step:1", text: "private thought" },
    { type: "assistant/message", partId: "t:step:1", text: "", reasoning: "private thought" },
  ]);
  assert.equal(thinking.find((event) => event.type === "assistant/message")?.text, "");
  // A checkpoint is recorded as the CLI's compaction, never as dialogue.
  const checkpoint = turn.step({ step_index: 2, state: "DONE", step_type: "checkpoint", text_delta: "internal prompt" });
  assert.deepEqual(checkpoint.map((event) => event.type), ["session/compacted", "context/updated"]);
  const events = turn.finish({ status: "SUCCESS", response: "Public answer" });
  assert.equal(events.filter((event) => event.type === "assistant/message").length, 1);
  assert.equal(events.find((event) => event.type === "assistant/message")?.text, "Public answer");
  assert.equal(JSON.stringify([...checkpoint, ...events]).includes("internal prompt"), false);
});
test("thinking deltas stream as reasoning and finalize separately at DONE", () => {
  const turn = createAgyTurn("t", model);
  assert.deepEqual(turn.step({ step_index: 7, state: "ACTIVE", step_type: "thinking", text_delta: "Private " }), [
    { type: "assistant/reasoning-chunk", partId: "t:step:7", text: "Private " },
  ]);
  assert.deepEqual(turn.step({ step_index: 7, state: "ACTIVE", step_type: "thinking", text_delta: "thought" }), [
    { type: "assistant/reasoning-chunk", partId: "t:step:7", text: "thought" },
  ]);
  assert.deepEqual(turn.step({ step_index: 7, state: "DONE", step_type: "thinking" }), [
    { type: "assistant/message", partId: "t:step:7", text: "", reasoning: "Private thought" },
  ]);
});
test("settled thinking content is finalized when no reasoning delta was streamed", () => {
  const turn = createAgyTurn("t", model);
  assert.deepEqual(turn.step({ step_index: 8, state: "DONE", step_type: "thinking", content: "Reasoning from content" }), [
    { type: "assistant/message", partId: "t:step:8", text: "", reasoning: "Reasoning from content" },
  ]);
});
test("DONE-only tools retain failures and native permission denial", () => {
  const turn = createAgyTurn("t", model);
  const events = turn.step({ step_index: 3, state: "DONE", step_type: "tool", tool_info: { name: "run_command", parameters: { CommandLine: "echo hello" }, error: { type: "denied", message: "Permission denied" } } });
  assert.equal(events[0]?.type, "tool/started");
  assert.deepEqual(events[1], { type: "tool/error", callId: "t:step:3", tool: "run_command", error: "Permission denied" });
});
test("a native error state reports the denial instead of aborting the runtime", () => {
  const turn = createAgyTurn("t", model);
  const tool = { name: "run_command", parameters: { CommandLine: "ls -la /home/dev/.gemini/antigravity-cli/" } };
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
test("a tool step accumulates streamed parameters and native result content", () => {
  const turn = createAgyTurn("t", model);
  assert.deepEqual(turn.step({
    step_index: 4, state: "ACTIVE", step_type: "tool",
    tool_info: { name: "replace_file_content", parameters: { TargetFile: "/repo/a.ts" } },
  }), [
    { type: "tool/started", callId: "t:step:4", tool: "replace_file_content", input: { TargetFile: "/repo/a.ts" } },
  ]);
  assert.deepEqual(turn.step({
    step_index: 4, state: "ACTIVE", step_type: "tool",
    tool_info: {
      name: "replace_file_content",
      parameters: { TargetFile: "/repo/a.ts", TargetContent: "a", ReplacementContent: "b" },
    },
  }), []);
  assert.deepEqual(turn.step({
    step_index: 4, state: "DONE", step_type: "tool",
    tool_info: {
      name: "replace_file_content",
      parameters: { TargetFile: "/repo/a.ts", TargetContent: "a", ReplacementContent: "b" },
    },
    content: "[diff_block_start]\n@@ -1 +1 @@\n-a\n+b\n[diff_block_end]",
  }), [
    {
      type: "tool/result",
      callId: "t:step:4",
      tool: "replace_file_content",
      output: "[diff_block_start]\n@@ -1 +1 @@\n-a\n+b\n[diff_block_end]",
      input: { TargetFile: "/repo/a.ts", TargetContent: "a", ReplacementContent: "b" },
    },
  ]);
});
test("planner tool-call arguments survive a path-only execution step", () => {
  const turn = createAgyTurn("t", model);
  assert.deepEqual(turn.step({
    step_index: 10, state: "DONE", step_type: "planner_response",
    tool_calls: [{
      name: "replace_file_content",
      args: { TargetFile: "/repo/a.ts", TargetContent: "a", ReplacementContent: "b" },
    }],
  }), []);
  assert.deepEqual(turn.step({
    step_index: 11, state: "ACTIVE", step_type: "tool",
    tool_info: { name: "replace_file_content", parameters: { TargetFile: "/repo/a.ts" } },
  }), [
    {
      type: "tool/started",
      callId: "t:step:11",
      tool: "replace_file_content",
      input: { TargetFile: "/repo/a.ts", TargetContent: "a", ReplacementContent: "b" },
    },
  ]);
  assert.deepEqual(turn.step({
    step_index: 11, state: "DONE", step_type: "tool",
    tool_info: { name: "replace_file_content", parameters: { TargetFile: "/repo/a.ts" } },
  }), [
    {
      type: "tool/result",
      callId: "t:step:11",
      tool: "replace_file_content",
      output: "",
      input: { TargetFile: "/repo/a.ts", TargetContent: "a", ReplacementContent: "b" },
    },
  ]);
});
test("a soft-denied headless tool cannot end as a silent successful turn", () => {
  const turn = createAgyTurn("t", model);
  turn.step({
    step_index: 2, state: "ERROR", step_type: "tool", tool_name: "run_command",
    error: "permission check failed for unsandboxed command",
  });
  const events = turn.finish({ status: "SUCCESS", response: "" });
  assert.deepEqual(events.at(-1), {
    type: "turn/stopped",
    turnId: "t",
    reason: "error",
    error: "Antigravity auto-denied a tool because its headless mode cannot prompt for approval and Polyth's bridge cannot grant one. No mutation was confirmed; check the CLI's own permission rules, then retry.",
    code: "unknown",
  });
});
test("an empty native SUCCESS without proven non-application keeps its native outcome", () => {
  const turn = createAgyTurn("t", model);
  assert.deepEqual(turn.finish({ status: "SUCCESS", response: "" }), [{
    type: "turn/stopped",
    turnId: "t",
    reason: "completed",
  }]);
});
test("a native quota error preserves its message and reset timer", () => {
  const turn = createAgyTurn("t", model);
  assert.deepEqual(turn.finish({
    status: "ERROR",
    error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h 30m.",
  }, undefined, 1_800_000_000_000).at(-1), {
    type: "turn/stopped",
    turnId: "t",
    reason: "error",
    error: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h 30m.",
    code: "quota-exhausted",
    retry: {
      scope: "quota",
      provider: "google",
      retryAfterSec: 9_000,
      resetAt: 1_800_009_000_000,
      retryable: true,
    },
  });
});
test("a prior successful tool prevents a denial from offering an unsafe turn retry", () => {
  const turn = createAgyTurn("t", model);
  turn.step({ step_index: 1, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", output: "written" } });
  turn.step({ step_index: 2, state: "ERROR", step_type: "tool", tool_name: "run_command", error: "permission denied" });
  assert.deepEqual(turn.finish({ status: "SUCCESS", response: "" }).at(-1), {
    type: "turn/stopped", turnId: "t", reason: "completed",
  });
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
test("native Antigravity subagent discovery never creates a shadow Polyth identity", () => {
  const turn = createAgyTurn("t", model);
  const events = turn.step({ step_index: 3, state: "DONE", step_type: "spawn", subagent_info: { subagents: [{ type_name: "reviewer", role: "Inspect tests", conversation_id: "child-1", log_uri: "/private/log", workspace_uris: ["/other-space"] }] } });
  assert.deepEqual(events, []);
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
    { type: "tool/result", callId: "t:step:2", tool: "invoke_subagent", output: "", input: { Subagents: [{ TypeName: "self", Role: "Math Calculator" }] } },
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
test("capabilities name only what the headless adapter delivers", () => {
  // Hook-backed: gated tools raise canonical permission requests Polyth answers.
  assert.equal(ANTIGRAVITY_CAPABILITIES.permissions, true);
  // Hook-backed: questions are answered through Polyth, steering is injected
  // before the next model invocation.
  assert.equal(ANTIGRAVITY_CAPABILITIES.questions, true);
  assert.equal(ANTIGRAVITY_CAPABILITIES.steering, true);
  // Stream-json input is text-only; binary attachments are opened by the CLI's
  // own tools, so they are emulated, never native.
  assert.deepEqual(ANTIGRAVITY_CAPABILITIES.attachments.modalities, {
    file: "emulated", image: "emulated", pdf: "emulated", audio: "emulated", url: "emulated",
  });
  assert.equal(ANTIGRAVITY_CAPABILITIES.contextOccupancy, "derived");
  assert.deepEqual(ANTIGRAVITY_CAPABILITIES.commands, { discovery: "native", invoke: "raw-native-input" });
  // Headless mode reports no cost, exposes no fork or compaction trigger.
  assert.equal(ANTIGRAVITY_CAPABILITIES.cost, false);
  assert.equal(ANTIGRAVITY_CAPABILITIES.fork, false);
  assert.equal(ANTIGRAVITY_CAPABILITIES.compaction, false);
  // The CLI names each conversation in its own annotation store; the adapter
  // reads that metadata and the canonical layer polls for the delayed title.
  assert.equal(ANTIGRAVITY_CAPABILITIES.title, "native");
});
test("model input modalities follow a conservative family table; unknown families stay text-only", () => {
  const models = parseAgyModels([
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n"));
  const inputs = Object.fromEntries(models.map((row) => [row.modelID, row.capabilities?.filter((cap) => cap.startsWith("input:"))]));
  assert.deepEqual(inputs, {
    "gemini-3.8-flash": ["input:text", "input:image", "input:pdf", "input:audio"],
    "claude-sonnet-4-6": ["input:text", "input:image", "input:pdf"],
    "gpt-oss-120b": ["input:text"],
  });
});
test("settled model usage reports derived context occupancy without inventing a window", () => {
  const turn = createAgyTurn("t", model);
  const events = turn.step({ step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "ok",
    usage: { input_tokens: 10302, output_tokens: 582, thinking_tokens: 551, cache_read_tokens: 8113 } });
  const context = events.find((event) => event.type === "context/updated");
  assert.equal(context?.type, "context/updated");
  if (context?.type !== "context/updated") throw new Error("context telemetry missing");
  // The occupied context is the whole prompt: the non-cached input plus the
  // cached prefix this call read back.
  assert.equal(context.usedTokens, 10302 + 8113);
  assert.equal(context.source, "derived");
  assert.equal(context.limitTokens, undefined);
  // In-flight steps carry no final usage and publish nothing.
  assert.equal(turn.step({ step_index: 5, state: "ACTIVE", step_type: "agent_response", text_delta: "x",
    usage: { input_tokens: 1, output_tokens: 1 } }).some((event) => event.type === "context/updated"), false);
});
test("a native checkpoint step records the CLI's own compaction once", () => {
  const turn = createAgyTurn("t", model);
  // Transcripts record the CLI's compaction summary as a SYSTEM `CHECKPOINT`
  // step; the stream names step types in lower case.
  assert.deepEqual(turn.step({ step_index: 9, state: "RUNNING", step_type: "checkpoint" }), []);
  const events = turn.step({ step_index: 9, state: "DONE", step_type: "checkpoint", content: "# Summary",
    usage: { input_tokens: 180_000, output_tokens: 2_000 } });
  assert.deepEqual(events[0], { type: "session/compacted", backendEventId: "t:step:9", summary: "# Summary" });
  const context = events[1];
  if (context?.type !== "context/updated") throw new Error("compaction telemetry missing");
  assert.equal(context.source, "unknown");
  assert.equal(context.compaction?.active, false);
  assert.equal(typeof context.compaction?.lastAt, "number");
  // The checkpoint's own call read the pre-compaction conversation, so its
  // prompt size is not published as the occupancy after compaction.
  assert.equal(context.usedTokens, undefined);
  assert.equal(events.length, 2);
  assert.deepEqual(turn.step({ step_index: 9, state: "DONE", step_type: "CHECKPOINT" }), [], "a settled step is final");
  // A checkpoint the CLI failed to write is not a compaction.
  assert.deepEqual(createAgyTurn("u", model).step({ step_index: 2, state: "ERROR", step_type: "CHECKPOINT" }), []);
  // Its usage still counts toward the turn.
  assert.deepEqual(turn.finish({ status: "SUCCESS", response: "done" }).find((event) => event.type === "usage/recorded"),
    { type: "usage/recorded", model, tokens: { input: 180_000, output: 2_000, reasoning: 0, cacheRead: 0 } });
});
test("a native question Polyth answered settles as its answer, not as a failed tool", () => {
  const turn = createAgyTurn("t", model);
  const questions = { questions: [{ question: "Which database?", options: [{ id: "pg", text: "PostgreSQL" }] }] };
  turn.step({ step_index: 6, state: "ACTIVE", step_type: "tool", tool_info: { name: "ask_question", parameters: questions } });
  const settled = turn.step({ step_index: 6, state: "ERROR", step_type: "tool", tool_name: "ask_question",
    error: "Tool call denied by hook: Answered by the user in Polyth (headless Antigravity cannot show its question dialog, so Polyth asked instead):\n1. Which database?\n   Answer: PostgreSQL" });
  assert.equal(settled[0]?.type, "tool/result");
  if (settled[0]?.type !== "tool/result") throw new Error("answered question missing");
  assert.match(settled[0].output, /^Answered by the user in Polyth/);
  assert.match(settled[0].output, /Answer: PostgreSQL/);
  // An answered question is not a silent permission denial.
  const stop = turn.finish({ status: "SUCCESS", response: "" }).at(-1);
  assert.deepEqual(stop, { type: "turn/stopped", turnId: "t", reason: "completed" });
  assert.equal(createAgyTurn("u", model).step({ step_index: 1, state: "ERROR", step_type: "tool", tool_name: "run_command",
    error: "Answered by the user in Polyth" })[1]?.type, "tool/error", "only ask_question settles as an answer");
});
