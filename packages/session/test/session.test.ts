import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, deriveMessages } from "@polyth/session";
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
