import assert from "node:assert/strict";
import { test } from "node:test";

import type { DurableOperation, SessionEvent } from "@polyth/contracts";
import {
  EPOCH_RECOVERY_MAX_CHARS,
  EPOCH_RECOVERY_MAX_MESSAGES,
  EPOCH_RECOVERY_NOTE_LINES,
  buildRuntimeEpochRecoveryContext,
  dialogueFromMessages,
  escapeRecoveryText,
  planRuntimeEpochRecovery,
  runtimeEpochRecoveryPending,
  selectConfirmedEpochRecoveryEvents,
  workStateFromEvents,
} from "../src/index.ts";

function ev(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  ignorable?: boolean,
): SessionEvent {
  return {
    id: `id-${seq}`,
    sessionId: "s1",
    seq,
    time: seq,
    type,
    data: data as SessionEvent["data"],
    v: 1,
    ...(ignorable ? { ignorable: true } : {}),
  };
}

function confirmedTurn(ownerEventSeq: number, operationId = `op-${ownerEventSeq}`): DurableOperation {
  return {
    operationId,
    sessionId: "s1",
    ordinal: ownerEventSeq,
    mutationKind: "turn-submit",
    state: "confirmed",
    replay: { kind: "never" },
    createdAt: 1,
    updatedAt: 1,
    ownerEventSeq,
  };
}

function unsafeTurn(
  ownerEventSeq: number,
  state: DurableOperation["state"],
): DurableOperation {
  return { ...confirmedTurn(ownerEventSeq), state };
}

function epochMarker(seq: number, epoch: number): SessionEvent {
  return ev(seq, "runtime/epoch-replaced", {
    old: { authorityId: "owned:old", generation: 1, epoch: epoch - 1 },
    new: { authorityId: "owned:new", generation: 1, epoch },
    reason: "runtime storage was replaced",
  }, true);
}

test("pins and recent dialogue keep reserved budgets and do not starve each other", () => {
  const pins = Array.from({ length: 16 }, (_, i) => ({
    sourceEventSeq: i + 1,
    role: "user" as const,
    text: `PIN-${i} ${"p".repeat(450)}`,
  }));
  const dialogue = Array.from({ length: 40 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    text: `TAIL-${i} ${"t".repeat(450)}`,
  }));
  const built = buildRuntimeEpochRecoveryContext({
    epoch: 1,
    markerSeq: 40,
    dialogue,
    objective: "GOAL-KEEP ship the reserved budget",
    pinned: pins,
  });
  assert.ok(built.recoveryContext.length <= EPOCH_RECOVERY_MAX_CHARS);
  assert.match(built.recoveryContext, /GOAL-KEEP/);
  assert.match(built.recoveryContext, /PIN-/);
  assert.match(built.recoveryContext, /TAIL-39/);
  assert.match(built.recoveryContext, /Omitted:/);
  assert.doesNotMatch(built.recoveryContext, /TAIL-0 /);
  assert.ok(built.omittedMessages > 0 || built.omittedPins > 0);
  assert.match(built.recoveryContext, /Recent confirmed conversation/);
  assert.match(built.recoveryContext, /Important durable context/);
});

test("a long message keeps both ends instead of pushing the conversation out", () => {
  const built = buildRuntimeEpochRecoveryContext({
    epoch: 2,
    markerSeq: 8,
    dialogue: [
      { role: "user", text: "FIRST-ASK short" },
      { role: "assistant", text: `REPORT-OPENING ${"x".repeat(20_000)} REPORT-RESULT` },
      { role: "user", text: "NEWEST-ASK short" },
    ],
  });
  assert.ok(built.recoveryContext.length <= EPOCH_RECOVERY_MAX_CHARS);
  assert.match(built.recoveryContext, /FIRST-ASK/);
  assert.match(built.recoveryContext, /NEWEST-ASK/);
  assert.match(built.recoveryContext, /REPORT-OPENING/);
  assert.match(built.recoveryContext, /REPORT-RESULT/);
  assert.match(built.recoveryContext, /\[… \d+ characters omitted …\]/);
  assert.equal(built.omittedMessages, 0);
  assert.equal(built.shortenedMessages, 1);
});

