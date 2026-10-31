// P0/P1 ingestion performance fixes: batched store writes with ordered,
// deduped per-session logs, and the incremental per-session render-model
// cache staying exactly equivalent to a full buildModel replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, cloneModel, createModelCache, reduceEvent } from "../src/reduce.ts";
import { activateSession, applyEvent, applyEvents, beginPendingSend, bindPendingSend, endPendingSend, getState, hasInFlightPrompt, lastSeq, overlaySessionProjection, pendingSendsForSurface, seedSessionCache, subscribeSessionEvents, subscribeStore, upsertSession, upsertSessions } from "../src/store.ts";
import { visibleComposerDraft } from "../src/drafts.ts";
import { titleFromPrompt } from "../src/format.ts";
import { resolveSessionStatus } from "../src/sessionStatus.ts";

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

test("canonical event subscribers run after accepted history is visible", () => {
  const received: string[] = [];
  const unsub = subscribeSessionEvents((event) => {
    received.push(event.type);
    assert.ok((getState().events[event.sessionId] ?? []).some((candidate) => candidate.id === event.id));
  });
  applyEvents([mk("event-sub", 1, "package-tool/requested", { toolId: "browser.polyth-browser" })]);
  unsub();
  assert.deepEqual(received, ["package-tool/requested"]);
});

test("canonical event subscribers ignore replays, isolate failures, and skip hydration", () => {
  const received: number[] = [];
  const throwing = subscribeSessionEvents(() => { throw new Error("observer failure"); });
  const recording = subscribeSessionEvents((event) => { received.push(event.seq); });
  applyEvents([mk("event-live", 1), mk("event-live", 1), mk("event-live", 2)]);
  applyEvents([mk("event-hydrated", 1)], { notifySessionEvents: false });
  throwing();
  recording();
  assert.deepEqual(received, [1, 2]);
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
  assert.equal(s.titleSource, "polyth");
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
  assert.equal(s?.titleSource, "polyth");
});

test("a repeated optimistic seed cannot reverse the derived session title", () => {
  seedSession("seed-guard-s");
  applyEvents([mk("seed-guard-s", 1, "user/message", { text: "Keep one stable title" })]);
  seedSessionCache({
    id: "seed-guard-s",
    projectId: "proj",
    title: "New session",
    status: "working",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  });
  const s = getState().sessions.find((x) => x.id === "seed-guard-s");
  assert.equal(s?.title, titleFromPrompt("Keep one stable title"));
  assert.equal(s?.titleSource, "polyth");
});

test("an older-history backfill containing the first user/message derives the title", () => {
  seedSession("backfill-s");
  // Tail load arrives first and only contains later assistant/tool events.
  applyEvents([
    mk("backfill-s", 2, "turn/started", { turnId: "t1" }),
    mk("backfill-s", 3, "assistant/chunk", { partId: "p1", text: "hello" }),
  ]);
  assert.equal(getState().sessions.find((x) => x.id === "backfill-s")?.title, "");
  // Backfill now brings in the first user message.
  applyEvents([mk("backfill-s", 1, "user/message", { text: "Refactor the auth layer" })]);
  assert.equal(
    getState().sessions.find((x) => x.id === "backfill-s")?.title,
    titleFromPrompt("Refactor the auth layer"),
  );
});

// Optimistic prompt echo (instant send): the composer shows the submitted
// prompt immediately and the canonical event retires it. The echo must retire
// exactly once per canonical admission, never on backfilled older history, and
// never before the prompt it stands in for has actually landed.
test("a pending send retires only when its own canonical admission lands", () => {
  seedSession("echo-s");
  applyEvents([mk("echo-s", 1, "user/message", { text: "older prompt" })]);

  const echo = beginPendingSend({ sessionId: "echo-s", text: "new prompt", attachments: [] });
  assert.equal(getState().pendingSends.length, 1);

  // Non-admission traffic for the same session leaves the echo standing.
  applyEvents([mk("echo-s", 2, "turn/started", { turnId: "t1" })]);
  assert.equal(getState().pendingSends.length, 1);

  // Backfilled older history is not an admission of this prompt.
  applyEvents([mk("echo-s", 0, "user/message", { text: "ancient prompt" })]);
  assert.equal(getState().pendingSends.length, 1);

  // Another session's prompt is not this one either.
  seedSession("other-s");
  applyEvents([mk("other-s", 1, "user/message", { text: "elsewhere" })]);
  assert.equal(getState().pendingSends.length, 1);

  applyEvents([mk("echo-s", 3, "user/message", { text: "new prompt" })]);
  assert.equal(getState().pendingSends.length, 0);
  assert.equal(echo.startsWith("pending-send-"), true);
});

