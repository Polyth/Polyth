// Long tool calls and incomplete answers in the timeline: the live-only
// `tool/progress` frame is ephemeral client state keyed by receipt time, the
// running row says only what it saw, and `turn/incomplete` becomes a notice
// whose Continue is a normal visible message.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEvent } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);

const { SyncClient } = await import("../src/sync.ts");
const progress = await import("../src/toolProgress.ts");
const { toolPulseState, ToolPulseLine, ToolPulseInline, ToolKeepRunning, TOOL_SILENCE_HINT_MS } = await import("../src/components/ToolPulse.tsx");
const { toolAwaiting } = await import("../src/toolAwaiting.ts");
const { applyEvents } = await import("../src/store.ts");
const { default: TurnIncompleteNotice, continueIncompleteTurn, CONTINUE_PROMPT } = await import("../src/components/TurnIncompleteNotice.tsx");
const { buildModel } = await import("../src/reduce.ts");
const { messageMarkdown } = await import("../src/utils.ts");

class FakeSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.({} as Event); }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
}

const ev = (seq: number, type: string, data: Record<string, unknown>, sessionId = "s1", time = seq): SessionEvent =>
  ({ id: `${sessionId}-${seq}`, sessionId, seq, time, type, data, v: 1 }) as SessionEvent;

function connected() {
  const socket = new FakeSocket();
  const client = new SyncClient({ webSocket: () => socket });
  client.connect("ws://test/ws");
  socket.open();
  client.setSubscription("s1", 0);
  return { socket, client };
}

function withNow<T>(now: number, run: () => T): T {
  const real = Date.now;
  Date.now = () => now;
  try { return run(); } finally { Date.now = real; }
}

test("a tool/progress frame records this client's receipt time, never the frame's clock, and is not passed on", () => {
  progress.clearToolProgress();
  const { socket, client } = connected();
  const seen: string[] = [];
  client.onEvent((message) => seen.push(message.type));
  withNow(5_000_000, () => socket.message({ type: "tool/progress", sessionId: "s1", callId: "c1", at: 42 }));
  assert.equal(progress.toolLastOutputAt("s1", "c1"), 5_000_000);
  assert.deepEqual(seen, []);
  // Another session's frame (stale subscription) is dropped.
  socket.message({ type: "tool/progress", sessionId: "s2", callId: "c9", at: 1 });
  assert.equal(progress.toolLastOutputAt("s2", "c9"), undefined);
  // Malformed frames are ignored.
  socket.message({ type: "tool/progress", sessionId: "s1", callId: "", at: 1 });
  socket.message({ type: "tool/progress", sessionId: "s1", callId: "c2" });
  assert.equal(progress.toolLastOutputAt("s1", "c2"), undefined);
  client.close();
});

test("progress state clears when the call finishes, its turn stops, or the session changes", () => {
  progress.clearToolProgress();
  const { socket, client } = connected();
  socket.message({ type: "tool/progress", sessionId: "s1", callId: "c1", at: 1 });
  socket.message({ type: "tool/progress", sessionId: "s1", callId: "c2", at: 1 });
  socket.message({ type: "event", event: ev(1, "tool/result", { callId: "c1", tool: "bash", output: "ok" }) });
  assert.equal(progress.toolLastOutputAt("s1", "c1"), undefined);
  assert.notEqual(progress.toolLastOutputAt("s1", "c2"), undefined);
  socket.message({ type: "events", events: [ev(2, "turn/stopped", { turnId: "t1", reason: "completed" })] });
  assert.equal(progress.toolLastOutputAt("s1", "c2"), undefined);

  socket.message({ type: "tool/progress", sessionId: "s1", callId: "c3", at: 1 });
  client.setSubscription("s2", 0);
  assert.equal(progress.toolLastOutputAt("s1", "c3"), undefined);
  socket.message({ type: "tool/progress", sessionId: "s2", callId: "c4", at: 1 });
  socket.message({ type: "event", event: ev(1, "tool/error", { callId: "c4", tool: "bash", error: "x" }, "s2") });
  assert.equal(progress.toolLastOutputAt("s2", "c4"), undefined);
  client.close();
});