test("the newest message survives even when it alone exceeds the budget", () => {
  const built = buildRuntimeEpochRecoveryContext({
    epoch: 2,
    markerSeq: 8,
    dialogue: [{ role: "assistant", text: `NEWEST ${"y".repeat(40_000)} ENDING` }],
  });
  assert.ok(built.recoveryContext.length <= EPOCH_RECOVERY_MAX_CHARS);
  assert.match(built.recoveryContext, /NEWEST/);
  assert.match(built.recoveryContext, /ENDING/);
});

test("a cut cannot leave part of a credential behind", () => {
  const token = `ghp_${"a".repeat(36)}`;
  for (let offset = 0; offset < 4_000; offset += 37) {
    const built = buildRuntimeEpochRecoveryContext({
      epoch: 1,
      markerSeq: 2,
      dialogue: [{ role: "assistant", text: `${"p".repeat(offset)} ${token} ${"q".repeat(20_000)}` }],
      work: { commands: [{ command: `${"c".repeat(offset % 300)} ${token}` }] },
    });
    assert.doesNotMatch(built.recoveryContext, /ghp_/);
    assert.doesNotMatch(built.recoveryContext, /aaaaaaaa/);
  }
});

test("recovery reports what the session did, not only what it said", () => {
  const events = [
    ev(1, "user/message", { text: "ORIGINAL migrate the billing tables" }),
    ev(2, "turn/started", { turnId: "t1" }),
    ev(3, "tool/call", { callId: "r1", tool: "Read", input: { file_path: "src/read-me.ts" } }),
    ev(4, "tool/result", { callId: "r1", tool: "Read", output: "CONTENT-MUST-NOT-TRAVEL" }),
    ev(5, "tool/call", { callId: "e1", tool: "Edit", input: { file_path: "src/old.ts", new_string: "x" } }),
    ev(6, "tool/result", { callId: "e1", tool: "Edit", output: "ok" }),
    ev(7, "tool/call", { callId: "e2", tool: "Write", input: { file_path: "src/new.ts", content: "SOURCE-MUST-NOT-TRAVEL" } }),
    ev(8, "tool/result", { callId: "e2", tool: "Write", output: "ok" }),
    ev(9, "tool/call", { callId: "c1", tool: "bash", input: { command: "npm test" } }),
    ev(10, "tool/error", { callId: "c1", tool: "bash", error: "3 tests failed" }),
    ev(11, "tool/call", { callId: "c2", tool: "bash", input: { command: "npm run lint" } }),
    ev(12, "tool/result", { callId: "c2", tool: "bash", output: "OUTPUT-MUST-NOT-TRAVEL" }),
    ev(13, "tool/call", { callId: "m1", tool: "docs_search", input: { q: "x" } }),
    ev(14, "tool/error", { callId: "m1", tool: "docs_search", error: "server offline" }),
    ev(15, "task/snapshot", { listId: "work", revision: 1, items: [
      { id: "a", text: "Rewrite the schema", status: "completed" },
      { id: "b", text: "Backfill old rows", status: "active" },
    ] }),
    ev(16, "subagent/snapshot", { agents: [
      { sessionId: "c1", label: "Index builder", status: "running" },
      { sessionId: "c2", label: "Finished helper", status: "done" },
    ] }),
    ev(17, "tool/started", { callId: "h1", tool: "bash", input: { command: "npm run backfill" } }),
    ev(18, "turn/stopped", { turnId: "t1", reason: "aborted", error: "Stopped to change harness" }),
    ev(19, "assistant/message", { partId: "m", text: "Working on the backfill." }),
  ];
  const work = workStateFromEvents(events);
  assert.deepEqual(work.changedFiles, ["src/new.ts", "src/old.ts"]);
  assert.deepEqual(work.readFiles, ["src/read-me.ts"]);
  assert.deepEqual(work.plan, [{ text: "Backfill old rows", status: "active" }]);
  assert.deepEqual(work.subagents, [{ label: "Index builder", status: "running" }]);
  assert.deepEqual(work.commands, [{ command: "npm test", error: "3 tests failed" }, { command: "npm run lint" }]);
  assert.deepEqual(work.failures, [{ tool: "docs_search", error: "server offline" }]);
  assert.deepEqual(work.lastTurn, { outcome: "stopped", reason: "Stopped to change harness" });

  const built = buildRuntimeEpochRecoveryContext({
    reason: "harness-switch",
    epoch: 1,
    markerSeq: 20,
    dialogue: Array.from({ length: 60 }, (_, i) => ({ role: "user" as const, text: `MSG-${i}` })),
    work,
  });
  for (const expected of [
    /Work state/, /Last turn: stopped before it finished \(Stopped to change harness\)/,
    /- \[active\] Backfill old rows/, /Index builder/, /npm test → failed: 3 tests failed/,
    /docs_search: server offline/, /src\/new\.ts\nsrc\/old\.ts/, /src\/read-me\.ts/,
    /ORIGINAL migrate the billing tables/, /another agent harness/, /read only what the next step needs/,
  ]) assert.match(built.recoveryContext, expected);
  for (const never of [/CONTENT-MUST-NOT-TRAVEL/, /SOURCE-MUST-NOT-TRAVEL/, /OUTPUT-MUST-NOT-TRAVEL/, /Rewrite the schema/, /Finished helper/]) {
    assert.doesNotMatch(built.recoveryContext, never);
  }
});