test("two rapid pending sends retire one per canonical admission, oldest first", () => {
  seedSession("fifo-s");
  const first = beginPendingSend({ sessionId: "fifo-s", text: "one", attachments: [] });
  const second = beginPendingSend({ sessionId: "fifo-s", text: "two", attachments: [] });

  applyEvents([mk("fifo-s", 1, "user/message", { text: "one" })]);
  assert.deepEqual(getState().pendingSends.filter((p) => p.sessionId === "fifo-s").map((p) => p.id), [second]);

  // A server-side queue fallback admits the prompt without a user/message.
  applyEvents([mk("fifo-s", 2, "queue/enqueued", { queueId: "q1", text: "two" })]);
  assert.equal(getState().pendingSends.filter((p) => p.sessionId === "fifo-s").length, 0);
  assert.equal(first.length > 0, true);
});

test("an interrupt enqueue keeps the echo until the replacement user message lands", () => {
  seedSession("interrupt-s");
  applyEvents([mk("interrupt-s", 1, "user/message", { text: "older prompt" })]);
  beginPendingSend({
    sessionId: "interrupt-s",
    text: "send now",
    attachments: [],
    model: { providerID: "openai", modelID: "gpt-5" },
  });

  applyEvents([mk("interrupt-s", 2, "queue/enqueued", {
    queueId: "q-interrupt",
    text: "send now",
    delivery: "interrupt",
  })]);
  applyEvents([mk("interrupt-s", 3, "turn/stopped", { turnId: "t1", reason: "aborted" })]);
  assert.equal(getState().pendingSends.filter((p) => p.sessionId === "interrupt-s").length, 1);

  applyEvents([mk("interrupt-s", 4, "user/message", { text: "send now" })]);
  assert.equal(getState().pendingSends.filter((p) => p.sessionId === "interrupt-s").length, 0);
});

test("a steered admission retires the echo on the persisted user message", () => {
  seedSession("steer-s");
  beginPendingSend({ sessionId: "steer-s", text: "go left", attachments: [] });
  applyEvents([mk("steer-s", 1, "user/message", { text: "go left", delivery: "steer" })]);
  assert.equal(getState().pendingSends.filter((p) => p.sessionId === "steer-s").length, 0);

  beginPendingSend({ sessionId: "steer-s", text: "later", attachments: [] });
  applyEvents([mk("steer-s", 2, "delivery/steered", { text: "go left" })]);
  assert.deepEqual(
    getState().pendingSends.filter((p) => p.sessionId === "steer-s").map((p) => p.text),
    ["later"],
  );
});

test("pending send overlays working status and the selected model", () => {
  seedSession("overlay-s");
  const session = getState().sessions.find((item) => item.id === "overlay-s")!;
  assert.equal(overlaySessionProjection(session, [])?.status, "idle");
  const overlaid = overlaySessionProjection(session, [{
    id: "pending-send-overlay",
    sessionId: "overlay-s",
    text: "next",
    attachments: [],
    afterSeq: 0,
    model: { providerID: "anthropic", modelID: "opus" },
  }]);
  assert.equal(overlaid?.status, "working");
  assert.deepEqual(overlaid?.model, { providerID: "anthropic", modelID: "opus" });
  assert.equal(overlaySessionProjection({ ...session, status: "archived" }, [{
    id: "pending-send-overlay",
    sessionId: "overlay-s",
    text: "next",
    attachments: [],
    afterSeq: 0,
  }])?.status, "archived");
});

test("a rejected send drops its echo without waiting for an event", () => {
  seedSession("reject-s");
  const echo = beginPendingSend({ sessionId: "reject-s", text: "nope", attachments: [] });
  endPendingSend(echo);
  assert.equal(getState().pendingSends.some((p) => p.id === echo), false);
});

