import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  activePinnedMessages,
  activeRewind,
  compactionRecoveryText,
  createStore,
  deriveMessages,
  latestCompletedExchange,
  rewindDraft,
  unrestoredCompactionSeq,
} from "@polyth/session";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "polyth-session-"));
}

function ev(seq: number, type: string, data: Record<string, unknown>, sessionId = "s1", ignorable?: boolean): SessionEvent {
  return { id: `id-${seq}`, sessionId, seq, time: seq, type, data: data as SessionEvent["data"], v: 1, ignorable };
}

test("append allocates monotonic seq and returns full event", async () => {
  const dir = freshDir();
  const store = createStore(join(dir, "t.db"));
  try {
    const e1 = await store.append("s1", "user/message", { text: "hi" });
    const e2 = await store.append("s1", "assistant/message", { text: "hello" });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.ok(e1.id); // uuid present
    assert.match(e1.id, /^[0-9a-f-]{36}$/);
    assert.equal(e1.sessionId, "s1");
    assert.equal(e1.type, "user/message");
    assert.equal(e1.v, 1);
    assert.equal(typeof e1.time, "number");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent appends (×20) yield unique dense seqs", async () => {
  const dir = freshDir();
  const store = createStore(join(dir, "t.db"));
  try {
    const evts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.append("s1", "user/message", { text: `m${i}` }),
      ),
    );
    const seqs = evts.map((e) => e.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(new Set(seqs).size, 20); // unique
    assert.equal(await store.latestSeq("s1"), 20);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("events(afterSeq) returns ordered, JSON-parsed events", async () => {
  const dir = freshDir();
  const store = createStore(join(dir, "t.db"));
  try {
    for (let i = 1; i <= 5; i++) {
      await store.append("s1", "user/message", { n: i });
    }
    const all = await store.events("s1");
    assert.equal(all.length, 5);
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(all[2]!.data, { n: 3 }); // JSON parsed

    const tail = await store.events("s1", 2);
    assert.deepEqual(tail.map((e) => e.seq), [3, 4, 5]);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("event tail and backward keyset pages are ascending without overlap or gaps", async () => {
  const dir = freshDir();
  const store = createStore(join(dir, "t.db"));
  try {
    for (let i = 1; i <= 8; i++) await store.append("s1", "user/message", { n: i });
    const tail = await store.events("s1", 0, { limit: 3 });
    const middle = await store.events("s1", 0, { beforeSeq: tail[0]!.seq, limit: 3 });
    const oldest = await store.events("s1", 0, { beforeSeq: middle[0]!.seq, limit: 3 });

    assert.deepEqual(tail.map((event) => event.seq), [6, 7, 8]);
    assert.deepEqual(middle.map((event) => event.seq), [3, 4, 5]);
    assert.deepEqual(oldest.map((event) => event.seq), [1, 2]);
    assert.deepEqual([...oldest, ...middle, ...tail].map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copyTo forks at a seq, re-sequencing into dst", async () => {
  const dir = freshDir();
  const store = createStore(join(dir, "t.db"));
  try {
    for (let i = 1; i <= 6; i++) {
      await store.append("src", "user/message", { n: i });
    }
    await store.copyTo("src", "fork", 4);
    const forked = await store.events("fork");
    assert.deepEqual(forked.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual(forked.map((e) => e.data), [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    // src untouched
    assert.equal((await store.events("src")).length, 6);
    // appending to fork continues after copied seqs
    const e = await store.append("fork", "assistant/message", { text: "done" });
    assert.equal(e.seq, 5);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveMessages from a realistic scripted event list", () => {
  const events: SessionEvent[] = [
    ev(1, "turn/started", { turnId: "t1" }), // not model-visible
    ev(2, "user/message", { text: "List files" }),
    ev(3, "assistant/chunk", { partId: "p1", text: "Sure, " }), // chunk: not in MODEL_VISIBLE_TYPES
    ev(4, "assistant/message", { partId: "p1", text: "Sure, running ls.", reasoning: "need to list" }),
    ev(5, "tool/call", { callId: "c1", tool: "list", input: { path: "." } }),
    ev(6, "tool/result", { callId: "c1", tool: "list", output: "a.txt\nb.txt" }),
    ev(7, "assistant/message", { partId: "p2", text: "Found 2 files." }),
    ev(8, "user/message", { text: "now rm a.txt" }),
    ev(9, "tool/call", { callId: "c2", tool: "rm", input: { path: "a.txt" } }),
    ev(10, "tool/error", { callId: "c2", tool: "rm", error: "permission denied" }),
    ev(11, "assistant/message", { partId: "p3", text: "Could not remove it." }),
  ];

  const msgs = deriveMessages(events);
  assert.deepEqual(msgs, [
    { role: "user", parts: [{ type: "text", text: "List files" }] },
    {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "need to list" },
        { type: "text", text: "Sure, running ls." },
        { type: "tool-call", callId: "c1", tool: "list", input: { path: "." } },
      ],
    },
    {
      role: "tool",
      parts: [{ type: "tool-result", callId: "c1", tool: "list", output: "a.txt\nb.txt", isError: false }],
    },
    { role: "assistant", parts: [{ type: "text", text: "Found 2 files." }] },
    { role: "user", parts: [{ type: "text", text: "now rm a.txt" }] },
    {
      role: "assistant",
      parts: [{ type: "tool-call", callId: "c2", tool: "rm", input: { path: "a.txt" } }],
    },
    {
      role: "tool",
      parts: [{ type: "tool-result", callId: "c2", tool: "rm", output: "permission denied", isError: true }],
    },
    { role: "assistant", parts: [{ type: "text", text: "Could not remove it." }] },
  ]);
});

test("deriveMessages: ignorable flag filters, consecutive same-role merges, questions", () => {
  const events: SessionEvent[] = [
    ev(1, "user/message", { text: "a" }),
    ev(2, "user/message", { text: "b" }), // merges into one user message
    ev(3, "assistant/message", { text: "ignored" }, "s1", true), // filtered
    ev(4, "question/asked", { requestId: "q1", questions: [{ text: "Continue?" }] }),
    ev(5, "question/answered", { requestId: "q1", answers: { go: "yes" } }),
  ];
  const msgs = deriveMessages(events);
  assert.deepEqual(msgs, [
    { role: "user", parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    { role: "assistant", parts: [{ type: "text", text: "Continue?" }] },
    { role: "user", parts: [{ type: "text", text: '{"go":"yes"}' }] },
  ]);
});

test("deriveMessages: reconciliation copies of finalized assistant parts are ignored", () => {
  const msgs = deriveMessages([
    ev(1, "user/message", { text: "hello" }),
    ev(2, "assistant/message", { partId: "p1", text: "hi" }),
    ev(3, "assistant/message", { partId: "p1", text: "hi" }),
  ]);
  assert.deepEqual(msgs, [
    { role: "user", parts: [{ type: "text", text: "hello" }] },
    { role: "assistant", parts: [{ type: "text", text: "hi" }] },
  ]);
});

test("latestCompletedExchange uses the last completed turn and excludes tools and older history", () => {
  const events: SessionEvent[] = [
    ev(1, "user/message", { text: "old request" }),
    ev(2, "turn/started", { turnId: "old" }, "s1", true),
    ev(3, "assistant/message", { text: "old answer" }),
    ev(4, "turn/stopped", { turnId: "old", reason: "completed" }, "s1", true),
    ev(5, "user/message", { text: "latest request" }),
    ev(6, "turn/started", { turnId: "latest" }, "s1", true),
    ev(7, "tool/call", { callId: "c1", tool: "read", input: { path: "secret.ts" } }),
    ev(8, "tool/result", { callId: "c1", tool: "read", output: "tool noise" }),
    ev(9, "assistant/message", { text: "latest answer" }),
    ev(10, "turn/stopped", { turnId: "latest", reason: "completed" }, "s1", true),
  ];
  assert.deepEqual(latestCompletedExchange(events), {
    user: "latest request", assistant: "latest answer", userSeq: 5, assistantSeq: 9,
  });
});

test("latestCompletedExchange ignores incomplete assistant turns and supports legacy finalized logs", () => {
  const incomplete = [
    ev(1, "user/message", { text: "first" }),
    ev(2, "assistant/message", { text: "first answer" }),
    ev(3, "user/message", { text: "new work" }),
    ev(4, "turn/started", { turnId: "current" }, "s1", true),
  ];
  assert.equal(latestCompletedExchange(incomplete), null);

  const legacy = [ev(1, "user/message", { text: "legacy prompt" }), ev(2, "assistant/message", { text: "legacy answer" })];
  assert.deepEqual(latestCompletedExchange(legacy), {
    user: "legacy prompt", assistant: "legacy answer", userSeq: 1, assistantSeq: 2,
  });
});

test("compaction recovery folds active pins and deduplicates from durable user metadata", () => {
  const events: SessionEvent[] = [
    ev(1, "user/message", { text: "preserve this requirement" }),
    ev(2, "assistant/message", { partId: "a1", text: "preserve this finding" }),
    ev(3, "context/pinned", { sourceEventSeq: 1 }, "s1", true),
    ev(4, "context/pinned", { sourceEventSeq: 2 }, "s1", true),
    ev(5, "context/unpinned", { sourceEventSeq: 1 }, "s1", true),
    ev(6, "session/compacted", { backendEventId: "evt_c" }, "s1", true),
  ];
  assert.deepEqual(activePinnedMessages(events), [{
    sourceEventSeq: 2,
    role: "assistant",
    text: "preserve this finding",
  }]);
  assert.equal(unrestoredCompactionSeq(events), 6);
  const recoveryContext = compactionRecoveryText({
    compactionSeq: 6,
    objective: "Finish compaction resilience",
    pinned: activePinnedMessages(events),
  });
  const recovered = [
    ...events,
    ev(7, "user/message", {
      text: "continue",
      recoveryContext,
      compactionRecovery: { compactionSeq: 6, goalRestored: true, pinnedSourceSeqs: [2] },
    }),
  ];
  assert.equal(unrestoredCompactionSeq(recovered), null);
  const last = deriveMessages(recovered).at(-1);
  assert.equal(last?.role, "user");
  assert.match((last?.parts[0] as { text: string }).text, /Finish compaction resilience/);
  assert.match((last?.parts[0] as { text: string }).text, /preserve this finding/);
  assert.match((last?.parts[0] as { text: string }).text, /\n\ncontinue$/);
});

test("deriveMessages soft-rewind, redo, and replacement are replay-deterministic", () => {
  const base: SessionEvent[] = [
    ev(1, "user/message", { text: "first" }),
    ev(2, "assistant/message", { partId: "a1", text: "one" }),
    ev(3, "user/message", { text: "second" }),
    ev(4, "assistant/message", { partId: "a2", text: "two" }),
    ev(5, "session/rewound", { atSeq: 3, restoredText: "second" }),
  ];
  assert.deepEqual(deriveMessages(base), [
    { role: "user", parts: [{ type: "text", text: "first" }] },
    { role: "assistant", parts: [{ type: "text", text: "one" }] },
  ]);
  assert.deepEqual(activeRewind(base), { markerSeq: 5, atSeq: 3, restoredText: "second" });
  assert.deepEqual(rewindDraft(base), { text: "second", attachments: [] });

  const redone = [...base, ev(6, "session/rewind-cleared", { rewindSeq: 5 })];
  assert.deepEqual(deriveMessages(redone).map((message) => message.parts), [
    [{ type: "text", text: "first" }],
    [{ type: "text", text: "one" }],
    [{ type: "text", text: "second" }],
    [{ type: "text", text: "two" }],
  ]);
  assert.equal(activeRewind(redone), null);

  const replaced = [
    ...base,
    ev(6, "session/rewind-cleared", { rewindSeq: 5, replaced: true }),
    ev(7, "user/message", { text: "replacement" }),
  ];
  assert.deepEqual(deriveMessages(replaced).map((message) => message.parts), [
    [{ type: "text", text: "first" }],
    [{ type: "text", text: "one" }],
    [{ type: "text", text: "replacement" }],
  ]);
});

test("fork copied after an active rewind derives the same truncated history", async () => {
  const dir = freshDir();
  const store = createStore(join(dir, "t.db"));
  try {
    await store.append("src", "user/message", { text: "keep" });
    await store.append("src", "assistant/message", { partId: "a", text: "kept" });
    await store.append("src", "user/message", { text: "hide" });
    await store.append("src", "assistant/message", { partId: "b", text: "hidden" });
    const marker = await store.append("src", "session/rewound", { atSeq: 3, restoredText: "hide" });
    await store.copyTo("src", "fork", marker.seq);
    assert.deepEqual(deriveMessages(await store.events("fork")), deriveMessages(await store.events("src")));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projection roundtrip and projections(projectId) filter", async () => {
  const dir = freshDir();
  const store = createStore(join(dir, "t.db"));
  try {
    const proj: SessionProjection = {
      id: "s1",
      projectId: "projA",
      title: "Session One",
      status: "working",
      model: { providerID: "p", modelID: "m" },
      createdAt: 1,
      updatedAt: 2,
    };
    await store.upsertProjection(proj);
    const got = await store.projection("s1");
    assert.deepEqual(got, proj);

    // update
    const updated: SessionProjection = { ...proj, status: "finished", updatedAt: 3 };
    await store.upsertProjection(updated);
    assert.deepEqual(await store.projection("s1"), updated);

    // another project
    await store.upsertProjection({
      id: "s2",
      projectId: "projB",
      title: "Session Two",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });

    const all = await store.projections();
    assert.equal(all.length, 2);
    const projA = await store.projections("projA");
    assert.equal(projA.length, 1);
    assert.equal(projA[0]!.id, "s1");
    assert.equal((await store.projection("missing")), undefined);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopen DB file preserves events", async () => {
  const dir = freshDir();
  const dbPath = join(dir, "t.db");
  const store = createStore(dbPath);
  await store.append("s1", "user/message", { text: "before" });
  await store.append("s1", "assistant/message", { text: "reply" });
  await store.close();

  const store2 = createStore(dbPath);
  try {
    const evts = await store2.events("s1");
    assert.deepEqual(evts.map((e) => e.seq), [1, 2]);
    assert.deepEqual(evts.map((e) => e.data), [{ text: "before" }, { text: "reply" }]);
  } finally {
    await store2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportJsonl returns events as JSONL", async () => {
  const dir = freshDir();
  const store = createStore(join(dir, "t.db"));
  try {
    await store.append("s1", "user/message", { text: "one" });
    await store.append("s1", "assistant/message", { text: "two" });
    const lines = (await store.exportJsonl("s1")).split("\n");
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]!) as { text: string }).text, "one");
    assert.equal((JSON.parse(lines[1]!) as { text: string }).text, "two");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