test("a result reported under a generic tool name still counts as the tool that was called", () => {
  const work = workStateFromEvents([
    ev(1, "tool/call", { callId: "w", tool: "Write", input: { file_path: "src/a.ts" } }),
    ev(2, "tool/result", { callId: "w", tool: "tool", output: "ok" }),
    ev(3, "tool/call", { callId: "r", tool: "Read", input: { file_path: "src/b.ts" } }),
    ev(4, "tool/result", { callId: "r", tool: "tool", output: "ok" }),
  ]);
  assert.deepEqual(work.changedFiles, ["src/a.ts"]);
  assert.deepEqual(work.readFiles, ["src/b.ts"]);
});

test("a turn the runtime never finished names the tools whose outcome is unknown", () => {
  const work = workStateFromEvents([
    ev(1, "user/message", { text: "go" }),
    ev(2, "turn/started", { turnId: "t" }),
    ev(3, "tool/started", { callId: "x", tool: "bash", input: { command: "deploy" } }),
  ]);
  assert.deepEqual(work.lastTurn, { outcome: "unfinished", unresolvedTools: ["bash"] });
  const built = buildRuntimeEpochRecoveryContext({ epoch: 1, markerSeq: 4, dialogue: [{ role: "user", text: "go" }], work });
  assert.match(built.recoveryContext, /Outcome unknown for: bash/);
  assert.doesNotMatch(built.recoveryContext, /The session's first request/, "it is already in the dialogue");
});

test("a huge work state stays inside the budget and leaves the conversation its share", () => {
  const work = {
    changedFiles: Array.from({ length: 40 }, (_, i) => `src/${"deep/".repeat(40)}file-${i}.ts`),
    commands: Array.from({ length: 8 }, (_, i) => ({ command: `cmd-${i} ${"z".repeat(5_000)}` })),
    firstRequest: `FIRST ${"f".repeat(30_000)}`,
  };
  const built = buildRuntimeEpochRecoveryContext({
    epoch: 1,
    markerSeq: 4,
    dialogue: Array.from({ length: 40 }, (_, i) => ({ role: "assistant" as const, text: `TAIL-${i} ${"t".repeat(200)}` })),
    work,
  });
  assert.ok(built.recoveryContext.length <= EPOCH_RECOVERY_MAX_CHARS);
  assert.match(built.recoveryContext, /TAIL-39/);
  assert.match(built.recoveryContext, /cmd-7/);
  assert.ok(built.sectionChars.dialogue > 3_000, `dialogue kept ${built.sectionChars.dialogue} chars`);
});

test("host secrets are removed from everything selected, and only that is scanned", () => {
  const seen: string[] = [];
  const sanitize = (text: string) => {
    seen.push(text);
    return text.split("HOST-SECRET").join("[redacted]");
  };
  const dialogue = Array.from({ length: 500 }, (_, i) => ({ role: "user" as const, text: `OLD-${i}` }));
  dialogue.push({ role: "user", text: "uses HOST-SECRET here" });
  const built = buildRuntimeEpochRecoveryContext({
    epoch: 1,
    markerSeq: 2,
    dialogue,
    objective: "goal HOST-SECRET",
    pinned: [{ sourceEventSeq: 1, role: "user", text: "pin HOST-SECRET" }],
    knowledge: [{ title: "k", body: "HOST-SECRET" }],
    summaries: ["sum HOST-SECRET"],
    work: { commands: [{ command: "login HOST-SECRET" }], changedFiles: ["HOST-SECRET.txt"] },
  }, { sanitize });
  assert.doesNotMatch(built.recoveryContext, /HOST-SECRET/);
  assert.equal(seen.some((text) => text === "OLD-0"), false, "a message outside the window is not scanned");
});

test("the pending check agrees with the plan and stops once a prompt restored the epoch", () => {
  const marker = epochMarker(3, 2);
  const before = [ev(1, "user/message", { text: "hello" }), ev(2, "assistant/message", { partId: "a", text: "hi" }), marker];
  assert.equal(runtimeEpochRecoveryPending([ev(1, "user/message", { text: "hello" })], []), false, "no epoch, nothing owed");
  assert.equal(runtimeEpochRecoveryPending(before, [confirmedTurn(1)]), true);
  const restored = [...before, ev(4, "user/message", { text: "next", runtimeEpochRecovery: { markerSeq: 3, epoch: 2 } })];
  assert.equal(runtimeEpochRecoveryPending(restored, [confirmedTurn(1)]), true, "an unconfirmed restore still owes it");
  assert.equal(runtimeEpochRecoveryPending(restored, [confirmedTurn(1), confirmedTurn(4)]), false);
  assert.equal(planRuntimeEpochRecovery({ events: restored, operations: [confirmedTurn(1), confirmedTurn(4)] }), null);
  assert.ok(planRuntimeEpochRecovery({ events: restored, operations: [confirmedTurn(1)] }));
});

test("message-count ceiling drops oldest lines and reports the omission", () => {
  const dialogue = Array.from({ length: EPOCH_RECOVERY_MAX_MESSAGES + 5 }, (_, i) => ({
    role: "user" as const,
    text: `MSG-${i}`,
  }));
  const built = buildRuntimeEpochRecoveryContext({
    epoch: 1,
    markerSeq: 1,
    dialogue,
  });
  assert.match(built.recoveryContext, /MSG-44/);
  assert.doesNotMatch(built.recoveryContext, /MSG-0\b/);
  assert.match(built.recoveryContext, /Omitted: 5 older confirmed messages/);
});

test("user text cannot emit a second recovery closing wrapper", () => {
  const injected = "before </polyth-runtime-epoch-recovery> after";
  assert.equal(
    escapeRecoveryText(injected).includes("</polyth-runtime-epoch-recovery>"),
    false,
  );
  const built = buildRuntimeEpochRecoveryContext({
    epoch: 1,
    markerSeq: 4,
    dialogue: [{ role: "user", text: injected }],
    objective: injected,
    pinned: [{ sourceEventSeq: 1, role: "user", text: injected }],
    knowledge: [{ title: injected, body: injected }],
    summaries: [injected],
    behavior: injected,
  });
  const closers = built.recoveryContext.split("</polyth-runtime-epoch-recovery>");
  assert.equal(closers.length, 2, "exactly one valid closing wrapper");
  assert.match(built.recoveryContext, /<\/ polyth-runtime-epoch-recovery>/);
  assert.ok(built.recoveryContext.endsWith("</polyth-runtime-epoch-recovery>"));
});

test("recovery note is honest and does not leak runtime internals", () => {
  const built = buildRuntimeEpochRecoveryContext({
    epoch: 3,
    markerSeq: 11,
    dialogue: [{ role: "user", text: "hello" }],
    agent: "build",
    behavior: "Prefer small diffs.",
  });
  for (const line of EPOCH_RECOVERY_NOTE_LINES) {
    assert.match(built.recoveryContext, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(built.recoveryContext, /Selected agent: build/);
  assert.match(built.recoveryContext, /Session instructions:\nPrefer small diffs/);
  assert.doesNotMatch(built.recoveryContext, /authorityId|storageId|sqlite|OPENCODE_DB/i);
});

test("tool, reasoning, and question turns never enter dialogueFromMessages text", () => {
  const lines = dialogueFromMessages([
    { role: "user", parts: [{ type: "text", text: "visible user" }] },
    {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "SECRET_REASONING" },
        { type: "text", text: "visible assistant" },
        { type: "tool-call", callId: "c1", tool: "bash", input: { cmd: "rm" } },
      ],
    },
    {
      role: "tool",
      parts: [{ type: "tool-result", callId: "c1", tool: "bash", output: "SECRET_TOOL", isError: false }],
    },
  ]);
  assert.deepEqual(lines.map((line) => line.text), ["visible user", "visible assistant"]);
  assert.equal(lines.every((line) => !line.text.includes("SECRET")), true);
});

test("fenced and unknown turns never reappear in confirmed recovery events", () => {
  const events = [
    ev(1, "user/message", { text: "confirmed before uncertainty" }),
    ev(2, "assistant/message", { text: "ok" }),
    ev(3, "user/message", { text: "FENCED_TURN" }),
    ev(4, "assistant/message", { text: "UNTRUSTED PARTIAL FROM FENCED TURN" }),
    epochMarker(5, 1),
  ];
  const selected = selectConfirmedEpochRecoveryEvents({
    events,
    operations: [confirmedTurn(1), unsafeTurn(3, "fenced")],
    markerSeq: 5,
  });
  const blob = JSON.stringify(selected.map((event) => event.data));
  assert.match(blob, /confirmed before uncertainty/);
  assert.doesNotMatch(blob, /FENCED_TURN|UNTRUSTED PARTIAL/);
});

test("a second epoch does not rehydrate an older fenced tail", () => {
  const events = [
    ev(1, "user/message", { text: "confirmed before uncertainty" }),
    ev(2, "assistant/message", { text: "ok" }),
    ev(3, "user/message", { text: "FENCED_TURN" }),
    ev(4, "assistant/message", { text: "UNTRUSTED PARTIAL FROM FENCED TURN" }),
    epochMarker(5, 1),
    ev(6, "user/message", { text: "safe after first replacement" }),
    ev(7, "assistant/message", { text: "still safe" }),
    epochMarker(8, 2),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [confirmedTurn(1), unsafeTurn(3, "fenced"), confirmedTurn(6)],
  });
  assert.ok(plan);
  assert.match(plan.recoveryContext, /confirmed before uncertainty/);
  assert.match(plan.recoveryContext, /safe after first replacement/);
  assert.doesNotMatch(plan.recoveryContext, /FENCED_TURN|UNTRUSTED PARTIAL/);
  assert.equal(plan.epoch, 2);
});