test("first-send creation binds its echo to the new session's real tail", () => {
  seedSession("bound-s");
  applyEvents([mk("bound-s", 7, "user/message", { text: "pre-existing" })]);
  const echo = beginPendingSend({ sessionId: null, text: "first prompt", attachments: [] });
  bindPendingSend(echo, "bound-s");
  // Binding re-anchors to seq 7: the already-stored message must not retire it.
  applyEvents([mk("bound-s", 7, "user/message", { text: "pre-existing" })]);
  assert.equal(getState().pendingSends.some((p) => p.id === echo), true);
  applyEvents([mk("bound-s", 8, "user/message", { text: "first prompt" })]);
  assert.equal(getState().pendingSends.some((p) => p.id === echo), false);
});

test("an unbound first-send echo belongs to the spawning surface and holds the composer empty", () => {
  const echo = {
    id: "pending-send-hold",
    sessionId: null,
    text: "Diagnose the git problem",
    attachments: [],
    afterSeq: 0,
  };
  const spawning = {
    pendingSends: [echo],
    sessionSpawn: { requestId: 1, projectId: "p1", sessionId: null as string | null },
    activeProjectId: "p1",
  };
  assert.equal(hasInFlightPrompt(spawning, null), true);
  assert.equal(
    visibleComposerDraft(echo.text, hasInFlightPrompt(spawning, null)),
    "",
    "the staged recovery copy must not reappear in the remounted composer",
  );
  // Switching to any other chat while creation runs must not show its prompt.
  assert.equal(hasInFlightPrompt(spawning, "other-s"), false);
  assert.deepEqual(pendingSendsForSurface(spawning, "other-s"), []);
  assert.equal(visibleComposerDraft("other draft", hasInFlightPrompt(spawning, "other-s")), "other draft");

  // The spawn is bound before the new chat is focused; from then on the
  // created session owns the echo even before the echo itself is bound.
  const spawnBound = { ...spawning, sessionSpawn: { ...spawning.sessionSpawn, sessionId: "created-s" } };
  assert.equal(hasInFlightPrompt(spawnBound, "created-s"), true);
  assert.equal(hasInFlightPrompt(spawnBound, "other-s"), false);

  const bound = {
    ...spawning,
    pendingSends: [{ ...echo, sessionId: "created-s" }],
    sessionSpawn: { ...spawning.sessionSpawn, sessionId: "created-s" },
  };
  assert.equal(hasInFlightPrompt(bound, "created-s"), true);
  assert.equal(hasInFlightPrompt(bound, "other-s"), false);
  assert.equal(visibleComposerDraft("unrelated draft", false), "unrelated draft");
  assert.equal(pendingSendsForSurface(bound, "created-s")[0]?.id, echo.id);
});

test("applyEvents updates the open session's attention and waiting status on permission and question events", (t) => {
  const sessionId = "session-attention-test";
  // Live events stream only for the open session, so only its window is current.
  activateSession(sessionId);
  t.after(() => activateSession(null));
  upsertSession({
    id: sessionId,
    projectId: "proj-1",
    title: "Attention Test",
    status: "working",
    createdAt: 1000,
    updatedAt: 1000,
  });

  // Permission requested: session gains pending permission and status waiting
  applyEvents([
    mk(sessionId, 1, "permission/requested", {
      requestId: "perm-1",
      permission: "Bash",
      patterns: ["ls"],
    }),
  ]);

  let current = getState().sessions.find((s) => s.id === sessionId);
  assert.equal(current?.status, "waiting");
  assert.deepEqual(current?.attention, { questions: 0, permissions: 1, unread: 0 });

  // Question asked: session gains pending question
  applyEvents([
    mk(sessionId, 2, "question/asked", {
      requestId: "q-1",
      questions: [{ text: "Proceed?" }],
    }),
  ]);

  current = getState().sessions.find((s) => s.id === sessionId);
  assert.equal(current?.status, "waiting");
  assert.deepEqual(current?.attention, { questions: 1, permissions: 1, unread: 0 });

  // Permission resolved: permission count drops to 0
  applyEvents([
    mk(sessionId, 3, "permission/resolved", {
      requestId: "perm-1",
      reply: "once",
    }),
  ]);

  current = getState().sessions.find((s) => s.id === sessionId);
  assert.deepEqual(current?.attention, { questions: 1, permissions: 0, unread: 0 });

  // Question answered: question count drops to 0
  applyEvents([
    mk(sessionId, 4, "question/answered", {
      requestId: "q-1",
    }),
  ]);

  current = getState().sessions.find((s) => s.id === sessionId);
  assert.deepEqual(current?.attention, { questions: 0, permissions: 0, unread: 0 });
});

