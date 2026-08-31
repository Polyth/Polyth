// P0/P1 ingestion performance fixes: batched store writes with ordered,
// deduped per-session logs, and the incremental per-session render-model
// cache staying exactly equivalent to a full buildModel replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, cloneModel, createModelCache, reduceEvent } from "../src/reduce.ts";
import { applyEvent, applyEvents, getState, lastSeq, seedSessionCache, subscribeStore, upsertSession } from "../src/store.ts";
import { titleFromPrompt } from "../src/format.ts";

function mk(sessionId: string, seq: number, type = "user/message", data: JsonObject = {}): SessionEvent {
  return {
    id: `${sessionId}-e${seq}`,
    sessionId,
    seq,
    time: 1_700_000_000_000 + seq,
    type,
    data: type === "user/message" ? { text: `m${seq}`, ...data } : data,
    v: 1,
  };
}

function seqs(sessionId: string): number[] {
  return (getState().events[sessionId] ?? []).map((e) => e.seq);
}

// Deterministic PRNG so the randomized delivery test is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A realistic multi-turn stream exercising every indexed reducer path. */
function sessionStream(sessionId: string, turns: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  let seq = 0;
  const next = (type: string, data: JsonObject): void => {
    seq += 1;
    out.push(mk(sessionId, seq, type, data));
  };
  for (let t = 0; t < turns; t += 1) {
    next("user/message", { text: `prompt ${t}` });
    next("turn/started", { turnId: `t${t}`, model: { providerID: "prov", modelID: "mod" } });
    next("tool/call", { callId: `c${t}`, tool: "read_file", input: { path: `f${t}.ts` } });
    for (let i = 0; i < 4; i += 1) next("assistant/chunk", { partId: `p${t}`, text: `word${i} ` });
    next("assistant/reasoning-chunk", { partId: `p${t}`, text: "thinking" });
    next("tool/result", { callId: `c${t}`, tool: "read_file", output: `content ${t}` });
    next("permission/requested", { requestId: `r${t}`, permission: "bash", patterns: ["*"] });
    next("permission/resolved", { requestId: `r${t}`, reply: "once" });
    next("assistant/message", { partId: `p${t}`, text: `answer ${t}`, tokens: { input: 10, output: 5 }, cost: 0.01 });
    next("usage/recorded", { tokens: { input: 10, output: 5 }, cost: 0.01 });
    next("turn/stopped", { turnId: `t${t}`, reason: "completed" });
  }
  return out;
}

// ---- store batch API ----------------------------------------------------------

test("applyEvents applies a multi-session batch with a single notification", () => {
  let notified = 0;
  const unsub = subscribeStore(() => {
    notified += 1;
  });
  applyEvents([mk("ing-a", 1), mk("ing-b", 1), mk("ing-a", 2), mk("ing-a", 3)]);
  unsub();
  assert.equal(notified, 1);
  assert.deepEqual(seqs("ing-a"), [1, 2, 3]);
  assert.deepEqual(seqs("ing-b"), [1]);
});

test("duplicates inside one batch are dropped", () => {
  applyEvents([mk("ing-dup", 1), mk("ing-dup", 1), mk("ing-dup", 2), mk("ing-dup", 2)]);
  assert.deepEqual(seqs("ing-dup"), [1, 2]);
});

test("out-of-order and replayed events land sorted and deduped", () => {
  applyEvents([mk("ing-c", 1), mk("ing-c", 2), mk("ing-c", 5)]);
  applyEvent(mk("ing-c", 3)); // gap-fill via the single-event path
  applyEvents([mk("ing-c", 4), mk("ing-c", 2), mk("ing-c", 6)]); // replayed 2 dropped
  assert.deepEqual(seqs("ing-c"), [1, 2, 3, 4, 5, 6]);
  assert.equal(lastSeq("ing-c"), 6);
});

test("a batch of already-seen events changes nothing (no render churn)", () => {
  applyEvents([mk("ing-d", 1), mk("ing-d", 2)]);
  const before = getState().events["ing-d"];
  let notified = 0;
  const unsub = subscribeStore(() => {
    notified += 1;
  });
  applyEvents([mk("ing-d", 1), mk("ing-d", 2)]);
  applyEvent(mk("ing-d", 2));
  unsub();
  assert.equal(notified, 0);
  assert.equal(getState().events["ing-d"], before); // same array identity
});

test("random chunked delivery converges to the sorted log and canonical model", () => {
  const canonical = sessionStream("ing-rand", 6);
  const shuffled = canonical.slice();
  const rand = mulberry32(42);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  let at = 0;
  while (at < shuffled.length) {
    const size = 1 + Math.floor(rand() * 7);
    const chunk = shuffled.slice(at, at + size);
    // Re-deliver a previous chunk sometimes, as WS gap-fill can.
    if (at > 0 && rand() < 0.3) chunk.push(shuffled[Math.floor(rand() * at)]!);
    applyEvents(chunk);
    at += size;
  }
  const list = getState().events["ing-rand"]!;
  assert.deepEqual(list.map((e) => e.seq), canonical.map((e) => e.seq));
  assert.deepEqual(buildModel(list), buildModel(canonical));
});

// ---- incremental model cache ---------------------------------------------------

test("incremental cache equals a full buildModel replay at every batch boundary", () => {
  const cache = createModelCache();
  const all = sessionStream("cache-eq", 5);
  let list: SessionEvent[] = [];
  let at = 0;
  const sizes = [1, 3, 2, 7, 1, 11, 4];
  while (at < all.length) {
    const size = sizes[at % sizes.length]!;
    list = [...list, ...all.slice(at, at + size)]; // copy-on-append like the store
    at += size;
    const incremental = cache.get("cache-eq", list);
    assert.deepEqual(incremental, buildModel(list));
  }
  assert.equal(cache.get("cache-eq", list).version, all.length);
});