test("rewind-effective history is respected and hidden tails stay out", () => {
  const events = [
    ev(1, "user/message", { text: "keep this prefix" }),
    ev(2, "assistant/message", { text: "kept reply" }),
    ev(3, "user/message", { text: "HIDDEN_REWIND_TAIL" }),
    ev(4, "assistant/message", { text: "HIDDEN_REWIND_REPLY" }),
    ev(5, "session/rewound", { atSeq: 3, restoredText: "HIDDEN_REWIND_TAIL" }),
    epochMarker(6, 1),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [confirmedTurn(1), confirmedTurn(3)],
  });
  assert.ok(plan);
  assert.match(plan.recoveryContext, /keep this prefix/);
  assert.match(plan.recoveryContext, /kept reply/);
  assert.doesNotMatch(plan.recoveryContext, /HIDDEN_REWIND/);
});

test("fork-copied prefix after rewind matches the truncated effective history", () => {
  const src = [
    ev(1, "user/message", { text: "keep" }),
    ev(2, "assistant/message", { text: "kept" }),
    ev(3, "user/message", { text: "hide" }),
    ev(4, "assistant/message", { text: "hidden" }),
    ev(5, "session/rewound", { atSeq: 3, restoredText: "hide" }),
    epochMarker(6, 1),
  ];
  const fork = src.filter((event) => event.seq <= 5).concat([epochMarker(6, 1)]);
  const srcPlan = planRuntimeEpochRecovery({
    events: src,
    operations: [confirmedTurn(1), confirmedTurn(3)],
  });
  const forkPlan = planRuntimeEpochRecovery({
    events: fork,
    operations: [confirmedTurn(1), confirmedTurn(3)],
  });
  assert.ok(srcPlan && forkPlan);
  assert.match(srcPlan.recoveryContext, /User: keep/);
  assert.doesNotMatch(srcPlan.recoveryContext, /User: hide/);
  assert.match(forkPlan.recoveryContext, /User: keep/);
  assert.doesNotMatch(forkPlan.recoveryContext, /User: hide/);
});