test("upsertSession preserves known attention and autoAccept when incoming projection omits them", () => {
  const sessionId = "session-preserve-attention";
  upsertSession({
    id: sessionId,
    projectId: "proj-1",
    title: "Preserve Attention",
    status: "waiting",
    attention: { questions: 0, permissions: 2, unread: 1 },
    autoAccept: true,
    autoAcceptAll: true,
    createdAt: 1000,
    updatedAt: 1000,
  });

  // Incoming projection without attention or autoAccept
  upsertSession({
    id: sessionId,
    projectId: "proj-1",
    title: "Preserve Attention Updated",
    status: "waiting",
    createdAt: 1000,
    updatedAt: 2000,
  });

  const updated = getState().sessions.find((s) => s.id === sessionId);
  assert.equal(updated?.title, "Preserve Attention Updated");
  assert.deepEqual(updated?.attention, { questions: 0, permissions: 2, unread: 1 });
  assert.equal(updated?.autoAccept, true);
  assert.equal(updated?.autoAcceptAll, true);
});

test("requests held for a person count toward attention while Auto-Approve is on", (t) => {
  const sessionId = "session-held-attention";
  activateSession(sessionId);
  t.after(() => activateSession(null));
  upsertSession({
    id: sessionId,
    projectId: "proj-1",
    title: "Held",
    status: "working",
    autoAccept: true,
    createdAt: 1000,
    updatedAt: 1000,
  });
  applyEvents([
    mk(sessionId, 1, "permission/requested", {
      requestId: "routine",
      permission: "bash",
      patterns: ["npm test"],
      preview: { title: "bash", lines: ["npm test"], risk: "medium" },
    }),
    mk(sessionId, 2, "permission/requested", {
      requestId: "held",
      permission: "bash",
      patterns: ["rm -rf ~/Documents"],
      preview: { title: "bash", lines: ["rm -rf ~/Documents"], risk: "high", reasons: ["destructive-delete"] },
    }),
    { ...mk(sessionId, 3, "permission/requested", { requestId: "shell", permission: "shell", patterns: ["ls"] }), producerPlugin: "composer-shell" },
  ]);
  // The routine request is about to be answered; the other two need a person.
  const current = getState().sessions.find((s) => s.id === sessionId);
  assert.equal(current?.attention?.permissions, 2);

  // Full access answers the held request too; the shell confirmation stays.
  const overlaid = overlaySessionProjection({ ...current!, autoAcceptAll: true }, []);
  assert.equal(overlaid?.attention?.permissions, 1);
});

test("choosing Auto-Approve on a card reads as working, not as a reply needed, until the server answers", (t) => {
  const sessionId = "session-policy-answering";
  activateSession(sessionId);
  t.after(() => activateSession(null));
  const base = { id: sessionId, projectId: "proj-1", title: "Policy", createdAt: 1000, updatedAt: 1000 };
  upsertSession({ ...base, status: "working" });
  applyEvents([
    mk(sessionId, 1, "turn/started", { turnId: "t1" }),
    mk(sessionId, 2, "permission/requested", {
      requestId: "routine",
      permission: "bash",
      patterns: ["npm test"],
      preview: { title: "bash", lines: ["npm test"], risk: "medium" },
    }),
  ]);
  let row = overlaySessionProjection(getState().sessions.find((s) => s.id === sessionId), []);
  assert.equal(resolveSessionStatus(row!).kind, "needs-approval");

  // The policy lands first; the server still says `waiting` until it answers.
  upsertSession({ ...base, status: "waiting", autoAccept: true, autoAcceptAll: false, updatedAt: 2000,
    attention: { questions: 0, permissions: 1, unread: 0 } });
  row = overlaySessionProjection(getState().sessions.find((s) => s.id === sessionId), []);
  assert.equal(resolveSessionStatus(row!).kind, "working");

  // A request the policy holds for a person keeps the shield.
  applyEvents([mk(sessionId, 3, "permission/requested", {
    requestId: "held",
    permission: "bash",
    patterns: ["rm -rf ~/Documents"],
    preview: { title: "bash", lines: ["rm -rf ~/Documents"], risk: "high" },
  })]);
  row = overlaySessionProjection(getState().sessions.find((s) => s.id === sessionId), []);
  assert.equal(resolveSessionStatus(row!).kind, "needs-approval");
});