test("cache returns stable references for unchanged input, fresh ones on append", () => {
  const cache = createModelCache();
  const l1 = [mk("cache-ref", 1)];
  const m1 = cache.get("cache-ref", l1);
  assert.equal(cache.get("cache-ref", l1), m1); // same array in → same model out
  const l2 = [...l1, mk("cache-ref", 2, "assistant/chunk", { partId: "p1", text: "hi" })];
  const m2 = cache.get("cache-ref", l2);
  assert.notEqual(m2, m1); // React deps on [model] must see the change
  assert.notEqual(m2.messages, m1.messages); // …and on [model.messages]
  assert.equal(m2.version, 2);
  assert.equal(m1.version, 1); // the prior snapshot's top level is untouched
});

test("gap-filled (mid-log inserted) events fall back to a correct full rebuild", () => {
  const cache = createModelCache();
  const e1 = mk("cache-gap", 1);
  const e2 = mk("cache-gap", 2);
  const e3 = mk("cache-gap", 3, "assistant/message", { partId: "p1", text: "late" });
  cache.get("cache-gap", [e1, e3]);
  const filled = [e1, e2, e3];
  assert.deepEqual(cache.get("cache-gap", filled), buildModel(filled));
});

test("assistant chunks and tool results split across cache updates merge correctly", () => {
  const cache = createModelCache();
  const first = [
    mk("cache-split", 1, "user/message", { text: "go" }),
    mk("cache-split", 2, "assistant/chunk", { partId: "p1", text: "Hel" }),
    mk("cache-split", 3, "tool/call", { callId: "c1", tool: "bash", input: { cmd: "ls" } }),
  ];
  const m1 = cache.get("cache-split", first);
  assert.equal(m1.messages.length, 3);

  const second = [
    ...first,
    mk("cache-split", 4, "assistant/chunk", { partId: "p1", text: "lo" }),
    mk("cache-split", 5, "tool/result", { callId: "c1", tool: "bash", output: "a.ts" }),
    mk("cache-split", 6, "assistant/message", { partId: "p1", text: "Hello" }),
  ];
  const m2 = cache.get("cache-split", second);
  assert.equal(m2.messages.length, 3); // merged into existing entries, no dupes
  const assistant = m2.messages.find((m) => m.kind === "assistant");
  assert.ok(assistant && assistant.kind === "assistant");
  assert.equal(assistant.text, "Hello");
  assert.equal(assistant.finalized, true);
  assert.equal(assistant.eventSeq, 6, "actions target the canonical assistant/message event, not a chunk");
  const tool = m2.messages.find((m) => m.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  assert.equal(tool.status, "done");
  assert.equal(tool.output, "a.ts");
  assert.deepEqual(m2, buildModel(second));
});

test("cloned models keep folding independently of the source snapshot", () => {
  const base = buildModel([
    mk("clone", 1, "tool/call", { callId: "c1", tool: "bash", input: {} }),
  ]);
  const clone = cloneModel(base);
  reduceEvent(clone, mk("clone", 2, "tool/result", { callId: "c1", tool: "bash", output: "ok" }));
  reduceEvent(clone, mk("clone", 3, "tool/call", { callId: "c2", tool: "grep", input: {} }));
  assert.equal(clone.messages.length, 2);
  assert.equal(clone.version, 3);
  assert.equal(base.messages.length, 1); // top-level arrays are not shared
  assert.equal(base.version, 1);
});

test("duplicate tool callIds keep first-wins routing (index matches the old scan)", () => {
  const events = [
    mk("firstwins", 1, "tool/call", { callId: "c1", tool: "bash", input: { cmd: "a" } }),
    mk("firstwins", 2, "tool/call", { callId: "c1", tool: "bash", input: { cmd: "b" } }),
    mk("firstwins", 3, "tool/result", { callId: "c1", tool: "bash", output: "done" }),
  ];
  const m = buildModel(events);
  const tools = m.messages.filter((x) => x.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.kind === "tool" ? tools[0]!.status : "", "done"); // first gets the result
  assert.equal(tools[1]!.kind === "tool" ? tools[1]!.status : "", "running");
});

// ---- UX: prompt-derived title persisted into the session record -------------

function seedSession(id: string, title = ""): void {
  seedSessionCache({
    id,
    projectId: "proj",
    title,
    status: "idle",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
}

test("first user/message derives and persists the session title immediately", () => {
  seedSession("titled-s");
  applyEvents([mk("titled-s", 1, "user/message", { text: "Add auth middleware to the API" })]);
  const s = getState().sessions.find((x) => x.id === "titled-s");
  assert.ok(s);
  assert.equal(s.title, titleFromPrompt("Add auth middleware to the API"));
});

test("a later non-user event does not re-derive or clobber an existing real title", () => {
  seedSession("kept-s", "Manual title");
  applyEvents([mk("kept-s", 1, "user/message", { text: "ignored prompt" })]);
  const s = getState().sessions.find((x) => x.id === "kept-s");
  assert.equal(s?.title, "Manual title");
});

test("a server placeholder projection does not clobber the client-derived title", () => {
  seedSession("guard-s");
  applyEvents([mk("guard-s", 1, "user/message", { text: "Fix the flaky test" })]);
  // Server projection arrives still titled by a placeholder (OpenCode not done).
  upsertSession({
    id: "guard-s",
    projectId: "proj",
    title: "",
    status: "idle",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  const s = getState().sessions.find((x) => x.id === "guard-s");
  assert.equal(s?.title, titleFromPrompt("Fix the flaky test"));
});