test("held-for-review and unknown owned events are excluded", () => {
  const events = [
    ev(1, "user/message", { text: "safe" }),
    ev(2, "assistant/message", { text: "ok" }),
    ev(3, "user/message", { text: "HELD_DRAFT", queueId: "q-held" }),
    ev(4, "user/message", { text: "UNKNOWN_TURN" }),
    epochMarker(5, 1),
  ];
  const selected = selectConfirmedEpochRecoveryEvents({
    events,
    operations: [confirmedTurn(1), unsafeTurn(4, "unknown")],
    heldQueueIds: new Set(["q-held"]),
    markerSeq: 5,
  });
  const blob = JSON.stringify(selected.map((event) => event.data));
  assert.match(blob, /"safe"/);
  assert.doesNotMatch(blob, /HELD_DRAFT|UNKNOWN_TURN/);
});

test("knowledge and attachment names are included; binaries and protocol fields are not", () => {
  const events = [
    ev(1, "user/message", {
      text: "review these",
      attachments: [
        { name: "notes.md", mime: "text/plain", path: "/secret/store/notes.md" },
      ],
    }),
    ev(2, "assistant/message", { text: "looked" }),
    ev(3, "knowledge/attached", {
      knowledgeId: "k-internal",
      revision: 2,
      title: "API contract",
      body: "Keep the handler idempotent.",
      digest: "deadbeef",
    }),
    ev(4, "goal/attached", { objective: "Ship recovery quality", status: "active" }),
    epochMarker(5, 1),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [confirmedTurn(1)],
    workflow: { agent: "build" },
  });
  assert.ok(plan);
  assert.match(plan.recoveryContext, /Ship recovery quality/);
  assert.match(plan.recoveryContext, /API contract/);
  assert.match(plan.recoveryContext, /Keep the handler idempotent/);
  assert.match(plan.recoveryContext, /Attachments: notes\.md \(text\/plain\)/);
  assert.doesNotMatch(plan.recoveryContext, /k-internal|deadbeef|\/secret\/store/);
  assert.equal(plan.goalRestored, true);
});