test("pulse state: elapsed only without frames, last output after one, the stop hint from 8 minutes of quiet", () => {
  const start = 1_000_000;
  const none = toolPulseState(start + 192_000, start);
  assert.equal(none.elapsedMs, 192_000);
  assert.equal(none.lastOutputAgoMs, undefined);
  assert.equal(none.nearStop, false);

  const seen = toolPulseState(start + 254_000, start, start + 248_000);
  assert.equal(seen.lastOutputAgoMs, 6_000);
  assert.equal(seen.nearStop, false);

  // Without frames the server counts quiet from the start.
  assert.equal(toolPulseState(start + TOOL_SILENCE_HINT_MS - 1, start).nearStop, false);
  assert.equal(toolPulseState(start + TOOL_SILENCE_HINT_MS, start).nearStop, true);
  // With frames, from the newest receipt.
  const quiet = toolPulseState(start + 530_000, start, start + 25_000);
  assert.equal(quiet.quietMs, 505_000);
  assert.equal(quiet.nearStop, true);
});

test("the running row says only what it saw", () => {
  progress.clearToolProgress();
  const now = 10_000_000;
  withNow(now, () => {
    const start = now - 192_000;
    const props = { sessionId: "s1", callId: "c1", startedAt: start };
    // No frame: the row adds nothing (elapsed is in its status mark); the line names the elapsed time only.
    assert.equal(renderToStaticMarkup(createElement(ToolPulseLine, props)), "");
    const inline = renderToStaticMarkup(createElement(ToolPulseInline, props));
    assert.match(inline, /3m 12s/);
    assert.doesNotMatch(inline, /output/i);

    progress.noteToolProgress("s1", "c1", now - 6_000);
    assert.match(renderToStaticMarkup(createElement(ToolPulseLine, props)), />Last output 6s ago</);
    assert.match(renderToStaticMarkup(createElement(ToolPulseInline, props)), />last output 6s ago</);

    // Near the watchdog with frames: one line, the silence since the newest frame and the countdown.
    const quiet = { ...props, startedAt: now - 530_000 };
    progress.noteToolProgress("s1", "c1", now - 505_000);
    const line = renderToStaticMarkup(createElement(ToolPulseLine, quiet));
    assert.match(line, /tool-pulse--stopping/);
    assert.match(line, /No output for 8m 25s/);
    // Who stops it and on what condition, in place (not only in the tooltip).
    assert.match(line, /Polyth stops it in 1m 35s unless it prints something/);
    assert.match(line, /title="Polyth stops a command after 10 minutes with no output\."/);
    assert.doesNotMatch(line, /tool-pulse-dot|[Qq]uiet/, "no dot, and no second word for silence");
    const inlineQuiet = renderToStaticMarkup(createElement(ToolPulseInline, quiet));
    assert.match(inlineQuiet, />8m 50s</);
    // "auto-stop", never a bare "stops in" that reads as "finishes in".
    assert.match(inlineQuiet, />auto-stop in 1m 35s</);

    // Near the watchdog without frames: silence is never claimed, only the countdown.
    progress.clearToolProgress();
    const silent = { ...props, callId: "c2", startedAt: now - 530_000 };
    const silentLine = renderToStaticMarkup(createElement(ToolPulseLine, silent));
    assert.match(silentLine, />Polyth stops it in 1m 10s unless it finishes</);
    assert.doesNotMatch(silentLine, />[^<]*(No output|Last output)[^<]*</, "no claim about output");
    const silentInline = renderToStaticMarkup(createElement(ToolPulseInline, silent));
    assert.match(silentInline, />8m 50s<.*>auto-stop in 1m 10s</);
    assert.doesNotMatch(silentInline, />[^<]*(output|quiet)[^<]*</i);
  });
  progress.clearToolProgress();
});

test("turn/incomplete becomes a notice; unknown fields are tolerated and unknown kinds skipped", () => {
  const model = buildModel([
    ev(1, "user/message", { text: "hi" }),
    ev(2, "turn/incomplete", { turnId: "t1", kind: "length", autoContinued: true, future: { nested: [1] } }),
    ev(3, "turn/incomplete", { turnId: "t2", kind: "empty", autoContinued: false }),
    ev(4, "turn/incomplete", { turnId: "t3", kind: "someday" }),
    ev(5, "turn/incomplete", { turnId: "t4" }),
  ]);
  const notices = model.messages.filter((m) => m.kind === "notice");
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map((n) => n.kind === "notice" && [n.topic, n.incompleteKind, n.autoContinued]), [
    ["turn-incomplete", "length", true],
    ["turn-incomplete", "empty", false],
  ]);
  assert.equal(messageMarkdown(notices[0]!), "The answer was cut off: it reached the reply length limit · Polyth asked it to continue.");
});