test("overlaySessionProjection overlays attention from cached events when present", () => {
  const sessionId = "session-overlay-attention";
  applyEvents([
    mk(sessionId, 1, "permission/requested", {
      requestId: "req-overlay-1",
      permission: "Bash",
      patterns: ["git diff"],
    }),
  ]);

  const rawSession = {
    id: sessionId,
    projectId: "proj-1",
    title: "Overlay Test",
    status: "waiting" as const,
    createdAt: 1000,
    updatedAt: 1000,
  };

  const overlaid = overlaySessionProjection(rawSession, []);
  assert.deepEqual(overlaid?.attention, { questions: 0, permissions: 1, unread: 0 });
});

test("a background session's approval keeps its shield over the window cached on an earlier visit", (t) => {
  const sessionId = "session-stale-window";
  const base = { id: sessionId, projectId: "proj-1", title: "Earlier visit", createdAt: 1000, updatedAt: 1000 };
  t.after(() => activateSession(null));
  activateSession(sessionId);
  upsertSession({ ...base, status: "idle", attention: { questions: 0, permissions: 0, unread: 0 } });
  applyEvents([
    mk(sessionId, 1, "user/message"),
    mk(sessionId, 2, "assistant/message", { partId: "a1", text: "done" }),
  ]);
  // Another chat takes the subscription; this window stops receiving events.
  activateSession("session-stale-window-other");

  // The agent then asks for approval. Only its projection reaches the client,
  // carrying the server's counts from durable open requests.
  upsertSessions([{
    ...base,
    status: "waiting",
    updatedAt: 2000,
    summary: true,
    attention: { questions: 0, permissions: 1, unread: 0 },
  }]);

  const row = overlaySessionProjection(getState().sessions.find((s) => s.id === sessionId), []);
  assert.deepEqual(row?.attention, { questions: 0, permissions: 1, unread: 0 });
  assert.equal(resolveSessionStatus(row!).kind, "needs-approval");
});

test("a bounded background tail newer than the open request keeps the server's approval count", () => {
  const sessionId = "session-bounded-tail";
  upsertSession({
    id: sessionId,
    projectId: "proj-1",
    title: "Never opened",
    status: "waiting",
    attention: { questions: 0, permissions: 1, unread: 0 },
    createdAt: 1000,
    updatedAt: 1000,
  });
  // A hover warm reads the newest 40 events; the request at seq 10 is older.
  applyEvents(Array.from({ length: 40 }, (_, i) =>
    mk(sessionId, 11 + i, "assistant/chunk", { partId: "p1", text: "word " })));

  const stored = getState().sessions.find((s) => s.id === sessionId);
  assert.deepEqual(stored?.attention, { questions: 0, permissions: 1, unread: 0 });
  assert.equal(stored?.status, "waiting");
  assert.equal(resolveSessionStatus(overlaySessionProjection(stored, [])!).kind, "needs-approval");
});


test("moving a chat into isolation is a started notice naming its branch and what stayed behind", () => {
  const model = buildModel([
    mk("iso-start", 1, "isolation/started", { targetBranch: "main", originUncommitted: 3 }),
    mk("iso-start", 2, "isolation/started", { targetBranch: "dev", originUncommitted: -1 }),
  ]);
  const notices = model.messages.filter((message) => message.kind === "notice");
  assert.deepEqual(notices.map((notice) => notice.kind === "notice" && [notice.topic, notice.branch, notice.uncommitted]), [
    ["isolation-started", "main", 3],
    ["isolation-started", "dev", undefined],
  ]);
});

test("an isolation return is a returned notice, not a discard", () => {
  const model = buildModel([
    mk("iso", 1, "isolation/discarded", { targetBranch: "main" }),
    mk("iso", 2, "isolation/discarded", { targetBranch: "main", returned: true }),
  ]);
  const notices = model.messages.filter((message) => message.kind === "notice");
  assert.deepEqual(notices.map((notice) => notice.kind === "notice" && notice.returned === true), [false, true]);
});