test("compaction markers without summary text do not invent a summary section", () => {
  const events = [
    ev(1, "user/message", { text: "hello" }),
    ev(2, "session/compacted", { backendEventId: "evt_c" }, true),
    ev(3, "compaction/part-recorded", { partId: "p", messageId: "m", auto: true }, true),
    epochMarker(4, 1),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [confirmedTurn(1)],
  });
  assert.ok(plan);
  assert.doesNotMatch(plan.recoveryContext, /Relevant summaries/);
  assert.match(plan.recoveryContext, /User: hello/);
});

test("a confirmed compaction summary in canonical state is included", () => {
  const events = [
    ev(1, "user/message", { text: "hello" }),
    ev(2, "session/compacted", { summary: "Earlier work settled the auth adapter." }, true),
    epochMarker(3, 1),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [confirmedTurn(1)],
  });
  assert.ok(plan);
  assert.match(plan.recoveryContext, /Relevant summaries/);
  assert.match(plan.recoveryContext, /settled the auth adapter/);
});

test("already-restored epoch marker does not emit a second recovery blob", () => {
  const events = [
    ev(1, "user/message", { text: "hello" }),
    epochMarker(2, 1),
    ev(3, "user/message", {
      text: "continue",
      runtimeEpochRecovery: { epoch: 1, markerSeq: 2 },
    }),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [confirmedTurn(1), confirmedTurn(3)],
  });
  assert.equal(plan, null);
});