test("notice variants: auto-continued says so; otherwise a quiet Continue sends a visible message", async () => {
  const base = { kind: "notice" as const, id: "n1", eventSeq: 2, topic: "turn-incomplete" as const, time: 0 };
  const auto = renderToStaticMarkup(createElement(TurnIncompleteNotice, {
    notice: { ...base, incompleteKind: "length", autoContinued: true },
    onContinue: () => {},
  }));
  assert.match(auto, /The answer was cut off: it reached the reply length limit/);
  assert.doesNotMatch(auto, /<svg/, "a footnote: no icon or disc");
  assert.match(auto, /Polyth asked it to continue\./);
  assert.doesNotMatch(auto, /<button/);

  const empty = { ...base, incompleteKind: "empty" as const, autoContinued: false };
  const offered = renderToStaticMarkup(createElement(TurnIncompleteNotice, { notice: empty, onContinue: () => {} }));
  assert.match(offered, /The agent stopped without answering/);
  // The action says it asks the agent (a sent message), not "show more".
  assert.match(offered, /<button[^>]*turn-incomplete-continue[^>]*>Ask it to continue</);
  // Not the newest row any more: no Continue.
  assert.doesNotMatch(renderToStaticMarkup(createElement(TurnIncompleteNotice, { notice: empty })), /<button/);

  const calls: unknown[][] = [];
  await continueIncompleteTurn(async (...args: unknown[]) => { calls.push(args); return true; }, "s1");
  assert.equal(CONTINUE_PROMPT, "Continue");
  assert.deepEqual(calls, [["Continue", undefined, undefined, { targetSessionId: "s1" }]]);
  assert.equal((calls[0]![3] as Record<string, unknown>).hiddenUserMessage, undefined);
});

test("the agent's status line names a running call exactly as its timeline row does", async () => {
  const { liveActionOf } = await import("../src/liveAction.ts");
  const { executionPresentation, executionSummaryWords } = await import("../src/execution.ts");
  const call = { kind: "tool" as const, id: "c1", callId: "c1", eventSeq: 3, tool: "bash", input: { command: "npm test -- --runInBand", description: "Run the full test suite" }, status: "running" as const, time: 0 };
  const words = executionSummaryWords(executionPresentation(call));
  const model = { messages: [call], tasks: null, subagents: null } as unknown as Parameters<typeof liveActionOf>[0];
  assert.equal(liveActionOf(model), `${words.title} · ${words.preview}`);
  assert.doesNotMatch(liveActionOf(model), /Bash/, "never the raw tool name beside the row's kind label");
});

test("Keep running: the button shows only in the silence countdown, a kept call reads its own line, the ceiling has no button", () => {
  progress.clearToolProgress();
  const now = 10_000_000;
  withNow(now, () => {
    const base = { sessionId: "s1", callId: "c1" };
    // Before the countdown: no button.
    progress.noteToolProgress("s1", "c1", now - 6_000);
    assert.doesNotMatch(renderToStaticMarkup(createElement(ToolPulseLine, { ...base, startedAt: now - 192_000 })), /tool-pulse-keep/);
    // Countdown: ghost button with an accessible name, after the text.
    const countdown = { ...base, startedAt: now - 530_000 };
    progress.noteToolProgress("s1", "c1", now - 505_000);
    const line = renderToStaticMarkup(createElement(ToolPulseLine, countdown));
    assert.match(line, /Polyth stops it in 1m 35s unless it prints something.*<button[^>]*tool-pulse-keep[^>]*aria-label="Keep running: [^"]*"[^>]*>.*Keep running/s);
    // Kept: no countdown, no button, the kept line.
    const kept = renderToStaticMarkup(createElement(ToolPulseLine, { ...countdown, kept: true }));
    assert.match(kept, />No output for 8m 25s · kept running</);
    assert.doesNotMatch(kept, /tool-pulse-keep|Polyth stops it|<button/);
    assert.match(renderToStaticMarkup(createElement(ToolPulseInline, { ...countdown, kept: true })), />kept running</);
    // A judge kept it: the same line says so, so nobody thinks they pressed it.
    assert.match(renderToStaticMarkup(createElement(ToolPulseLine, { ...countdown, kept: true, keptBy: "judge" })), />No output for 8m 25s · a judge kept it running</);
    assert.match(renderToStaticMarkup(createElement(ToolPulseInline, { ...countdown, kept: true, keptBy: "judge" })), />kept by a judge</);
    // Ceiling (from 50 minutes): every call, kept or not, no button.
    const late = { ...base, startedAt: now - 55 * 60_000 };
    for (const keptFlag of [false, true]) {
      const ceiling = renderToStaticMarkup(createElement(ToolPulseLine, { ...late, kept: keptFlag }));
      assert.match(ceiling, />Polyth stops it in 5m: commands run at most 60 minutes</);
      assert.doesNotMatch(ceiling, /<button|tool-pulse-keep/);
    }
    assert.match(renderToStaticMarkup(createElement(ToolPulseInline, { ...late })), />auto-stop in 5m</);
  });
  progress.clearToolProgress();
});

test("Keep running beside the block's Stop: a collapsed or single-call block has an action in the countdown too", async () => {
  progress.clearToolProgress();
  const { ToolKeepRunning } = await import("../src/components/ToolPulse.tsx");
  const now = 10_000_000;
  withNow(now, () => {
    const base = { sessionId: "s1", callId: "c1", onKept: () => {} };
    // A harness without progress frames: quiet counts from the start.
    assert.equal(renderToStaticMarkup(createElement(ToolKeepRunning, { ...base, startedAt: now - 7 * 60_000 })), "");
    const countdown = renderToStaticMarkup(createElement(ToolKeepRunning, { ...base, startedAt: now - 8.5 * 60_000 }));
    assert.match(countdown, /<button[^>]*activity-keep-running[^>]*aria-label="Keep running: [^"]*"[^>]*>.*Keep running/s);
    assert.doesNotMatch(countdown, /ui-btn--ghost/, "a bordered button beside Stop, not ghost text");
    assert.equal(renderToStaticMarkup(createElement(ToolKeepRunning, { ...base, startedAt: now - 8.5 * 60_000, kept: true })), "");
    assert.equal(renderToStaticMarkup(createElement(ToolKeepRunning, { ...base, startedAt: now - 55 * 60_000 })), "", "no button at the ceiling");
    assert.equal(renderToStaticMarkup(createElement(ToolKeepRunning, { ...base, sessionId: null, startedAt: now - 8.5 * 60_000 })), "");
  });
  const { readFileSync } = await import("node:fs");
  const timeline = readFileSync(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8");
  const slot = timeline.slice(timeline.indexOf('className="activity-live-stop"'));
  assert.ok(slot.indexOf("<ToolKeepRunning") > 0 && slot.indexOf("<ToolKeepRunning") < slot.indexOf('className="execution-stop"'),
    "the block's live slot carries Keep running, before Stop so Stop never moves");
  progress.clearToolProgress();
});

test("a call waiting on a person's card: the same correlation the server's watchdog pause uses", () => {
  const vault = "mcp__polyth-agent-tools__polyth_credential_vault_run";
  const base = [
    ev(1, "turn/started", { turnId: "t1" }, "sa"),
    ev(2, "tool/started", { callId: "c1", tool: vault, input: {} }, "sa"),
    ev(3, "tool/started", { callId: "c2", tool: "bash", input: {} }, "sa"),
    ev(4, "permission/requested", { requestId: "pkg_1", permission: "package-tool", patterns: ["secure-safe.credential-vault-run"], tool: "polyth_credential_vault_run" }, "sa"),
  ];
  // Package approvals correlate by the agent tool's name, MCP prefix stripped.
  assert.equal(toolAwaiting(base, "sa", "c1"), "approval");
  assert.equal(toolAwaiting(base, "sa", "c2"), null, "an unrelated call keeps its countdown");
  // Answered or expired: the watchdog runs again, so does the countdown.
  assert.equal(toolAwaiting([...base, ev(5, "permission/resolved", { requestId: "pkg_1", reply: "once" }, "sa")], "sa", "c1"), null);
  assert.equal(toolAwaiting([...base, ev(5, "permission/expired", { requestId: "pkg_1" }, "sa")], "sa", "c1"), null);
  // A parent's mirror of a child's card shelters nothing here.
  const mirrored = [base[0]!, base[1]!, ev(4, "permission/requested", { ...(base[3]!.data as object), sourceSessionId: "child" }, "sa")];
  assert.equal(toolAwaiting(mirrored, "sa", "c1"), null);
  // A card of an earlier turn does not belong to this turn's call.
  assert.equal(toolAwaiting([...base, ev(5, "turn/stopped", { turnId: "t1" }, "sa"), ev(6, "turn/started", { turnId: "t2" }, "sa"), ev(7, "tool/started", { callId: "c1", tool: vault, input: {} }, "sa")], "sa", "c1"), null);
  // Native approvals correlate by call id; questions and Vault forms ask for an answer.
  assert.equal(toolAwaiting([base[0]!, base[2]!, ev(4, "permission/requested", { requestId: "c2", permission: "bash", patterns: [] }, "sa")], "sa", "c2"), "approval");
  assert.equal(toolAwaiting([base[0]!, ev(2, "tool/started", { callId: "q1", tool: "question", input: {} }, "sa"), ev(3, "question/asked", { requestId: "r1", questions: [] }, "sa")], "sa", "q1"), "answer");
  assert.equal(toolAwaiting([base[0]!, ev(2, "tool/started", { callId: "v1", tool: "mcp__polyth-agent-tools__polyth_credential_vault_request", input: {} }, "sa"), ev(3, "secret/requested", { requestId: "vault_1", handle: "H", label: "L", origin: "agent-tool", tool: "polyth_credential_vault_request" }, "sa")], "sa", "v1"), "answer");
});

test("waiting on a person: no auto-stop countdown, no Keep running, the wait said in place", () => {
  progress.clearToolProgress();
  const now = Date.now();
  const startedAt = now - 38 * 60_000;
  applyEvents([
    ev(1, "turn/started", { turnId: "t1" }, "sw", startedAt),
    ev(2, "tool/started", { callId: "cv", tool: "polyth_credential_vault_run", input: {} }, "sw", startedAt),
    ev(3, "permission/requested", { requestId: "pkg_w", permission: "package-tool", patterns: [], tool: "polyth_credential_vault_run" }, "sw", startedAt),
  ]);
  const props = { sessionId: "sw", callId: "cv", startedAt };
  const inline = renderToStaticMarkup(createElement(ToolPulseInline, props));
  assert.match(inline, />38m<.*>waiting for approval</);
  assert.doesNotMatch(inline, /auto-stop|tool-pulse--stopping/);
  const line = renderToStaticMarkup(createElement(ToolPulseLine, props));
  assert.match(line, /Waiting for approval · Polyth won(&#x27;|')t stop it while it waits/);
  assert.doesNotMatch(line, /Keep running|stops it in/);
  assert.equal(renderToStaticMarkup(createElement(ToolKeepRunning, { ...props, onKept: () => {} })), "");
  // Near the hard ceiling too: the server holds that clock while it waits.
  const late = { ...props, startedAt: now - 55 * 60_000 };
  assert.doesNotMatch(renderToStaticMarkup(createElement(ToolPulseInline, late)), /auto-stop/);
  // Answered: the ordinary countdown returns.
  applyEvents([ev(4, "permission/resolved", { requestId: "pkg_w", reply: "once" }, "sw", now)]);
  assert.match(renderToStaticMarkup(createElement(ToolPulseInline, props)), /auto-stop in/);
});

test("tool/keep-running marks the running call; old or unknown calls are ignored", () => {
  const model = buildModel([
    ev(1, "user/message", { text: "go" }),
    ev(2, "tool/started", { callId: "c1", tool: "bash", input: {} }),
    ev(3, "tool/keep-running", { callId: "c1", byUserId: "u1" }),
    ev(4, "tool/keep-running", { callId: "ghost" }),
    ev(5, "tool/keep-running", {}),
  ]);
  const tools = model.messages.filter((m) => m.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal((tools[0] as { keptRunning?: boolean }).keptRunning, true);
  assert.equal((tools[0] as { keptBy?: string }).keptBy, undefined, "a person's keep names no judge");
  const judged = buildModel([
    ev(1, "user/message", { text: "go" }),
    ev(2, "tool/started", { callId: "c1", tool: "bash", input: {} }),
    ev(3, "tool/keep-running", { callId: "c1", via: "judge", useId: "judges.quiet-command" }),
    ev(4, "tool/keep-running", { callId: "c1", byUserId: "u1" }),
  ]);
  const judgedTool = judged.messages.find((m) => m.kind === "tool") as { keptRunning?: boolean; keptBy?: string };
  assert.equal(judgedTool.keptRunning, true);
  assert.equal(judgedTool.keptBy, "judge", "the first keep wins; a later person keep is a no-op on the server too");
  const before = buildModel([ev(1, "user/message", { text: "go" }), ev(2, "tool/started", { callId: "c1", tool: "bash", input: {} })]);
  assert.equal((before.messages.find((m) => m.kind === "tool") as { keptRunning?: boolean }).keptRunning, undefined);
});