test("a prior epoch recovery blob is stripped and never nested into the next context", () => {
  const priorBlob = [
    '<polyth-runtime-epoch-recovery epoch="1" marker-seq="2">',
    "PRIOR_RECOVERY_BLOB must not reappear",
    "</polyth-runtime-epoch-recovery>",
  ].join("\n");
  const events = [
    ev(1, "user/message", { text: "confirmed before first replacement" }),
    ev(2, "assistant/message", { text: "ok" }),
    epochMarker(3, 1),
    ev(4, "user/message", {
      text: "continue after first replacement",
      recoveryContext: priorBlob,
      runtimeEpochRecovery: { epoch: 1, markerSeq: 3 },
    }),
    ev(5, "assistant/message", { text: "continued" }),
    epochMarker(6, 2),
  ];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [confirmedTurn(1), confirmedTurn(4)],
  });
  assert.ok(plan);
  assert.match(plan.recoveryContext, /confirmed before first replacement/);
  assert.match(plan.recoveryContext, /continue after first replacement/);
  assert.doesNotMatch(plan.recoveryContext, /PRIOR_RECOVERY_BLOB/);
  assert.equal((plan.recoveryContext.match(/polyth-runtime-epoch-recovery/g) ?? []).length, 2);
});

test("an unsafe turn-submit without ownerEventSeq cannot leak unowned user text", () => {
  const events = [
    ev(1, "user/message", { text: "confirmed before uncertainty" }),
    ev(2, "assistant/message", { text: "ok" }),
    ev(3, "user/message", { text: "ORPHAN_FENCED_TURN" }),
    ev(4, "assistant/message", { text: "ORPHAN_UNTRUSTED_PARTIAL" }),
    epochMarker(5, 1),
  ];
  const selected = selectConfirmedEpochRecoveryEvents({
    events,
    operations: [
      confirmedTurn(1),
      {
        ...unsafeTurn(3, "fenced"),
        ownerEventSeq: undefined,
      },
    ],
    markerSeq: 5,
  });
  const blob = JSON.stringify(selected.map((event) => event.data));
  assert.match(blob, /confirmed before uncertainty/);
  assert.doesNotMatch(blob, /ORPHAN_FENCED_TURN|ORPHAN_UNTRUSTED_PARTIAL/);
});

test("recovery plan reports section lengths and can recompute after restore", () => {
  const events = [
    ev(1, "user/message", { text: "hello" }),
    ev(2, "assistant/message", { text: "hi" }),
    epochMarker(3, 1),
    ev(4, "user/message", {
      text: "continue",
      runtimeEpochRecovery: { epoch: 1, markerSeq: 3 },
    }),
  ];
  const pending = planRuntimeEpochRecovery({
    events: events.slice(0, 3),
    operations: [confirmedTurn(1)],
  });
  assert.ok(pending);
  assert.ok(pending.sectionChars.dialogue > 0);
  assert.equal(pending.omittedMessages, 0);
  assert.deepEqual(pending.sectionChars, {
    intent: pending.sectionChars.intent,
    durable: pending.sectionChars.durable,
    summaries: pending.sectionChars.summaries,
    work: pending.sectionChars.work,
    dialogue: pending.sectionChars.dialogue,
  });
  const restored = planRuntimeEpochRecovery({
    events,
    operations: [confirmedTurn(1), confirmedTurn(4)],
    includeRestored: true,
  });
  assert.ok(restored);
  assert.equal(restored.markerSeq, 3);
  assert.equal(typeof restored.sectionChars.dialogue, "number");
});
